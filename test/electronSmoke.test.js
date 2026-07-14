// Electron boot smoke — controller protocol + safety pins (audit D3).
//
// The REAL smoke (a live Electron boot of the unmodified app) runs via
// `npm run smoke:electron`; it is too heavy for the unit suite. What THIS file
// proves without Electron:
//   1. the controller protocol end-to-end against fake node children
//      (happy / failed-check / crash / hang-timeout-kill / no-clean-exit /
//      malformed output / duplicate readiness / spawn failure),
//   2. the pure protocol pieces (parser, evaluator, sanitizer, env scrub),
//   3. the SAFETY pins: the smoke is a separate entry point — production code
//      never reads a smoke flag, the smoke files carry no control-path
//      vocabulary, smokeMain adds no IPC/preload/window surface and calls
//      only READ-ONLY preload methods, and the pinned API list cannot drift
//      from the real preload.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EVENT_PREFIX,
  REQUIRED_STAGES,
  EXPECTED_API,
  isAllowedConsoleError,
  formatEvent,
  createLineParser,
  secretValuesFromEnv,
  sanitizeLog,
  evaluateSmokeRun,
} from '../scripts/smokeShared.js';
import {
  SCENARIOS,
  buildScenarioEnv,
  waitPidDead,
  removeDirWithRetry,
  runChild,
} from '../scripts/electron-smoke.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

// Ban/contains pins run against CODE ONLY (the ipcSurface.test.js recipe): a
// safety-posture comment naming a forbidden API must neither trip a ban nor
// satisfy a contains-pin. Block comments first, then full-line and trailing
// `//` comments (trailing requires leading whitespace so URLs survive).
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/[ \t]\/\/[^\n]*/g, '');

const smokeMainSrc = stripComments(read('../scripts/smokeMain.js'));
const controllerSrc = stripComments(read('../scripts/electron-smoke.js'));
const sharedSrc = stripComments(read('../scripts/smokeShared.js'));

// ---------- protocol: parser ----------

describe('smoke protocol parser', () => {
  it('parses tokens split across arbitrary chunk boundaries, ignoring app log noise', () => {
    const parser = createLineParser();
    const line = formatEvent({ event: 'stage', stage: 'window-created' });
    const events = [
      ...parser.feed('[mediamtx] binary not found\n' + line.slice(0, 12)),
      ...parser.feed(line.slice(12)),
      ...parser.feed('plain log line\n'),
    ];
    expect(events).toEqual([{ event: 'stage', stage: 'window-created' }]);
  });

  it('handles CRLF line endings (Windows child)', () => {
    const parser = createLineParser();
    const events = parser.feed(`${EVENT_PREFIX}{"event":"result","ok":true}\r\n`);
    expect(events).toEqual([{ event: 'result', ok: true }]);
  });

  it('a prefixed but malformed token is a PROTOCOL error, never silently dropped', () => {
    const parser = createLineParser();
    const events = parser.feed(`${EVENT_PREFIX}{"event": broken\n`);
    expect(events.length).toBe(1);
    expect(events[0].protocolError).toMatch(/malformed smoke token/);
  });

  it('a token missing the event field is a protocol error', () => {
    const parser = createLineParser();
    const [ev] = parser.feed(`${EVENT_PREFIX}{"ok":true}\n`);
    expect(ev.protocolError).toMatch(/without an event field/);
  });

  it('flush() recovers a final partial line from a killed child', () => {
    const parser = createLineParser();
    expect(parser.feed(`${EVENT_PREFIX}{"event":"hang"}`)).toEqual([]);
    expect(parser.flush()).toEqual([{ event: 'hang' }]);
  });

  it('an oversized pending line is bounded: a runaway smoke token is a protocol error, runaway log noise is dropped', () => {
    const parser = createLineParser();
    // A token that never ends: discarded AND flagged (the child is corrupt).
    const events = parser.feed(`${EVENT_PREFIX}${'x'.repeat(300 * 1024)}`);
    expect(events.length).toBe(1);
    expect(events[0].protocolError).toMatch(/oversized smoke token/);
    expect(parser.flush()).toEqual([]); // the buffer was reset, not kept
    // A huge ordinary log line: dropped silently (raw log capture keeps it),
    // and a real token afterwards still parses.
    const parser2 = createLineParser();
    expect(parser2.feed('y'.repeat(300 * 1024))).toEqual([]);
    expect(parser2.feed(`\n${EVENT_PREFIX}{"event":"result","ok":true}\n`)).toEqual([{ event: 'result', ok: true }]);
  });
});

