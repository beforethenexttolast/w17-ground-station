// Electron boot smoke, controller side (audit D3). Plain Node — launches the
// REAL application (via scripts/smokeMain.js) as a child Electron process with
// a controlled environment and decides pass/fail from its structured stdout
// tokens, never from "the process spawned". Run it with:
//
//   npm run smoke:electron                 # the full scenario suite
//   npm run smoke:electron -- --scenario normal
//   npm run smoke:electron -- --list
//
// Environment knobs (controller-only):
//   W17_SMOKE_TIMEOUT_MS  per-scenario hard deadline override (default 90000)
//   W17_SMOKE_LOG_DIR     also write the sanitized per-scenario logs here (CI)
//   W17_SMOKE_KEEP_TMP=1  keep the temp profiles for debugging (skips cleanup)
//
// Every scenario gets a throwaway temp root (userData + an EMPTY mediamtx dir,
// so the missing-binary soft-fail is deterministic), a scrubbed environment
// (all W17_* deleted, then only the smoke's own vars set — no hardware, no
// real Wi-Fi/hotspot/ELRS/serial paths reachable), a hard timeout that kills
// the WHOLE process tree, sanitized log capture, and cleanup verification.
// The suite exits non-zero if any scenario deviates from its contract —
// including the negative scenarios, where the CHILD is expected to fail.

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createLineParser,
  evaluateSmokeRun,
  secretValuesFromEnv,
  sanitizeLog,
} = require('./smokeShared.js');
const { winTreeKillArgs } = require('../main/runCommand.js');

// Everything W17_* is scrubbed wholesale (the host shell may export bridge /
// head-tracking / telemetry vars that would change the boot), plus the two
// Electron leaks and NODE_OPTIONS (an inherited --inspect would wedge the
// child). The smoke then sets ONLY its own deterministic variables.
const SCRUB_ENV_EXACT = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'NODE_OPTIONS'];

function buildScenarioEnv({ base = process.env, userData, mediamtxDir, extra = {} }) {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (key.startsWith('W17_')) delete env[key];
  }
  for (const key of SCRUB_ENV_EXACT) delete env[key];
  env.W17_WIFI_SIM = 'two-adapters'; // canned netsh/powershell — never the real OS layer
  env.W17_MEDIAMTX_DIR = mediamtxDir; // empty dir => deterministic missing-binary soft-fail
  env.W17_SMOKE_USERDATA = userData;
  return { ...env, ...extra };
}

// Kill the child AND everything it spawned (Electron is a multi-process
// tree). win32: taskkill /pid <pid> /t /f (the same argv the runCommand
// timeout path uses — N4). POSIX: the child is spawned detached, so it leads
// its own process group and a negative-pid SIGKILL reaps the whole group.
function killTree(child, platform = process.platform) {
  if (!child.pid) return;
  if (platform === 'win32') {
    const tk = spawn('taskkill', winTreeKillArgs(child.pid), { windowsHide: true, stdio: 'ignore' });
    tk.on('error', () => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitPidDead(pid, timeoutMs = 5000) {
  if (!pid) return true;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true; // ESRCH — gone
    }
    if (Date.now() > deadline) return false;
    await sleep(100);
  }
}

// Windows can hold userData file locks for a beat after the tree dies.
async function removeDirWithRetry(dir, attempts = 10) {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* retry below */ }
    if (!fs.existsSync(dir)) return true;
    await sleep(500);
  }
  return !fs.existsSync(dir);
}

const LOG_CAP = 512 * 1024;

