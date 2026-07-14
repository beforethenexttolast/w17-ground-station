// Shared protocol between the Electron boot smoke's two halves (audit D3):
// scripts/smokeMain.js (runs INSIDE Electron, boots the real main/main.js and
// emits structured stage/result tokens on stdout) and
// scripts/electron-smoke.js (the plain-Node controller that spawns it, parses
// the tokens, and decides pass/fail). Everything here is pure — no Electron,
// no child processes, no filesystem — so test/electronSmoke.test.js can pin
// the protocol without booting anything.
//
// This module carries NO production behavior: nothing under main/, shared/,
// or renderer/ imports it (the smoke is a separate entry point, and the
// production tree never reads any W17_SMOKE_* variable — pinned by tests).

'use strict';

// Structured smoke events ride stdout as single lines:
//   W17_SMOKE {"event":"stage","stage":"window-created", ...}
// Anything not carrying the prefix is ordinary application log output.
const EVENT_PREFIX = 'W17_SMOKE ';

// The stages smokeMain proves, in boot order. The controller requires every
// one of them (plus a single ok result) for a passing run, so a truncated or
// wedged child can never pass on a lucky exit code.
const REQUIRED_STAGES = Object.freeze([
  'electron-ready',   // app.whenReady() resolved
  'window-created',   // exactly one BrowserWindow exists
  'window-loaded',    // renderer/index.html finished loading
  'preload-api',      // window.groundStation is exactly the pinned surface; no Node leaks
  'security',         // runtime webPreferences + CSP + window.open/navigation denial
  'ipc-roundtrip',    // real getConfig()/getSettings() answers with fresh-profile values
  'renderer-ready',   // GARAGE step visible, boot-error panel hidden
  'console-clean',    // no uncaught exception / renderer crash / unexpected console error
]);

// The exact preload surface (main/preload.cjs exposeInMainWorld keys), sorted.
// test/electronSmoke.test.js pins this list against the parsed preload source,
// and test/ipcSurface.test.js pins the same 20-method contract independently —
// the smoke asserts the LIVE page sees exactly this and nothing else.
const EXPECTED_API = Object.freeze([
  'applySession', 'elrsLaunch', 'elrsStatus', 'getAddrHint', 'getConfig',
  'getSettings', 'hotspotProbe', 'hotspotStart', 'hotspotState', 'hotspotStop',
  'onHotspotState', 'onTelemetry', 'probeHost', 'sendCommandMirror', 'setSettings',
  'wifiCapabilities', 'wifiInterfaces', 'wifiJoin', 'wifiScan', 'wifiStatus',
]);

// The smoke deliberately runs WITHOUT mediamtx (W17_MEDIAMTX_DIR points at an
// empty directory), so the renderer's WHEP fetch to the loopback endpoint
// fails by design and Chromium logs that network failure at error level.
// ONLY entries naming the loopback WHEP origin are tolerated; any other
// error-level renderer console message fails the console-clean stage.
const CONSOLE_ERROR_ALLOWLIST = Object.freeze([
  /(127\.0\.0\.1|localhost):8889/,
]);

function isAllowedConsoleError(entry) {
  return CONSOLE_ERROR_ALLOWLIST.some((re) => re.test(entry));
}

function formatEvent(obj) {
  return `${EVENT_PREFIX}${JSON.stringify(obj)}\n`;
}

// Incremental stdout parser: chunk boundaries never align with lines, so the
// parser buffers a partial trailing line across feed() calls. A line carrying
// the prefix but unparseable JSON is a PROTOCOL error (a corrupted child must
// fail loudly, not silently drop its readiness token); non-prefixed lines are
// application log noise and ignored here (the controller keeps the raw log).
//
// The pending partial line is BOUNDED: a child emitting an endless line can
// not grow the buffer without limit. An oversized pending line is discarded —
// as a protocol error when it claimed to be a smoke token, silently when it
// is ordinary log noise (the controller's capped raw log still carries it).
const MAX_PENDING_LINE = 256 * 1024;

function createLineParser() {
  let buffer = '';
  const parseLine = (line) => {
    if (!line.startsWith(EVENT_PREFIX)) return null;
    const payload = line.slice(EVENT_PREFIX.length);
    try {
      const ev = JSON.parse(payload);
      if (!ev || typeof ev !== 'object' || typeof ev.event !== 'string') {
        return { protocolError: `smoke token without an event field: ${payload.slice(0, 200)}` };
      }
      return ev;
    } catch {
      return { protocolError: `malformed smoke token: ${payload.slice(0, 200)}` };
    }
  };
  return {
    feed(chunk) {
      buffer += chunk;
      const out = [];
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        const ev = parseLine(line);
        if (ev) out.push(ev);
      }
      if (buffer.length > MAX_PENDING_LINE) {
        if (buffer.startsWith(EVENT_PREFIX)) {
          out.push({ protocolError: `oversized smoke token discarded (> ${MAX_PENDING_LINE} bytes without a newline)` });
        }
        buffer = '';
      }
      return out;
    },
    // A final partial line (child killed mid-write) still counts.
    flush() {
      const line = buffer.replace(/\r$/, '');
      buffer = '';
      const ev = line ? parseLine(line) : null;
      return ev ? [ev] : [];
    },
  };
}

