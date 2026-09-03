// Companion for 50-race-day.ps1 — drives race day's REAL orchestrator
// (main/raceDayOrchestrator.js: RaceDayOrchestrator) against the REAL staged
// settings.json (written by 20-mapper-stage.ps1), using the REAL
// main/mapperRunner.js to spawn the ACTUAL mapper binary. This is the same
// "require the app's own modules out of app.asar, never re-implement them"
// discipline as lib/hotspot-probe.js and lib/mdns-probe.js: the whole point
// of this validation pass is to prove what the SHIPPED code does, not what a
// parallel guess does. It exists to gather runtime evidence for two CONFIRMED
// v2-review findings (w17-mapper.v2report.json):
//
//   MAP-1 (blocker) — `-config-file-path` double-wraps the committed profile
//   (grpc_client.go:57-62 puts the WHOLE file into SetConfigReq.Config;
//   server_grpc.go:103-104 re-marshals to {"config": <file>};
//   configs/w17-ds4.json already carries that wrapper; schema.yaml then
//   rejects the doubled document; grpc_client.go:64 panics) — so the mapper
//   the orchestrator spawns is expected to crash shortly after launch, EVERY
//   time, against today's code.
//
//   MAP-2 (blocker) — race day's argv whitelist (MAPPER_ARG_WHITELIST,
//   raceDayOrchestrator.js:44) can only ever carry `-config-file-path`, and
//   no GS code calls the mapper's StartLink RPC — so even a mapper that
//   survives never drives the RF link. This is a STRUCTURAL fact (provable
//   from the exported whitelist + the pure mapperArgv() builder, not
//   something that could pass on a lucky run), captured below every time via
//   the SAME functions raceDayOrchestrator.js itself calls — not re-derived.
//
// SCOPE — the mapper step only. This probe deliberately REFUSES (before ever
// calling raceDay.start()) when the REAL persisted settings would also drive
// race day's hotspot step (network.kind === 'hotspot') or phone-bridge step
// (fpvMode === 'iphone-hud' && racePrep.autoBridge): those two authorities
// are already exercised end-to-end, for real, by 30-hotspot.ps1 and
// 40-mdns-udp.ps1's replay path respectively. Silently standing in for them
// here with stubs would either (a) blur which script owns which evidence, or
// (b) risk leaving a real hotspot running behind an unattended VM session.
// RaceDayOrchestrator.start()'s own top-level try/catch
// (raceDayOrchestrator.js's `start()` — see the "sequence failed
// unexpectedly" branch) swallows a stub's thrown detail into an
// undifferentiated 'unexpected' step failure by design (it must never leak
// credential-bearing detail to the renderer), so checking BEFORE start() is
// what keeps a refusal here legible instead of an opaque one.
//
// Run under the app's own Electron binary in Node mode (ELECTRON_RUN_AS_NODE
// = 1), same as the other probes in this directory:
//   $env:ELECTRON_RUN_AS_NODE = '1'
//   & <installDir>\<exe> <this file> <appAsarPath> <userDataDir> [waitMs]
//
// "Quit stops the mapper" is exercised via the SAME two real teardown paths a
// giftee session can hit — the STOP button (appWiring.js
// reg('raceday:stop') -> raceDay.stop()) when the mapper is still alive
// after the wait window, and app-quit teardown (main.js's
// ['race day mapper', () => raceDay.dispose()]) unconditionally before this
// process exits — never a bespoke kill. One JSON result line on stdout,
// prefixed RACEDAY_PROBE_RESULT:; everything else on stdout/stderr is
// diagnostics only.

'use strict';

const path = require('node:path');

function fail(kind, message) {
  process.stdout.write(`RACEDAY_PROBE_RESULT: ${JSON.stringify({ ok: false, kind, error: message })}\n`);
  process.exit(1);
}

const appRoot = process.argv[2];
const userDataDir = process.argv[3];
const waitMs = Number(process.argv[4]) || 8000;

if (!appRoot || !userDataDir) {
  fail('bad-args', 'usage: race-day-probe.js <appAsarOrRoot> <userDataDir> [waitMs]');
}

let RaceDayOrchestrator;
let mapperArgv;
let MAPPER_ARG_WHITELIST;
let createSettingsStore;
let MapperRunner;
let normalizeRacePrep;
try {
  ({ RaceDayOrchestrator, mapperArgv, MAPPER_ARG_WHITELIST } = require(path.join(appRoot, 'main', 'raceDayOrchestrator.js')));
  ({ createSettingsStore } = require(path.join(appRoot, 'main', 'settingsStore.js')));
  ({ MapperRunner } = require(path.join(appRoot, 'main', 'mapperRunner.js')));
  ({ normalizeRacePrep } = require(path.join(appRoot, 'shared', 'settings.js')));
} catch (err) {
  fail('module-load-failed', `could not load the app's own race-day modules from ${appRoot}: ${err.message}`);
}