// Spawn one child and observe it to completion: parse smoke tokens, keep the
// raw log (capped), enforce the hard deadline with a tree kill, and — once a
// result token arrives — require the child to exit on its own within graceMs.
function runChild({ command, args = [], env = process.env, timeoutMs = 90000, graceMs = 15000 }) {
  return new Promise((resolve) => {
    const parser = createLineParser();
    const events = [];
    const protocolErrors = [];
    let log = '';
    let truncated = false;
    const started = Date.now();
    let timedOut = false;
    let killed = false;
    let resultSeen = false;
    let graceTimer = null;
    let settled = false;

    const child = spawn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    const appendLog = (text) => {
      log += text;
      if (log.length > LOG_CAP) {
        log = log.slice(-Math.floor(LOG_CAP / 2));
        truncated = true;
      }
    };
    const ingest = (evs) => {
      for (const ev of evs) {
        if (ev.protocolError) {
          protocolErrors.push(ev.protocolError);
          continue;
        }
        ev.atMs = Date.now() - started;
        events.push(ev);
        if (ev.event === 'result' && !resultSeen) {
          resultSeen = true;
          graceTimer = setTimeout(() => {
            killed = true;
            killTree(child);
          }, graceMs);
        }
      }
    };

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      appendLog(text);
      ingest(parser.feed(text));
    });
    child.stderr.on('data', (chunk) => appendLog(chunk.toString()));

    const hardTimer = setTimeout(() => {
      timedOut = true;
      killed = true;
      killTree(child);
    }, timeoutMs);

    const finish = async (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (graceTimer) clearTimeout(graceTimer);
      ingest(parser.flush());
      const pidDead = await waitPidDead(child.pid);
      resolve({
        events,
        protocolErrors,
        log: truncated ? `[log truncated to the last ${Math.floor(LOG_CAP / 2 / 1024)}KB]\n${log}` : log,
        timedOut,
        killed,
        resultSeen,
        pid: child.pid ?? null,
        pidDead,
        durationMs: Date.now() - started,
        ...extra,
      });
    };

    child.on('error', (err) => finish({ exitCode: null, spawnError: err.message }));
    // 'close' (not 'exit') so the stdio streams have flushed everything.
    child.on('close', (code, signal) => finish({ exitCode: code, signal }));
  });
}

// ---------- scenarios ----------
// Each scenario is one full child run with a contract. The suite passes only
// when every scenario meets ITS contract — for the negative scenarios that
// means the child failed / hung exactly as specified.
const SCENARIOS = {
  normal: {
    description: 'clean boot: fresh profile, Wi-Fi sim, mediamtx absent (soft-fail), full readiness, clean exit',
    expect: {
      childOk: true,
      // The missing optional media service must be a VISIBLE soft-fail: the
      // supervisor logs it and boot still reaches readiness.
      logMustMatch: [/\[mediamtx\] binary not found/],
    },
  },
  'corrupt-settings': {
    description: 'malformed settings.json: the store falls back to defaults, logs it, and boot still reaches readiness',
    seedSettings: '{ this is not JSON !!!',
    expect: {
      childOk: true,
      logMustMatch: [/\[settings\] unreadable .*settings\.json/],
    },
  },
  'forced-failure': {
    description: 'smoke-only fault injected at the ipc-roundtrip stage: the run must fail loudly, naming the stage, non-zero',
    env: { W17_SMOKE_FAIL_STAGE: 'ipc-roundtrip' },
    expect: { childOk: false, failedStage: 'ipc-roundtrip' },
  },
  timeout: {
    description: 'a wedged boot (smoke-only hang after window load): the hard deadline kills the tree, temp profile removed',
    env: { W17_SMOKE_HANG: '1' },
    timeoutMs: 25000,
    expect: {
      timedOut: true,
      stagesAtLeast: ['electron-ready', 'window-created', 'window-loaded'],
    },
  },
};