// ---------- protocol: evaluator ----------

const stageEvents = (names) => names.map((stage) => ({ event: 'stage', stage }));
const happyRun = () => ({
  events: [...stageEvents(REQUIRED_STAGES), { event: 'result', ok: true }],
  protocolErrors: [],
  exitCode: 0,
  timedOut: false,
  log: '[mediamtx] binary not found at /tmp/x\n',
});

describe('smoke run evaluation', () => {
  it('accepts a full run: every stage token, one ok result, exit 0', () => {
    const verdict = evaluateSmokeRun(happyRun(), { childOk: true });
    expect(verdict.ok).toBe(true);
    expect(verdict.failures).toEqual([]);
  });

  it('a missing stage token fails even with an ok result and exit 0 (no lucky passes)', () => {
    const run = happyRun();
    run.events = run.events.filter((e) => e.stage !== 'security');
    const verdict = evaluateSmokeRun(run, { childOk: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join(' ')).toContain('missing stage token: security');
  });

  it('result.ok=false fails and surfaces the failing stage', () => {
    const run = happyRun();
    run.events[run.events.length - 1] = { event: 'result', ok: false, failedStage: 'ipc-roundtrip', failures: ['boom'] };
    run.exitCode = 1;
    const verdict = evaluateSmokeRun(run, { childOk: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join(' ')).toContain('ipc-roundtrip');
  });

  it('a non-zero exit fails even when the result token claims ok', () => {
    const run = happyRun();
    run.exitCode = 1;
    const verdict = evaluateSmokeRun(run, { childOk: true });
    expect(verdict.failures.join(' ')).toContain('exit code 1');
  });

  it('a DUPLICATE readiness token fails the run', () => {
    const run = happyRun();
    run.events.push({ event: 'result', ok: true });
    const verdict = evaluateSmokeRun(run, { childOk: true });
    expect(verdict.failures.join(' ')).toContain('duplicate readiness token');
  });

  it('protocol errors fail the run', () => {
    const run = happyRun();
    run.protocolErrors = ['malformed smoke token: junk'];
    expect(evaluateSmokeRun(run, { childOk: true }).ok).toBe(false);
  });

  it('a required log marker that never appeared fails the run', () => {
    const run = happyRun();
    run.log = 'nothing interesting\n';
    const verdict = evaluateSmokeRun(run, { childOk: true, logMustMatch: [/\[mediamtx\] binary not found/] });
    expect(verdict.failures.join(' ')).toContain('did not match');
  });

  it('negative scenario (childOk:false): met when the child fails at the named stage with non-zero exit', () => {
    const run = {
      events: [...stageEvents(['electron-ready']), { event: 'result', ok: false, failedStage: 'ipc-roundtrip', failures: ['forced'] }],
      protocolErrors: [], exitCode: 1, timedOut: false, log: '',
    };
    expect(evaluateSmokeRun(run, { childOk: false, failedStage: 'ipc-roundtrip' }).ok).toBe(true);
  });

  it('negative scenario: the WRONG failing stage or a zero exit code is a deviation', () => {
    const base = {
      events: [{ event: 'result', ok: false, failedStage: 'security' }],
      protocolErrors: [], exitCode: 1, timedOut: false, log: '',
    };
    expect(evaluateSmokeRun(base, { childOk: false, failedStage: 'ipc-roundtrip' }).ok).toBe(false);
    const zeroExit = { ...base, events: [{ event: 'result', ok: false, failedStage: 'ipc-roundtrip' }], exitCode: 0 };
    expect(evaluateSmokeRun(zeroExit, { childOk: false, failedStage: 'ipc-roundtrip' }).failures.join(' ')).toContain('non-zero exit');
  });

  it('timeout scenario: met only when the run actually hit the deadline with no result token', () => {
    const wedged = {
      events: stageEvents(['electron-ready', 'window-created', 'window-loaded']),
      protocolErrors: [], exitCode: null, timedOut: true, log: '',
    };
    expect(evaluateSmokeRun(wedged, { timedOut: true, stagesAtLeast: ['window-loaded'] }).ok).toBe(true);
    const exited = { ...wedged, timedOut: false, exitCode: 0 };
    expect(evaluateSmokeRun(exited, { timedOut: true }).ok).toBe(false);
    const early = { ...wedged, events: stageEvents(['electron-ready']) };
    expect(evaluateSmokeRun(early, { timedOut: true, stagesAtLeast: ['window-loaded'] }).failures.join(' ')).toContain('window-loaded');
  });
});

// ---------- protocol: sanitizer + env scrub ----------

describe('log sanitization and environment scrub', () => {
  it('collects credential-looking env values and redacts every occurrence', () => {
    const secrets = secretValuesFromEnv({
      CSC_KEY_PASSWORD: 'hunter22222',
      GITHUB_TOKEN: 'ghp_abcdef',
      MY_SECRET: 'tops3cret',
      SHORT_TOKEN: 'ab',            // too short — not worth redacting noise
      PATH: '/usr/bin',             // name does not match
    });
    expect(secrets).toContain('hunter22222');
    expect(secrets).toContain('ghp_abcdef');
    expect(secrets).toContain('tops3cret');
    expect(secrets).not.toContain('ab');
    expect(secrets).not.toContain('/usr/bin');
    const out = sanitizeLog('start hunter22222 mid ghp_abcdef end hunter22222', secrets);
    expect(out).not.toContain('hunter22222');
    expect(out).not.toContain('ghp_abcdef');
    expect(out).toBe('start [REDACTED] mid [REDACTED] end [REDACTED]');
  });

  it('never redacts the shell working-directory variables (PWD is a path, not a credential)', () => {
    const secrets = secretValuesFromEnv({ PWD: '/Users/dev/project', OLDPWD: '/Users/dev' });
    expect(secrets).toEqual([]);
  });

  it('buildScenarioEnv scrubs every inherited W17_* variable plus the Electron/Node leaks, then sets only its own', () => {
    const env = buildScenarioEnv({
      base: {
        PATH: '/usr/bin',
        W17_HEADTRACK: '1',
        W17_IPHONE_BRIDGE: '1',
        W17_TELEMETRY_SOURCE: 'replay',
        W17_WHEP_URL: 'http://elsewhere',
        ELECTRON_RUN_AS_NODE: '1',
        NODE_OPTIONS: '--inspect',
      },
      userData: '/tmp/ud',
      mediamtxDir: '/tmp/mtx',
    });
    expect(env.PATH).toBe('/usr/bin');
    for (const gone of ['W17_HEADTRACK', 'W17_IPHONE_BRIDGE', 'W17_TELEMETRY_SOURCE', 'W17_WHEP_URL', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) {
      expect(env, `${gone} must be scrubbed`).not.toHaveProperty(gone);
    }
    expect(env.W17_WIFI_SIM).toBe('two-adapters');
    expect(env.W17_MEDIAMTX_DIR).toBe('/tmp/mtx');
    expect(env.W17_SMOKE_USERDATA).toBe('/tmp/ud');
  });

  it('scenario extras (the smoke-only fault flags) apply on top of the scrub', () => {
    const env = buildScenarioEnv({ base: {}, userData: 'u', mediamtxDir: 'm', extra: { W17_SMOKE_HANG: '1' } });
    expect(env.W17_SMOKE_HANG).toBe('1');
  });

  it('the console-error allowlist tolerates ONLY the loopback WHEP endpoint', () => {
    expect(isAllowedConsoleError('Failed to load resource: net::ERR_CONNECTION_REFUSED [http://127.0.0.1:8889/cam/whep:0]')).toBe(true);
    expect(isAllowedConsoleError('Uncaught TypeError: x is not a function [file:///renderer/hud.js:12]')).toBe(false);
    expect(isAllowedConsoleError('Refused to connect to https://evil.example/')).toBe(false);
  });
});

// ---------- controller behavior against fake node children ----------

// A fake "smoke child": plain node emitting whatever the case needs. Spawning
// through the REAL runChild exercises parsing, timeout, tree-kill, grace
// handling, and pid verification without booting Electron.
const fakeChild = (body) => ({ command: process.execPath, args: ['-e', body] });
const emitAll = `const p=${JSON.stringify(EVENT_PREFIX)};const w=(o)=>process.stdout.write(p+JSON.stringify(o)+'\\n');`;
const allStages = `for (const s of ${JSON.stringify([...REQUIRED_STAGES])}) w({event:'stage',stage:s});`;

describe('smoke controller vs fake children', () => {
  it('happy child: stages + result + clean exit evaluate as a pass', async () => {
    const run = await runChild({
      ...fakeChild(`${emitAll}${allStages}w({event:'result',ok:true});`),
      timeoutMs: 15000,
    });
    expect(run.exitCode).toBe(0);
    expect(run.timedOut).toBe(false);
    expect(run.killed).toBe(false);
    expect(run.pidDead).toBe(true);
    expect(evaluateSmokeRun(run, { childOk: true }).ok).toBe(true);
  });

  it('failed-check child: result ok:false + exit 1 satisfies a negative contract, fails a positive one', async () => {
    const run = await runChild({
      ...fakeChild(`${emitAll}w({event:'stage',stage:'electron-ready'});w({event:'result',ok:false,failedStage:'security',failures:['x']});process.exitCode=1;`),
      timeoutMs: 15000,
    });
    expect(run.exitCode).toBe(1);
    expect(evaluateSmokeRun(run, { childOk: false, failedStage: 'security' }).ok).toBe(true);
    expect(evaluateSmokeRun(run, { childOk: true }).ok).toBe(false);
  });

  it('crashing child (no result token) fails with a clear verdict', async () => {
    const run = await runChild({
      ...fakeChild(`${emitAll}w({event:'stage',stage:'electron-ready'});process.exit(3);`),
      timeoutMs: 15000,
    });
    expect(run.exitCode).toBe(3);
    const verdict = evaluateSmokeRun(run, { childOk: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join(' ')).toContain('no readiness result token');
  });

  it('hanging child: the hard timeout kills the process tree and the pid is verified dead', async () => {
    const run = await runChild({
      ...fakeChild(`${emitAll}w({event:'stage',stage:'electron-ready'});setInterval(()=>{},1000);`),
      timeoutMs: 1500,
    });
    expect(run.timedOut).toBe(true);
    expect(run.killed).toBe(true);
    expect(run.pidDead).toBe(true);
    expect(run.durationMs).toBeLessThan(10000);
    expect(evaluateSmokeRun(run, { timedOut: true, stagesAtLeast: ['electron-ready'] }).ok).toBe(true);
  }, 20000);

  it('no-clean-exit child: a result token followed by a wedge is killed after the grace period and fails', async () => {
    const run = await runChild({
      ...fakeChild(`${emitAll}${allStages}w({event:'result',ok:true});setInterval(()=>{},1000);`),
      timeoutMs: 30000,
      graceMs: 1500,
    });
    expect(run.resultSeen).toBe(true);
    expect(run.killed).toBe(true);
    expect(run.timedOut).toBe(false);
    expect(run.pidDead).toBe(true);
    // Killed => exit code is null/non-zero, so a positive contract fails.
    expect(evaluateSmokeRun(run, { childOk: true }).ok).toBe(false);
  }, 20000);

  it('malformed child output is captured as a protocol error and fails the run', async () => {
    const run = await runChild({
      ...fakeChild(`process.stdout.write(${JSON.stringify(EVENT_PREFIX)}+'{oops not json\\n');`),
      timeoutMs: 15000,
    });
    expect(run.protocolErrors.length).toBe(1);
    expect(evaluateSmokeRun(run, { childOk: true }).ok).toBe(false);
  });

  it('duplicate readiness tokens from a child are rejected', async () => {
    const run = await runChild({
      ...fakeChild(`${emitAll}${allStages}w({event:'result',ok:true});w({event:'result',ok:true});`),
      timeoutMs: 15000,
    });
    const verdict = evaluateSmokeRun(run, { childOk: true });
    expect(verdict.failures.join(' ')).toContain('duplicate readiness token');
  });

  it('a spawn failure (missing binary) is reported, never thrown', async () => {
    const run = await runChild({
      command: join(tmpdir(), 'definitely-not-a-real-binary-w17'),
      args: [],
      timeoutMs: 5000,
    });
    expect(run.spawnError).toBeTruthy();
    expect(evaluateSmokeRun(run, { childOk: true }).ok).toBe(false);
  });

  it('secrets riding the child log are redacted end-to-end', async () => {
    const run = await runChild({
      ...fakeChild(`console.log('leaked: ' + process.env.W17_TEST_FAKE_TOKEN);`),
      env: { ...process.env, W17_TEST_FAKE_TOKEN: 'sup3rs3cretvalue' },
      timeoutMs: 15000,
    });
    expect(run.log).toContain('sup3rs3cretvalue');
    const sanitized = sanitizeLog(run.log, secretValuesFromEnv({ W17_TEST_FAKE_TOKEN: 'sup3rs3cretvalue' }));
    expect(sanitized).not.toContain('sup3rs3cretvalue');
    expect(sanitized).toContain('leaked: [REDACTED]');
  });

  it('waitPidDead confirms an already-dead pid quickly', async () => {
    const run = await runChild({ ...fakeChild('process.exit(0);'), timeoutMs: 5000 });
    expect(await waitPidDead(run.pid, 1000)).toBe(true);
  });

  it('the captured raw log is BOUNDED: a child flooding stdout is truncated with a marker, and the run still evaluates', async () => {
    // 700KB of noise then a valid result: the log cap (512KB) keeps the tail.
    const run = await runChild({
      ...fakeChild(`${emitAll}const chunk='n'.repeat(64*1024);for(let i=0;i<11;i++)process.stdout.write(chunk+'\\n');${allStages}w({event:'result',ok:true});`),
      timeoutMs: 20000,
    });
    expect(run.log.length).toBeLessThan(600 * 1024);
    expect(run.log).toContain('[log truncated');
    expect(evaluateSmokeRun(run, { childOk: true }).ok).toBe(true);
  }, 25000);

  it('removeDirWithRetry removes a populated temp tree and reports it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'w17-smoke-test-'));
    mkdirSync(join(root, 'user-data'), { recursive: true });
    writeFileSync(join(root, 'user-data', 'settings.json'), '{}');
    expect(await removeDirWithRetry(root)).toBe(true);
    expect(existsSync(root)).toBe(false);
  });
});

// ---------- scenario table pins ----------

describe('smoke scenario contracts', () => {
  it('the suite carries all four required scenarios and cannot silently drop the negative ones', () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual(['corrupt-settings', 'forced-failure', 'normal', 'timeout']);
    expect(SCENARIOS['forced-failure'].expect.childOk).toBe(false);
    expect(SCENARIOS['forced-failure'].env.W17_SMOKE_FAIL_STAGE).toBe('ipc-roundtrip');
    expect(SCENARIOS.timeout.expect.timedOut).toBe(true);
    expect(SCENARIOS.timeout.env.W17_SMOKE_HANG).toBe('1');
  });

  it('the normal scenario REQUIRES the missing-mediamtx soft-fail to be visible in the log', () => {
    expect(SCENARIOS.normal.expect.logMustMatch.some((re) => re.test('[mediamtx] binary not found at /x/mediamtx -- run'))).toBe(true);
  });

  it('the corrupt-settings scenario seeds malformed JSON and requires the fallback log line', () => {
    expect(() => JSON.parse(SCENARIOS['corrupt-settings'].seedSettings)).toThrow();
    expect(SCENARIOS['corrupt-settings'].expect.logMustMatch.some((re) => re.test('[settings] unreadable /tmp/x/settings.json (boom); using defaults'))).toBe(true);
  });
});

// ---------- safety pins: the smoke is a separate, inert entry point ----------

const RUNTIME_DIRS = ['main', 'shared', 'renderer'];
const RUNTIME_EXT = new Set(['.js', '.mjs', '.cjs']);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function runtimeFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile()) continue;
      if (/\.(test|spec)\./.test(entry.name)) continue;
      if (RUNTIME_EXT.has(extname(entry.name))) out.push(full);
    }
  };
  for (const dir of RUNTIME_DIRS) walk(join(repoRoot, dir));
  return out;
}