const logLines = [];
const log = (m) => {
  const line = String(m);
  logLines.push(line);
  process.stderr.write(`[raceday-probe] ${line}\n`); // diagnostics only — never the JSON result line
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const settingsStore = createSettingsStore({ dir: userDataDir, log });
  let settings;
  try {
    settings = settingsStore.load();
  } catch (err) {
    fail('settings-load-failed', err.message);
    return;
  }

  const prep = normalizeRacePrep(settings.racePrep);
  if (!prep.mapperPath || !prep.profilePath) {
    fail('not-staged', `no racePrep staged in ${userDataDir}\\settings.json (mapperPath=${JSON.stringify(prep.mapperPath)} profilePath=${JSON.stringify(prep.profilePath)}) — run 20-mapper-stage.ps1 first, against this SAME -UserDataDir`);
    return;
  }

  // Out-of-scope guards — see the file header. Checked against the REAL
  // persisted settings this run actually found, never assumed.
  if (settings.network && settings.network.kind === 'hotspot') {
    fail('out-of-scope-hotspot-configured', 'settings.json has network.kind="hotspot" — race day\'s hotspot step would run for real from this probe. Re-run 30-hotspot.ps1 to test that step, or change network.kind away from "hotspot" before running this probe.');
    return;
  }
  if (settings.fpvMode === 'iphone-hud' && prep.autoBridge) {
    fail('out-of-scope-bridge-configured', 'settings.json has fpvMode="iphone-hud" and racePrep.autoBridge=true — race day\'s phone-bridge step would run for real from this probe. Use 40-mdns-udp.ps1\'s replay-bridge check for that path, or set autoBridge=false / fpvMode away from "iphone-hud" before running this probe.');
    return;
  }

  const loudly = (label) => () => {
    throw new Error(`${label} was called, but this probe wires no real implementation for it — the out-of-scope guards above should make this unreachable; if you see this, something changed and needs a look before trusting the result`);
  };
  const hotspotLifecycleStub = {
    snapshot: () => ({ phase: 'idle' }),
    start: loudly('hotspotLifecycle.start'),
    verify: loudly('hotspotLifecycle.verify'),
  };
  const sessionApplierStub = {
    apply: loudly('sessionApplier.apply'),
    effective: () => null,
  };

  const mapperRunner = new MapperRunner({ log });
  const raceDay = new RaceDayOrchestrator({
    hotspotLifecycle: hotspotLifecycleStub,
    mapperRunner,
    sessionApplier: sessionApplierStub,
    settingsStore,
    // elrsDetect deliberately left at the orchestrator's own default no-op
    // (`async () => ({configured:false, detected:false})`) — wiring the real
    // main/elrsLauncher.js detection seam here would pull in tasklist/pgrep
    // process scanning this narrow, mapper-focused probe does not need; the
    // default only ever makes race day MORE likely to spawn the managed
    // mapper (never less), so it cannot mask MAP-1/MAP-2 evidence.
    log,
  });

  // The exact argv race day's OWN pure builder computes for THIS profile —
  // captured directly from the function under test, not re-derived or
  // guessed. This is the MAP-2 evidence: whatever this says is the COMPLETE
  // set of strings that will ever reach the mapper's argv, by construction
  // (mapperArgv has no branch that appends anything else).
  const argvCheck = mapperArgv(prep);

  const startResult = await raceDay.start();
  const afterStart = raceDay.snapshot();

  // Poll until the mapper step settles (process exit) or the wait budget
  // elapses with it still running. raceDay.start() itself does not wait for
  // the mapper's own lifetime — MapperRunner.start() returns as soon as
  // spawn() succeeds, well before a self-dialing client.Init() panic (MAP-1)
  // would land.
  const deadline = Date.now() + waitMs;
  let snap = raceDay.snapshot();
  while (Date.now() < deadline && snap.mapper.running) {
    await sleep(200);
    snap = raceDay.snapshot();
  }
  const mapperSurvivedWaitWindow = snap.mapper.running;
  const mapperStatusAfterWait = snap.mapper;

  // "Quit stops the mapper" — both real teardown paths a giftee session can
  // hit, never a bespoke kill:
  //  (a) the STOP button (appWiring.js reg('raceday:stop') -> raceDay.stop()),
  //      only meaningful while still running;
  //  (b) app-quit teardown (main.js's ['race day mapper', () =>
  //      raceDay.dispose()]) — called unconditionally below regardless of
  //      (a), exactly as it would run when the giftee closes the app.
  let stopResult = null;
  if (mapperSurvivedWaitWindow) {
    stopResult = raceDay.stop();
    const stopDeadline = Date.now() + 5000;
    let s = raceDay.snapshot();
    while (Date.now() < stopDeadline && s.mapper.running) {
      await sleep(150);
      s = raceDay.snapshot();
    }
  }
  raceDay.dispose();
  const finalSnapshot = raceDay.snapshot();

  const logTail = finalSnapshot.mapper.logTail || [];
  const exitedOnItsOwn = !mapperSurvivedWaitWindow && !mapperStatusAfterWait.stoppedByUs;
  const crashSuspected = exitedOnItsOwn
    && ((mapperStatusAfterWait.exitCode !== 0 && mapperStatusAfterWait.exitCode !== null)
      || /panic:/i.test(logTail.join('\n')));

  const result = {
    // Probe MECHANICS succeeded (it drove the orchestrator end to end and
    // got a coherent read). Whether what it OBSERVED counts as a pass is
    // 50-race-day.ps1's call against the CONFIRMED findings above, not this
    // probe's — this field is deliberately never a verdict on MAP-1/MAP-2.
    ok: true,
    prep: { mapperPath: prep.mapperPath, profilePath: prep.profilePath, autoBridge: prep.autoBridge },
    mapperArgWhitelist: MAPPER_ARG_WHITELIST,
    argvCheck,
    startResult: { ok: startResult.ok, steps: startResult.snapshot.steps },
    mapperPidAtStart: afterStart.mapper.pid,
    waitMsUsed: waitMs,
    mapperSurvivedWaitWindow,
    mapperStatusAfterWait,
    crashSuspected,
    stopResult,
    finalMapperStatus: finalSnapshot.mapper,
    mapperLogTail: logTail,
    probeLog: logLines,
  };
  process.stdout.write(`RACEDAY_PROBE_RESULT: ${JSON.stringify(result)}\n`);
  process.exit(0);
}

main().catch((err) => {
  fail('threw', err && err.stack ? err.stack : String(err));
});