async function runScenario(name, spec, { electronPath } = {}) {
  const command = electronPath || require('electron'); // from plain Node this is the binary path
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `w17-smoke-${name}-`));
  const userData = path.join(tempRoot, 'user-data');
  const mediamtxDir = path.join(tempRoot, 'mediamtx-empty');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(mediamtxDir, { recursive: true });
  if (spec.seedSettings != null) {
    fs.writeFileSync(path.join(userData, 'settings.json'), spec.seedSettings, 'utf8');
  }

  const env = buildScenarioEnv({ userData, mediamtxDir, extra: spec.env });
  const timeoutMs = spec.timeoutMs || Number(process.env.W17_SMOKE_TIMEOUT_MS) || 90000;

  let run;
  let tempCleaned = false;
  try {
    run = await runChild({
      command,
      args: [path.join(__dirname, 'smokeMain.js')],
      env,
      timeoutMs,
    });
  } finally {
    if (process.env.W17_SMOKE_KEEP_TMP === '1') {
      tempCleaned = false;
    } else {
      tempCleaned = await removeDirWithRetry(tempRoot);
    }
  }

  const verdict = evaluateSmokeRun(run, spec.expect);
  const failures = [...verdict.failures];
  if (!tempCleaned && process.env.W17_SMOKE_KEEP_TMP !== '1') failures.push(`temp profile not removed: ${tempRoot}`);
  if (!run.pidDead) failures.push(`child pid ${run.pid} still alive after the run`);

  const secrets = secretValuesFromEnv(process.env);
  const sanitizedLog = sanitizeLog(run.log, secrets);
  const stageAt = (stage) => {
    const ev = run.events.find((e) => e.event === 'stage' && e.stage === stage);
    return ev ? ev.atMs : null;
  };

  return {
    name,
    description: spec.description,
    pass: failures.length === 0,
    failures,
    result: verdict.result,
    startupMs: stageAt('electron-ready'),
    readyMs: stageAt('renderer-ready'),
    durationMs: run.durationMs,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    killed: run.killed,
    pid: run.pid,
    pidDead: run.pidDead,
    tempRoot,
    tempCleaned,
    sanitizedLog,
  };
}

function logTail(text, lines = 60) {
  const all = text.split('\n');
  return all.slice(-lines).join('\n');
}

function printReport(report) {
  const flag = report.pass ? 'PASS' : 'FAIL';
  console.log(`\n[smoke] ${flag}  ${report.name} — ${report.description}`);
  console.log(`[smoke]   startup ${report.startupMs ?? '--'}ms · ready ${report.readyMs ?? '--'}ms · total ${report.durationMs}ms · exit ${report.exitCode === null ? 'null (killed)' : report.exitCode}${report.timedOut ? ' · TIMED OUT' : ''}`);
  console.log(`[smoke]   readiness token: ${report.result ? JSON.stringify(report.result).slice(0, 400) : '(none)'}`);
  console.log(`[smoke]   cleanup: temp ${report.tempCleaned ? 'removed' : `KEPT at ${report.tempRoot}`} · child pid ${report.pid ?? '--'} ${report.pidDead ? 'gone' : 'STILL ALIVE'}`);
  for (const f of report.failures) console.log(`[smoke]   FAILURE: ${f}`);
  if (!report.pass) {
    console.log(`[smoke]   --- sanitized log tail (${report.name}) ---`);
    console.log(logTail(report.sanitizedLog));
    console.log('[smoke]   --- end log tail ---');
  }
}

function writeLogFile(report) {
  const dir = process.env.W17_SMOKE_LOG_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${report.name}.log`), report.sanitizedLog, 'utf8');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--list')) {
    for (const [name, spec] of Object.entries(SCENARIOS)) console.log(`${name}: ${spec.description}`);
    return 0;
  }
  const pickIdx = argv.indexOf('--scenario');
  const picked = pickIdx !== -1 ? argv[pickIdx + 1] : null;
  if (picked && !SCENARIOS[picked]) {
    console.error(`[smoke] unknown scenario "${picked}" (known: ${Object.keys(SCENARIOS).join(', ')})`);
    return 2;
  }
  const names = picked ? [picked] : Object.keys(SCENARIOS);
  console.log(`[smoke] Electron boot smoke — scenarios: ${names.join(', ')}`);

  let allPass = true;
  for (const name of names) {
    const report = await runScenario(name, SCENARIOS[name]);
    printReport(report);
    writeLogFile(report);
    if (!report.pass) allPass = false;
  }
  console.log(`\n[smoke] suite ${allPass ? 'PASS' : 'FAIL'} (${names.length} scenario${names.length === 1 ? '' : 's'})`);
  return allPass ? 0 : 1;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`[smoke] controller error: ${err && err.stack ? err.stack : err}`);
      process.exit(1);
    },
  );
}

module.exports = {
  SCENARIOS,
  SCRUB_ENV_EXACT,
  buildScenarioEnv,
  killTree,
  waitPidDead,
  removeDirWithRetry,
  runChild,
  runScenario,
};