describe('smoke safety pins (audit D3)', () => {
  it('NO production runtime module reads any smoke variable — smoke mode has zero effect outside the smoke entry point', () => {
    for (const file of runtimeFiles()) {
      const src = readFileSync(file, 'utf8');
      expect(src, `${file} must not reference W17_SMOKE`).not.toContain('W17_SMOKE');
    }
  });

  it('NO production runtime module imports the smoke tooling — the dependency points one way only', () => {
    for (const file of runtimeFiles()) {
      const src = readFileSync(file, 'utf8');
      for (const smokeModule of ['smokeShared', 'smokeMain', 'electron-smoke']) {
        expect(src, `${file} must not import ${smokeModule}`).not.toContain(smokeModule);
      }
    }
  });

  it('smokeMain boots exactly the REAL application entry, once, and nothing else', () => {
    const boots = [...smokeMainSrc.matchAll(/require\(path\.join\(__dirname, '\.\.', '([^']+)', '([^']+)'\)\)/g)]
      .map((m) => `${m[1]}/${m[2]}`);
    expect(boots).toEqual(['main/main.js']);
  });

  it('the unit tests never launch real Electron: this file imports only fake-child-safe controller pieces', () => {
    const self = read('./electronSmoke.test.js');
    const importBlock = self.match(/import \{([^}]+)\} from '\.\.\/scripts\/electron-smoke\.js'/)[1];
    const imported = importBlock.split(',').map((s) => s.trim()).filter(Boolean);
    // runScenario (which resolves and spawns the real Electron binary) stays
    // out of the unit suite — the real boot runs via `npm run smoke:electron`.
    expect(imported).toEqual(['SCENARIOS', 'buildScenarioEnv', 'waitPidDead', 'removeDirWithRetry', 'runChild']);
    // The fake children are plain node (the running test executable itself).
    expect(self).toContain('command: process.execPath');
  });

  it('the smoke-only fault flags exist ONLY in the smoke entry point (plus the controller that sets them)', () => {
    expect(smokeMainSrc).toContain('W17_SMOKE_FAIL_STAGE');
    expect(smokeMainSrc).toContain('W17_SMOKE_HANG');
    expect(sharedSrc).not.toContain('W17_SMOKE_FAIL_STAGE');
    expect(sharedSrc).not.toContain('W17_SMOKE_HANG');
  });

  it('the smoke files carry no control-path vocabulary (the same bans the directory sweep enforces)', () => {
    for (const [name, src] of [['smokeMain', smokeMainSrc], ['electron-smoke', controllerSrc], ['smokeShared', sharedSrc]]) {
      for (const forbidden of [
        'headTracking', 'HeadTracking', 'CrsfFrameBuilder', 'RcChannels',
        'buildRcChannels', 'encodeRcChannels', 'setPosition', 'setThrottle', 'ledc',
        'serialport', 'SerialPort',
      ]) {
        expect(src, `${name} must not reference ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('smokeMain adds NO surface: no IPC registration, no preload/bridge, no window, no webPreferences override', () => {
    for (const forbidden of [
      'ipcMain', 'contextBridge', 'exposeInMainWorld', 'setPreloads',
      'registerPreloadScript', 'webPreferences', 'new BrowserWindow', 'loadURL', 'loadFile',
    ]) {
      expect(smokeMainSrc, `smokeMain must not use ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('smokeMain calls ONLY read-only preload methods from the page — it can never create a control path', () => {
    const called = [...smokeMainSrc.matchAll(/groundStation\.(\w+)\s*\(/g)].map((m) => m[1]);
    const allowed = new Set(['getConfig', 'getSettings', 'onTelemetry']);
    const outside = called.filter((name) => !allowed.has(name));
    expect(outside, `smokeMain page probes call non-read-only preload methods: ${outside.join(', ')}`).toEqual([]);
    expect(called.length).toBeGreaterThan(0); // the extraction found the real calls
  });

  it('the controller spawns ONLY the Electron child and the tree-kill — no netsh, powershell, or OS network commands', () => {
    for (const forbidden of ['netsh', 'powershell', 'StartTethering', 'wlan ']) {
      expect(controllerSrc, `controller must not reference ${forbidden}`).not.toContain(forbidden);
    }
    expect(controllerSrc).toContain('winTreeKillArgs'); // the N4 tree-kill argv, reused not re-invented
  });

  it('the pinned EXPECTED_API cannot drift from the real preload surface', () => {
    const preloadSrc = read('../main/preload.cjs');
    const block = preloadSrc.slice(
      preloadSrc.indexOf("exposeInMainWorld('groundStation', {"),
      preloadSrc.lastIndexOf('});'),
    );
    const exposed = [...block.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]).sort();
    expect([...EXPECTED_API]).toEqual(exposed);
  });

  it('every required stage is actually implemented in smokeMain (no drift between contract and wrapper)', () => {
    for (const stage of REQUIRED_STAGES) {
      expect(smokeMainSrc, `smokeMain must implement stage '${stage}'`).toContain(`'${stage}'`);
    }
  });

  it('the smoke is wired into the local command and the Windows CI job (never permanently skipped)', () => {
    const pkg = JSON.parse(read('../package.json'));
    expect(pkg.scripts['smoke:electron']).toBe('node scripts/electron-smoke.js');
    const workflow = read('../.github/workflows/ci.yml');
    expect(workflow).toContain('npm run smoke:electron');
  });
});
