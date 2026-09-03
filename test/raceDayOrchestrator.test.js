import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  RaceDayOrchestrator, mapperArgv, MAPPER_ARG_WHITELIST, STEP_ORDER,
} = require('../main/raceDayOrchestrator.js');

// ---------- fakes (no Electron, no processes, no network) ----------

const HS_PASSWORD = 'grid-secret-42';

function fakeLifecycle({
  phase = 'inactive',
  startResult = { ok: true },
  phaseAfterStart = 'live',
  verifyResult = { ok: true, readiness: { status: 'verified', reasons: [] } },
  readiness = { status: 'verified', reasons: [] },
} = {}) {
  const lc = {
    phase,
    start: vi.fn(async () => {
      lc.phase = phaseAfterStart;
      return startResult;
    }),
    verify: vi.fn(async () => verifyResult),
    stop: vi.fn(async () => ({ ok: true })),
    snapshot: vi.fn(() => ({ phase: lc.phase, readiness })),
  };
  return lc;
}

function fakeRunner({ running = false, startResult = { ok: true, pid: 7 } } = {}) {
  const listeners = new Set();
  const runner = {
    _running: running,
    status: vi.fn(() => ({ running: runner._running, pid: 7, exitCode: null, stoppedByUs: false })),
    start: vi.fn(() => {
      if (startResult.ok) runner._running = true;
      return startResult;
    }),
    stop: vi.fn(() => {
      runner._running = false;
      return { ok: true, stopped: true };
    }),
    logTail: vi.fn(() => ['[out] listening']),
    onChange: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit: (st) => {
      for (const fn of listeners) fn(st);
    },
  };
  return runner;
}

function fakeApplier({ iphoneBridge = true, envForcedOff = false, throwOnApply = false } = {}) {
  return {
    apply: vi.fn(() => {
      if (throwOnApply) throw new Error('boom');
      return { telemetry: 'none', iphoneBridge, w3: false };
    }),
    effective: vi.fn(() => ({ envOverridden: { iphoneBridge: envForcedOff } })),
  };
}

function settingsWith(over = {}) {
  return {
    fpvMode: 'iphone-hud',
    iphoneAddr: '10.0.0.9',
    network: { kind: 'hotspot', hotspot: { ssid: 'W17-GRID', password: HS_PASSWORD } },
    racePrep: { mapperPath: '/w17/mapper.exe', profilePath: '/w17/w17-ds4.json', autoBridge: true },
    ...over,
  };
}

function harness({
  settings = settingsWith(), lifecycle, runner, applier, exists = () => true,
  elrsDetect = vi.fn(async () => ({ configured: false, detected: false })),
} = {}) {
  const lc = lifecycle || fakeLifecycle();
  const rn = runner || fakeRunner();
  const ap = applier || fakeApplier();
  const pushes = [];
  const orch = new RaceDayOrchestrator({
    hotspotLifecycle: lc,
    mapperRunner: rn,
    sessionApplier: ap,
    settingsStore: { load: () => JSON.parse(JSON.stringify(settings)) },
    existsSync: exists,
    elrsDetect,
  });
  orch.onChange((snap) => pushes.push(snap));
  return { orch, lc, rn, ap, pushes, elrsDetect };
}

const stepOf = (snap, id) => snap.steps.find((s) => s.id === id);

// ---------- the pure argv whitelist (the invariant's front door) ----------