// Values of environment variables whose NAMES look credential-bearing, for
// log redaction. The smoke's own environment carries no secrets (fresh
// profile, scrubbed W17_* vars), but the HOST shell may (CI tokens, signing
// passwords) and a captured Electron log must never republish one.
const SECRET_ENV_NAME_RE = /(PASS(WORD)?|SECRET|TOKEN|CREDENTIAL|PWD|_KEY$|^CSC_)/i;
// The shell's own working-directory variables match the PWD pattern but are
// paths, never credentials — redacting them would gut the log's usefulness.
const SECRET_ENV_NAME_EXEMPT = new Set(['PWD', 'OLDPWD']);

function secretValuesFromEnv(env = {}) {
  const out = [];
  for (const [name, value] of Object.entries(env)) {
    if (SECRET_ENV_NAME_EXEMPT.has(name)) continue;
    if (!SECRET_ENV_NAME_RE.test(name)) continue;
    if (typeof value === 'string' && value.length >= 4) out.push(value);
  }
  // Longest first so a secret that contains another secret redacts cleanly.
  return out.sort((a, b) => b.length - a.length);
}

function sanitizeLog(text, secrets = []) {
  let out = text;
  for (const secret of secrets) {
    out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

// Verdict over one child run. `run` is what the controller observed:
//   { events, protocolErrors, exitCode, timedOut, killed, spawnError, log }
// `expect` is the scenario's contract:
//   { childOk: true }                     — full readiness + clean exit 0
//   { childOk: false, failedStage }       — the child must fail loudly (non-zero,
//                                           result.ok=false naming the stage)
//   { timedOut: true, stagesAtLeast }     — the child must hang until the
//                                           controller's hard deadline kills it
//   { logMustMatch: [regex] }             — required application-log evidence
function evaluateSmokeRun(run, expect = {}) {
  const failures = [];
  const results = run.events.filter((e) => e.event === 'result');
  const stages = new Set(run.events.filter((e) => e.event === 'stage' && e.stage).map((e) => e.stage));
  const result = results[0] || null;

  if (run.spawnError) failures.push(`could not launch the child process: ${run.spawnError}`);
  for (const err of run.protocolErrors) failures.push(`protocol error: ${err}`);
  if (results.length > 1) failures.push(`duplicate readiness token (${results.length} result events)`);

  if (expect.timedOut) {
    if (!run.timedOut) failures.push('expected the run to hang until the hard timeout, but it ended on its own');
    if (result) failures.push('expected no readiness result from a wedged child');
  } else if (expect.childOk === false) {
    if (run.timedOut) failures.push('expected the child to fail fast, but it hung until the hard timeout');
    if (!result) {
      failures.push('expected a failure result token, got none');
    } else {
      if (result.ok !== false) failures.push('expected result.ok=false from the injected fault');
      if (expect.failedStage && result.failedStage !== expect.failedStage) {
        failures.push(`expected failedStage ${expect.failedStage}, got ${result.failedStage || '(none)'}`);
      }
    }
    if (run.exitCode === 0) failures.push('expected a non-zero exit code from a failed smoke');
  } else {
    if (run.timedOut) failures.push('hard timeout hit before readiness');
    if (!result) {
      failures.push('no readiness result token');
    } else if (result.ok !== true) {
      failures.push(`readiness failed at stage ${result.failedStage || '(unknown)'}: ${(result.failures || []).join('; ') || '(no detail)'}`);
    }
    for (const stage of REQUIRED_STAGES) {
      if (!stages.has(stage)) failures.push(`missing stage token: ${stage}`);
    }
    if (run.exitCode !== 0) failures.push(`exit code ${run.exitCode === null ? 'null (killed)' : run.exitCode}, expected 0`);
  }

  for (const stage of expect.stagesAtLeast || []) {
    if (!stages.has(stage)) failures.push(`expected the child to reach stage ${stage} before wedging`);
  }
  for (const re of expect.logMustMatch || []) {
    if (!re.test(run.log)) failures.push(`application log did not match ${re}`);
  }

  return { ok: failures.length === 0, failures, result, stages: [...stages] };
}

module.exports = {
  EVENT_PREFIX,
  REQUIRED_STAGES,
  EXPECTED_API,
  CONSOLE_ERROR_ALLOWLIST,
  isAllowedConsoleError,
  formatEvent,
  createLineParser,
  secretValuesFromEnv,
  sanitizeLog,
  evaluateSmokeRun,
};