describe('mapperArgv — the ONLY source of mapper command lines', () => {
  it('a valid profile path yields exactly the whitelist flag + the path, in value position', () => {
    expect(mapperArgv({ profilePath: '/w17/w17-ds4.json' }))
      .toEqual({ ok: true, argv: ['-config-file-path', '/w17/w17-ds4.json'] });
  });

  it('refuses an empty/absent/blank profile instead of launching an unconfigured mapper', () => {
    for (const profilePath of [undefined, null, '', '   ', 42, {}]) {
      expect(mapperArgv({ profilePath }).ok, `profilePath=${JSON.stringify(profilePath)}`).toBe(false);
    }
    expect(mapperArgv({}).kind).toBe('no-profile');
  });

  it('refuses a flag-shaped profile path — a settings value can never become an option', () => {
    for (const hostile of ['-headtrack-ingest', '--anything', '-config-file-path', '  -x']) {
      const res = mapperArgv({ profilePath: hostile });
      expect(res).toEqual({ ok: false, kind: 'bad-profile-path' });
    }
  });

  it('refuses a RELATIVE profile path (review minor 3): the GS and the mapper resolve them against different directories', () => {
    // The orchestrator existence-checks against the GS cwd; the mapper
    // resolves against its own cwd (the binary folder). A relative value can
    // pass here and still miss there — refuse under BOTH path conventions.
    for (const relative of ['relative/w17.json', './w17.json', '../w17.json', 'w17.json', 'C:w17.json']) {
      expect(mapperArgv({ profilePath: relative }), relative).toEqual({ ok: false, kind: 'bad-profile-path' });
    }
    // Either convention's ABSOLUTE form is accepted (⚙ written on Windows,
    // dev runs on POSIX), and the value is passed trimmed.
    expect(mapperArgv({ profilePath: ' /w17/w17.json ' }).argv).toEqual(['-config-file-path', '/w17/w17.json']);
    expect(mapperArgv({ profilePath: 'C:\\W17\\w17.json' }).ok).toBe(true);
    expect(mapperArgv({ profilePath: '\\\\pit-nas\\w17\\w17.json' }).ok).toBe(true); // UNC
  });

  it('over a hostile corpus, every emitted argv carries ONLY whitelisted lifecycle strings', () => {
    const corpus = [
      { profilePath: '/w17/w17-ds4.json' },
      { profilePath: 'C:\\W17\\w17 profile.json' },
      { profilePath: 'relative/w17.json' }, // refused since review minor 3 (relative)
      { profilePath: '-headtrack-ingest' },
      { profilePath: '--grpc-port 10000' },
      { profilePath: '' },
      { profilePath: '   ' },
      {},
      { profilePath: 'x'.repeat(4096) }, // relative — refused
      { profilePath: '/w17/w17.json', extraArgs: ['-headtrack-ingest'] }, // no such escape hatch exists
      { profilePath: '/w17/w17.json', args: ['-tx-serial-port-name', 'COM7'] },
    ];
    for (const cfg of corpus) {
      const res = mapperArgv(cfg);
      if (!res.ok) continue;
      // Shape: exactly [flag, value] — flags only from the whitelist, the
      // value never dash-leading, and NO forbidden mapper option anywhere.
      expect(res.argv).toHaveLength(2);
      expect(MAPPER_ARG_WHITELIST).toContain(res.argv[0]);
      expect(res.argv[1].startsWith('-')).toBe(false);
      for (const forbidden of [
        '-headtrack-ingest', '-headtrack-port', '-tx-serial-port-name',
        '-tx-serial-port-baud-rate', '-grpc-port', '-webapp-port', '-disable-web-ui',
      ]) {
        expect(res.argv, `argv must never carry ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('the whitelist itself is pinned: one lifecycle flag, nothing else', () => {
    expect([...MAPPER_ARG_WHITELIST]).toEqual(['-config-file-path']);
  });
});

// ---------- the sequence ----------

describe('RaceDayOrchestrator — happy path', () => {
  it('runs hotspot -> mapper -> bridge and lands every step green', async () => {
    const { orch, lc, rn, ap } = harness();
    const res = await orch.start();
    expect(res.ok).toBe(true);
    const snap = res.snapshot;
    expect(stepOf(snap, 'hotspot')).toMatchObject({ status: 'ok', kind: 'verified' });
    expect(stepOf(snap, 'mapper')).toMatchObject({ status: 'ok', kind: 'running' });
    expect(stepOf(snap, 'bridge')).toMatchObject({ status: 'ok', kind: 'on' });
    expect(snap.running).toBe(false);
    // The authorities were driven exactly once each, with the saved values.
    expect(lc.start).toHaveBeenCalledWith({ ssid: 'W17-GRID', password: HS_PASSWORD });
    expect(lc.verify).toHaveBeenCalledTimes(1);
    expect(rn.start).toHaveBeenCalledWith({
      binaryPath: '/w17/mapper.exe',
      argv: ['-config-file-path', '/w17/w17-ds4.json'],
    });
    expect(ap.apply).toHaveBeenCalledTimes(1);
  });

  it('step order is the documented sequence (hotspot, mapper, bridge)', async () => {
    const order = [];
    const lc = fakeLifecycle();
    lc.start.mockImplementation(async () => { order.push('hotspot'); lc.phase = 'live'; return { ok: true }; });
    const rn = fakeRunner();
    rn.start.mockImplementation(() => { order.push('mapper'); rn._running = true; return { ok: true, pid: 7 }; });
    const ap = fakeApplier();
    ap.apply.mockImplementation(() => { order.push('bridge'); return { iphoneBridge: true }; });
    const { orch } = harness({ lifecycle: lc, runner: rn, applier: ap });
    await orch.start();
    expect(order).toEqual(['hotspot', 'mapper', 'bridge']);
    expect(STEP_ORDER).toEqual(['hotspot', 'mapper', 'bridge']);
  });

  it('a second start while one is in flight answers busy and runs nothing twice', async () => {
    let release;
    const lc = fakeLifecycle();
    lc.start.mockImplementation(() => new Promise((r) => { release = () => { lc.phase = 'live'; r({ ok: true }); }; }));
    const { orch, rn } = harness({ lifecycle: lc });
    const first = orch.start();
    const second = await orch.start();
    expect(second).toMatchObject({ ok: false, kind: 'busy' });
    release();
    await first;
    expect(lc.start).toHaveBeenCalledTimes(1);
    expect(rn.start).toHaveBeenCalledTimes(1);
  });
});

describe('RaceDayOrchestrator — skips are honest, not silent', () => {
  it('own-Wi-Fi plan: hotspot skipped, mapper still managed, bridge still applied', async () => {
    const { orch, lc } = harness({
      settings: settingsWith({ network: { kind: 'join', hotspot: { ssid: '', password: '' } } }),
    });
    const res = await orch.start();
    expect(res.ok).toBe(true);
    expect(stepOf(res.snapshot, 'hotspot')).toMatchObject({ status: 'skipped', kind: 'own-wifi' });
    expect(lc.start).not.toHaveBeenCalled();
    expect(lc.verify).not.toHaveBeenCalled();
  });

  it('desktop session: bridge skipped, sequence still succeeds', async () => {
    const { orch, ap } = harness({ settings: settingsWith({ fpvMode: 'solo' }) });
    const res = await orch.start();
    expect(res.ok).toBe(true);
    expect(stepOf(res.snapshot, 'bridge')).toMatchObject({ status: 'skipped', kind: 'desktop-session' });
    expect(ap.apply).not.toHaveBeenCalled();
  });

  it('autoBridge off: bridge skipped by choice', async () => {
    const { orch, ap } = harness({
      settings: settingsWith({ racePrep: { mapperPath: '/w17/mapper.exe', profilePath: '/w17/w17.json', autoBridge: false } }),
    });
    const res = await orch.start();
    expect(res.ok).toBe(true);
    expect(stepOf(res.snapshot, 'bridge')).toMatchObject({ status: 'skipped', kind: 'off-by-choice' });
    expect(ap.apply).not.toHaveBeenCalled();
  });
});

describe('RaceDayOrchestrator — failure halts the sequence, partial state stays up', () => {
  it('hotspot start failure: mapper and bridge stay pending, nothing else runs', async () => {
    const lc = fakeLifecycle({ startResult: { ok: false, kind: 'ps-error' }, phaseAfterStart: 'inactive' });
    const { orch, rn, ap } = harness({ lifecycle: lc });
    const res = await orch.start();
    expect(res.ok).toBe(false);
    expect(stepOf(res.snapshot, 'hotspot')).toMatchObject({ status: 'fail', kind: 'start-failed' });
    expect(stepOf(res.snapshot, 'mapper').status).toBe('pending');
    expect(stepOf(res.snapshot, 'bridge').status).toBe('pending');
    expect(rn.start).not.toHaveBeenCalled();
    expect(ap.apply).not.toHaveBeenCalled();
  });

  it('degraded readiness is a FAILURE (honest readiness bar), not a shrug', async () => {
    const lc = fakeLifecycle({
      verifyResult: { ok: true, readiness: { status: 'degraded', reasons: ['no gateway'] } },
    });
    const { orch } = harness({ lifecycle: lc });
    const res = await orch.start();
    expect(res.ok).toBe(false);
    expect(stepOf(res.snapshot, 'hotspot')).toMatchObject({ status: 'fail', kind: 'degraded' });
  });

  it('mapper failure leaves the (already verified) hotspot up — nothing is wound back', async () => {
    const { orch, lc, rn } = harness({ exists: () => false }); // profile file missing
    const res = await orch.start();
    expect(res.ok).toBe(false);
    expect(stepOf(res.snapshot, 'hotspot')).toMatchObject({ status: 'ok', kind: 'verified' });
    expect(stepOf(res.snapshot, 'mapper')).toMatchObject({ status: 'fail', kind: 'profile-not-found' });
    expect(stepOf(res.snapshot, 'bridge').status).toBe('pending');
    expect(lc.stop).not.toHaveBeenCalled();
    expect(rn.stop).not.toHaveBeenCalled();
  });

  it('mapper config failures map to distinct kinds the card can explain', async () => {
    const cases = [
      [{ mapperPath: '', profilePath: '/w17/w17.json', autoBridge: true }, 'not-configured'],
      [{ mapperPath: '/w17/mapper.exe', profilePath: '', autoBridge: true }, 'no-profile'],
      [{ mapperPath: '/w17/mapper.exe', profilePath: '-headtrack-ingest', autoBridge: true }, 'bad-profile-path'],
      // Relative profile refused before launch (review minor 3).
      [{ mapperPath: '/w17/mapper.exe', profilePath: 'configs/w17.json', autoBridge: true }, 'bad-profile-path'],
    ];
    for (const [racePrep, kind] of cases) {
      const { orch, rn } = harness({ settings: settingsWith({ racePrep }) });
      const res = await orch.start();
      expect(res.ok).toBe(false);
      expect(stepOf(res.snapshot, 'mapper'), kind).toMatchObject({ status: 'fail', kind });
      expect(rn.start).not.toHaveBeenCalled();
    }
  });

  it('runner refusals pass through as the step kind (not-found, spawn-failed)', async () => {
    for (const kind of ['not-found', 'spawn-failed']) {
      const rn = fakeRunner({ startResult: { ok: false, kind, error: 'x' } });
      const { orch } = harness({ runner: rn });
      const res = await orch.start();
      expect(stepOf(res.snapshot, 'mapper')).toMatchObject({ status: 'fail', kind });
    }
  });

  it('bridge outcomes: no saved address vs env-forced-off vs apply crash', async () => {
    const noAddr = harness({ applier: fakeApplier({ iphoneBridge: false }) });
    expect(stepOf((await noAddr.orch.start()).snapshot, 'bridge')).toMatchObject({ status: 'fail', kind: 'no-address' });

    const forced = harness({ applier: fakeApplier({ iphoneBridge: false, envForcedOff: true }) });
    expect(stepOf((await forced.orch.start()).snapshot, 'bridge')).toMatchObject({ status: 'fail', kind: 'forced-off' });

    const crash = harness({ applier: fakeApplier({ throwOnApply: true }) });
    const res = await crash.orch.start();
    expect(stepOf(res.snapshot, 'bridge')).toMatchObject({ status: 'fail', kind: 'apply-failed' });
    expect(res.ok).toBe(false);
  });

  it('an unexpected mid-sequence rejection never wedges RUNNING — the in-flight step goes red', async () => {
    const lc = fakeLifecycle();
    lc.verify.mockRejectedValue(new Error('plumbing'));
    const { orch } = harness({ lifecycle: lc });
    const res = await orch.start();
    expect(res.ok).toBe(false);
    expect(res.snapshot.running).toBe(false);
    expect(stepOf(res.snapshot, 'hotspot')).toMatchObject({ status: 'fail', kind: 'unexpected' });
  });
});

describe('RaceDayOrchestrator — a retry re-runs idempotently', () => {
  it('a live hotspot is only re-verified (never restarted); a running mapper is left running', async () => {
    const lc = fakeLifecycle({ phase: 'live' });
    const rn = fakeRunner({ running: true });
    const { orch, ap } = harness({ lifecycle: lc, runner: rn });
    const res = await orch.start();
    expect(res.ok).toBe(true);
    expect(lc.start).not.toHaveBeenCalled();
    expect(lc.verify).toHaveBeenCalledTimes(1);
    expect(rn.start).not.toHaveBeenCalled();
    expect(stepOf(res.snapshot, 'hotspot')).toMatchObject({ status: 'ok', kind: 'verified' });
    expect(stepOf(res.snapshot, 'mapper')).toMatchObject({ status: 'ok', kind: 'already-running' });
    expect(ap.apply).toHaveBeenCalledTimes(1); // bridge re-apply is idempotent main-side
  });

  it('after a mapper failure, pressing again re-runs the fixed step without disturbing the green ones', async () => {
    let exists = false;
    const { orch, lc, rn } = harness({ exists: () => exists });
    await orch.start(); // fails at profile-not-found
    exists = true;      // the owner fixed the path
    const res = await orch.start();
    expect(res.ok).toBe(true);
    expect(stepOf(res.snapshot, 'mapper')).toMatchObject({ status: 'ok', kind: 'running' });
    // Hotspot went live on run 1, so run 2 verified it instead of restarting.
    expect(lc.start).toHaveBeenCalledTimes(1);
    expect(lc.verify).toHaveBeenCalledTimes(2);
    expect(rn.start).toHaveBeenCalledTimes(1);
  });

  it('no local verifier (macOS dev, no sim): live hotspot reports ok/unverified — a clean no-op, not a lie', async () => {
    const lc = fakeLifecycle({
      verifyResult: { ok: false, kind: 'unsupported', error: 'local verification is unavailable on this platform' },
    });
    const { orch } = harness({ lifecycle: lc });
    const res = await orch.start();
    expect(res.ok).toBe(true);
    expect(stepOf(res.snapshot, 'hotspot')).toMatchObject({ status: 'ok', kind: 'unverified' });
  });
});

// Review minor 5: the GRID's detached convenience launch is this same
// executable — a second instance would lose its port bind and die with a
// misleading "stopped on its own" line. Race day probes first via the
// EXISTING elrs detection seam and no-ops honestly.
describe('RaceDayOrchestrator — a drive program already running OUTSIDE race day', () => {
  it('detects the external instance, marks the step ok/external, and spawns NOTHING', async () => {
    const elrsDetect = vi.fn(async () => ({ configured: true, detected: true, method: 'pgrep' }));
    const { orch, rn } = harness({ elrsDetect });
    const res = await orch.start();
    expect(res.ok).toBe(true);
    expect(elrsDetect).toHaveBeenCalledWith('/w17/mapper.exe'); // probed with the RACE DAY binary path
    expect(stepOf(res.snapshot, 'mapper')).toMatchObject({ status: 'ok', kind: 'external' });
    expect(rn.start).not.toHaveBeenCalled();
    // Not ours: the managed-runner surface stays empty, so STOP never offers
    // to kill a process race day did not start (launch-only doctrine).
    expect(res.snapshot.mapper.running).toBe(false);
    const stopped = orch.stop();
    expect(rn.stop).not.toHaveBeenCalled();
    expect(stopped.ok).toBe(true);
  });

  it('a rejected probe reads as not-running: the launch proceeds and reports its own truth', async () => {
    const elrsDetect = vi.fn(async () => { throw new Error('tasklist unavailable'); });
    const { orch, rn } = harness({ elrsDetect });
    const res = await orch.start();
    expect(res.ok).toBe(true);
    expect(rn.start).toHaveBeenCalledTimes(1);
    expect(stepOf(res.snapshot, 'mapper')).toMatchObject({ status: 'ok', kind: 'running' });
  });

  it('an unconfigured/negative probe changes nothing (the default path still launches)', async () => {
    const { orch, rn, elrsDetect } = harness(); // default: configured:false
    await orch.start();
    expect(elrsDetect).toHaveBeenCalledTimes(1);
    expect(rn.start).toHaveBeenCalledTimes(1);
  });
});

describe('RaceDayOrchestrator — stop and liveness', () => {
  it('STOP stops ONLY the managed mapper: the hotspot authority is never touched', async () => {
    const { orch, lc, rn } = harness();
    await orch.start();
    const res = orch.stop();
    expect(res.ok).toBe(true);
    expect(rn.stop).toHaveBeenCalledTimes(1);
    expect(lc.stop).not.toHaveBeenCalled();
    for (const s of res.snapshot.steps) expect(s.status).toBe('idle');
  });

  it('a FAILED kill propagates stop-failed and leaves the card truthful — never idle over a live child (review minor 4)', async () => {
    const rn = fakeRunner();
    rn.stop.mockImplementation(() => ({ ok: false, kind: 'stop-failed', error: 'EPERM' }));
    const { orch } = harness({ runner: rn });
    await orch.start();
    const res = orch.stop();
    expect(res).toMatchObject({ ok: false, kind: 'stop-failed' });
    // Steps untouched: the drive program is STILL RUNNING and the card says so.
    expect(stepOf(res.snapshot, 'mapper')).toMatchObject({ status: 'ok', kind: 'running' });
    expect(stepOf(res.snapshot, 'hotspot')).toMatchObject({ status: 'ok', kind: 'verified' });
    expect(res.snapshot.mapper.running).toBe(true);
    // A later successful stop still winds down normally.
    rn.stop.mockImplementation(() => { rn._running = false; return { ok: true, stopped: true }; });
    const again = orch.stop();
    expect(again.ok).toBe(true);
    for (const s of again.snapshot.steps) expect(s.status).toBe('idle');
  });

  it('STOP during a bring-up answers busy (the authorities own their in-flight transitions)', async () => {
    let release;
    const lc = fakeLifecycle();
    lc.start.mockImplementation(() => new Promise((r) => { release = () => { lc.phase = 'live'; r({ ok: true }); }; }));
    const { orch } = harness({ lifecycle: lc });
    const inflight = orch.start();
    expect(orch.stop()).toMatchObject({ ok: false, kind: 'busy' });
    release();
    await inflight;
  });

  it('a mapper CRASH flips the step to fail/exited via the liveness mirror; OUR stop winds it to idle', async () => {
    const { orch, rn, pushes } = harness();
    await orch.start();
    rn._running = false;
    rn.emit({ running: false, stoppedByUs: false, exitCode: 1 });
    let last = pushes[pushes.length - 1];
    expect(stepOf(last, 'mapper')).toMatchObject({ status: 'fail', kind: 'exited' });

    await orch.start(); // bring it back
    rn._running = false;
    rn.emit({ running: false, stoppedByUs: true, exitCode: null });
    last = pushes[pushes.length - 1];
    expect(stepOf(last, 'mapper')).toMatchObject({ status: 'idle' });
  });

  it("the runner's async spawn-error settlement maps to fail/spawn-failed — the ⚙-location line, not \"stopped on its own\" (review blocker 1)", async () => {
    const { orch, rn, pushes } = harness();
    await orch.start();
    rn._running = false;
    rn.emit({ running: false, stoppedByUs: false, exitCode: 'spawn-error' });
    const last = pushes[pushes.length - 1];
    expect(stepOf(last, 'mapper')).toMatchObject({ status: 'fail', kind: 'spawn-failed' });
  });

  // The drive program refuses a saved controller setup whose per-computer
  // values are still unfilled: it prints ONE plain sentence and exits 1. Race
  // day must show that sentence — "stopped on its own — press RACE DAY to
  // bring it back" would send the operator round a loop that cannot succeed.
  it('a self-death WITH the child\'s own line maps to fail/exited-with-message and carries the sentence', async () => {
    const { orch, rn, pushes } = harness();
    await orch.start();
    rn._running = false;
    rn.status = vi.fn(() => ({
      running: false, pid: 7, exitCode: 1, stoppedByUs: false,
      exitMessage: 'this saved profile has not been matched to this computer yet',
    }));
    rn.emit({
      running: false, stoppedByUs: false, exitCode: 1,
      exitMessage: 'this saved profile has not been matched to this computer yet',
    });
    const last = pushes[pushes.length - 1];
    expect(stepOf(last, 'mapper')).toMatchObject({ status: 'fail', kind: 'exited-with-message' });
    // The snapshot carries the child's words to the renderer verbatim.
    expect(last.mapper.exitMessage).toBe('this saved profile has not been matched to this computer yet');
  });

  it('a silent self-death still maps to the plain fail/exited line', async () => {
    const { orch, rn, pushes } = harness();
    await orch.start();
    rn._running = false;
    rn.emit({ running: false, stoppedByUs: false, exitCode: 1, exitMessage: null });
    expect(stepOf(pushes[pushes.length - 1], 'mapper')).toMatchObject({ status: 'fail', kind: 'exited' });
  });

  // Review correctness-5, second half: the runner escalated the stop and the
  // child outlived it. The card must go BACK to saying the program is there.
  it('a stop that never took flips the step to fail/stop-failed even from idle', async () => {
    const { orch, rn, pushes } = harness();
    await orch.start();
    rn._running = false;
    orch.stop(); // winds every step to idle
    expect(stepOf(pushes[pushes.length - 1], 'mapper')).toMatchObject({ status: 'idle' });
    rn.emit({ running: true, stoppedByUs: true, exitCode: null, stopFailed: true });
    expect(stepOf(pushes[pushes.length - 1], 'mapper')).toMatchObject({ status: 'fail', kind: 'stop-failed' });
  });

  it('dispose() stops a running child and unsubscribes the liveness mirror (teardown path)', async () => {
    const { orch, rn, pushes } = harness();
    await orch.start();
    orch.dispose();
    expect(rn.stop).toHaveBeenCalledTimes(1);
    const count = pushes.length;
    rn.emit({ running: false, stoppedByUs: true, exitCode: null });
    expect(pushes.length).toBe(count); // no post-dispose emission
  });
});

describe('RaceDayOrchestrator — snapshot hygiene', () => {
  it('seq is strictly monotonic over every pushed snapshot', async () => {
    const { orch, pushes } = harness();
    await orch.start();
    orch.stop();
    const seqs = pushes.map((s) => s.seq);
    for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
  });

  it('no snapshot ever carries the hotspot credential or ssid — steps are {id,status,kind} only', async () => {
    const { orch, pushes } = harness();
    const res = await orch.start();
    for (const snap of [...pushes, res.snapshot, orch.snapshot()]) {
      const json = JSON.stringify(snap);
      expect(json).not.toContain(HS_PASSWORD);
      expect(json).not.toContain('W17-GRID');
      for (const s of snap.steps) {
        expect(Object.keys(s).sort()).toEqual(['id', 'kind', 'status']);
      }
    }
  });

  it('the status answer carries mapper liveness + the bounded diagnostics tail (technician surface)', async () => {
    const { orch } = harness();
    await orch.start();
    const snap = orch.snapshot();
    expect(snap.mapper).toMatchObject({ running: true, pid: 7 });
    expect(snap.mapper.logTail).toEqual(['[out] listening']);
  });
});
