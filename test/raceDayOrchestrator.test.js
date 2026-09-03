import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const {
  RaceDayOrchestrator, mapperArgv, MAPPER_ARG_WHITELIST, STEP_ORDER,
} = require('../main/raceDayOrchestrator.js');
// The REAL persistence, for the one write race day makes (OD-19). Everything
// else in this file runs against fakes; the credential regression below has to
// see the actual file the actual store writes.
const { createSettingsStore } = require('../main/settingsStore.js');
const { createCredentialStore } = require('../main/credentialStore.js');

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

// The mapper's read-only link answer (review SYN-2). `up` is true / false /
// null (unknown); the orchestrator polls snapshot() and subscribes to changes.
function fakeLinkProbe({ up = true } = {}) {
  const listeners = new Set();
  const probe = {
    _up: up,
    start: vi.fn(),
    stop: vi.fn(),
    snapshot: vi.fn(() => ({ up: probe._up })),
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    set: (next) => { probe._up = next; for (const fn of listeners) fn({ up: next }); },
  };
  return probe;
}

// The store seam the orchestrator actually uses: load() plus the ONE narrow
// write race day is allowed to make (OD-19). Tests that care about the write
// pass their own store (or the real one) via `settingsStore`.
function fakeSettingsStore(settings) {
  return {
    load: () => JSON.parse(JSON.stringify(settings)),
    credentialStatus: () => ({ state: 'none', encryptionAvailable: true, hasPassword: false }),
    patchTelemetrySource: vi.fn(() => ({ ok: true })),
  };
}

function harness({
  settings = settingsWith(), lifecycle, runner, applier, exists = () => true,
  elrsDetect = vi.fn(async () => ({ configured: false, detected: false })),
  telemetryStatus, linkProbe, settingsStore,
} = {}) {
  const lc = lifecycle || fakeLifecycle();
  const rn = runner || fakeRunner();
  const ap = applier || fakeApplier();
  const pushes = [];
  const orch = new RaceDayOrchestrator({
    hotspotLifecycle: lc,
    mapperRunner: rn,
    sessionApplier: ap,
    settingsStore: settingsStore || fakeSettingsStore(settings),
    existsSync: exists,
    elrsDetect,
    ...(telemetryStatus ? { telemetryStatus } : {}),
    ...(linkProbe ? { linkProbe } : {}),
    // Every bounded wait in this module runs on the injected clock; no test in
    // this file ever waits real milliseconds.
    schedule: (fn) => { setImmediate(fn); return 0; },
  });
  orch.onChange((snap) => pushes.push(snap));
  return {
    orch, lc, rn, ap, pushes, elrsDetect, linkProbe,
  };
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
    // Twice since OD-4: the car-readings step re-applies after selecting the
    // source, then the phone-link step applies its own settings.
    expect(ap.apply).toHaveBeenCalledTimes(2);
  });

  it('step order is the documented sequence (hotspot, mapper, bridge)', async () => {
    const order = [];
    const lc = fakeLifecycle();
    lc.start.mockImplementation(async () => { order.push('hotspot'); lc.phase = 'live'; return { ok: true }; });
    const rn = fakeRunner();
    rn.start.mockImplementation(() => { order.push('mapper'); rn._running = true; return { ok: true, pid: 7 }; });
    const ap = fakeApplier();
    ap.apply.mockImplementation(() => { order.push('bridge'); return { iphoneBridge: true }; });
    const { orch } = harness({
      lifecycle: lc,
      runner: rn,
      applier: ap,
      // A source already chosen keeps the car-readings step out of the trace,
      // so this test still measures ORDER rather than the OD-4 selection.
      telemetryStatus: () => ({ source: 'mapper-grpc', receiving: true }),
    });
    await orch.start();
    expect(order).toEqual(['hotspot', 'mapper', 'bridge']);
    expect(STEP_ORDER).toEqual(['hotspot', 'mapper', 'telemetry', 'bridge']);
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

  // A source already chosen keeps the car-readings step from applying too, so
  // `apply` here still means "the PHONE LINK step ran" and nothing else.
  const sourceChosen = () => ({ source: 'mapper-grpc', receiving: true });

  it('desktop session: bridge skipped, sequence still succeeds', async () => {
    const { orch, ap } = harness({
      settings: settingsWith({ fpvMode: 'solo' }),
      telemetryStatus: sourceChosen,
    });
    const res = await orch.start();
    expect(res.ok).toBe(true);
    expect(stepOf(res.snapshot, 'bridge')).toMatchObject({ status: 'skipped', kind: 'desktop-session' });
    expect(ap.apply).not.toHaveBeenCalled();
  });

  it('autoBridge off: bridge skipped by choice', async () => {
    const { orch, ap } = harness({
      settings: settingsWith({ racePrep: { mapperPath: '/w17/mapper.exe', profilePath: '/w17/w17.json', autoBridge: false } }),
      telemetryStatus: sourceChosen,
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

  // Owner decision OD-7 / review giftee-ux-2. A hotspot that is ALREADY on is
  // refused by the backend — including the one this app itself left running.
  // Race day halts at the first failing step, so that refusal used to stop the
  // drive program too, on the one route the booklet prints as the recovery.
  it('already-on with the SAVED name is ok/external and the drive program still starts (OD-7)', async () => {
    const lc = fakeLifecycle({
      startResult: { ok: false, kind: 'already-on', ssid: 'W17-GRID' },
      phaseAfterStart: 'inactive',
    });
    const { orch, rn } = harness({ lifecycle: lc });
    const res = await orch.start();
    expect(res.ok).toBe(true);
    expect(stepOf(res.snapshot, 'hotspot')).toMatchObject({ status: 'ok', kind: 'external' });
    expect(rn.start).toHaveBeenCalledTimes(1); // the step that matters ran
    // Nothing was verified or stopped: it is not this app's network.
    expect(lc.verify).not.toHaveBeenCalled();
    expect(lc.stop).not.toHaveBeenCalled();
  });

  it('already-on under a DIFFERENT name still fails — the phone could not join it', async () => {
    const lc = fakeLifecycle({
      startResult: { ok: false, kind: 'already-on', ssid: 'SomeoneElse' },
      phaseAfterStart: 'inactive',
    });
    const { orch, rn } = harness({ lifecycle: lc });
    const res = await orch.start();
    expect(res.ok).toBe(false);
    expect(stepOf(res.snapshot, 'hotspot')).toMatchObject({ status: 'fail', kind: 'other-hotspot' });
    expect(rn.start).not.toHaveBeenCalled();
  });

  it('already-on with an UNREADABLE name fails honestly — "probably ours" is not a claim to make', async () => {
    const lc = fakeLifecycle({
      startResult: { ok: false, kind: 'already-on', ssid: null },
      phaseAfterStart: 'inactive',
    });
    const { orch } = harness({ lifecycle: lc });
    const res = await orch.start();
    expect(stepOf(res.snapshot, 'hotspot')).toMatchObject({ status: 'fail', kind: 'already-on-unknown' });
  });

  it('a saved SSID that is blank never matches (an empty name is not a match)', async () => {
    const lc = fakeLifecycle({
      startResult: { ok: false, kind: 'already-on', ssid: '' },
      phaseAfterStart: 'inactive',
    });
    const { orch } = harness({
      lifecycle: lc,
      settings: settingsWith({ network: { kind: 'hotspot', hotspot: { ssid: '', password: HS_PASSWORD } } }),
    });
    const res = await orch.start();
    expect(stepOf(res.snapshot, 'hotspot')).toMatchObject({ status: 'fail', kind: 'already-on-unknown' });
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
    // Twice: the car-readings step's re-apply, then the idempotent bridge one.
    expect(ap.apply).toHaveBeenCalledTimes(2);
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

  // Review finding 3, the other side of it: an undelivered stop is now reported
  // at once, so the card can reach 'stop-failed' while the runner is still
  // forcing the issue. If that force lands, the card must say so — "it would
  // not stop and is still running" over a dead process is the same lie the
  // other way round.
  it('a stop-failed card winds back to idle once the child is confirmed gone', async () => {
    const { orch, rn, pushes } = harness();
    await orch.start();
    rn.emit({ running: true, stoppedByUs: true, exitCode: null, stopFailed: true });
    expect(stepOf(pushes[pushes.length - 1], 'mapper')).toMatchObject({ status: 'fail', kind: 'stop-failed' });
    rn._running = false;
    rn.emit({ running: false, stoppedByUs: true, exitCode: null, stopFailed: false });
    expect(stepOf(pushes[pushes.length - 1], 'mapper')).toMatchObject({ status: 'idle', kind: null });
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

// --- SYN-2: a started drive program is not a transmitting one --------------
// The mapper opens the transmitter's serial port itself. With that port shut it
// emits no CRSF frame at all, and the card said "running" either way — the one
// claim on this screen the giftee acts on.
describe('RaceDayOrchestrator — the card says running only when the radio is up (SYN-2)', () => {
  it('link UP: the step is ok/running and the sequence carries on', async () => {
    const probe = fakeLinkProbe({ up: true });
    const { orch } = harness({ linkProbe: probe });
    const res = await orch.start();
    expect(stepOf(res.snapshot, 'mapper')).toMatchObject({ status: 'ok', kind: 'running' });
    expect(probe.start).toHaveBeenCalled();
    expect(res.snapshot.link).toEqual({ up: true });
  });

  // Review blocking 2. The mapper answers "not connected" from the instant the
  // stream opens, and LINK_UP_WAIT_MS is [bench-TBD] — so on a FIRST bring-up a
  // closed window is a slow start, not a fault. Halting there told the giftee to
  // check a cable that is fine, on the one press the booklet promises.
  it('link NOT UP on a first bring-up: "not yet", ok-class, and the sequence carries on', async () => {
    const { orch, rn, ap } = harness({ linkProbe: fakeLinkProbe({ up: false }) });
    const res = await orch.start();
    expect(res.ok).toBe(true);
    expect(stepOf(res.snapshot, 'mapper')).toMatchObject({ status: 'ok', kind: 'link-not-yet' });
    // The program itself was started, and the rest of the bring-up still ran.
    expect(rn.start).toHaveBeenCalledTimes(1);
    expect(ap.apply).toHaveBeenCalled();
    expect(stepOf(res.snapshot, 'telemetry').status).not.toBe('pending');
  });

  it('the "not yet" line upgrades itself the moment the radio answers', async () => {
    const probe = fakeLinkProbe({ up: false });
    const { orch, pushes } = harness({ linkProbe: probe });
    await orch.start();
    expect(stepOf(pushes[pushes.length - 1], 'mapper')).toMatchObject({ status: 'ok', kind: 'link-not-yet' });
    probe.set(true);
    expect(stepOf(pushes[pushes.length - 1], 'mapper')).toMatchObject({ status: 'ok', kind: 'running' });
  });

  it('and it keeps the kind it was standing in for (an external instance stays external)', async () => {
    const probe = fakeLinkProbe({ up: false });
    const { orch, pushes } = harness({
      elrsDetect: vi.fn(async () => ({ configured: true, detected: true })),
      linkProbe: probe,
    });
    await orch.start();
    expect(stepOf(pushes[pushes.length - 1], 'mapper')).toMatchObject({ status: 'ok', kind: 'link-not-yet' });
    probe.set(true);
    expect(stepOf(pushes[pushes.length - 1], 'mapper')).toMatchObject({ status: 'ok', kind: 'external' });
  });

  // The other half of blocking 2, and OD-5 unchanged: once the mapper has
  // CLAIMED the link up in this session, "not up" is a positive report about a
  // radio that can work — the cable line is earned, and the halt stands.
  it('link DOWN after a live claim: the cable line, and the sequence halts (OD-5)', async () => {
    const probe = fakeLinkProbe({ up: true });
    const { orch, ap } = harness({ linkProbe: probe });
    await orch.start();                       // the radio answered: a live claim
    probe.set(false);                         // and then went away
    ap.apply.mockClear();
    const res = await orch.start();           // the operator presses again
    expect(res.ok).toBe(false);
    expect(stepOf(res.snapshot, 'mapper')).toMatchObject({ status: 'fail', kind: 'link-down' });
    expect(stepOf(res.snapshot, 'telemetry').status).toBe('pending');
    expect(ap.apply).not.toHaveBeenCalled();
  });

  it('no answer at all: honest partial success, said out loud, never a silent "running"', async () => {
    const { orch } = harness({ linkProbe: fakeLinkProbe({ up: null }) });
    const res = await orch.start();
    expect(res.ok).toBe(true);
    expect(stepOf(res.snapshot, 'mapper')).toMatchObject({ status: 'ok', kind: 'link-unknown' });
  });

  it('with NO probe wired the step behaves exactly as before (never an invented link state)', async () => {
    const { orch } = harness();
    const res = await orch.start();
    expect(stepOf(res.snapshot, 'mapper')).toMatchObject({ status: 'ok', kind: 'running' });
    expect(res.snapshot.link).toEqual({ up: null });
  });

  it('an ALREADY-RUNNING or EXTERNAL instance is link-checked too — not trusted on sight', async () => {
    // Neither is reported as plainly 'running'/'already-running': the radio has
    // to answer first. (On a first bring-up "no answer yet" is 'link-not-yet' —
    // see blocking 2 above; the point here is that the check happens at all.)
    const rn = fakeRunner({ running: true });
    const probeA = fakeLinkProbe({ up: false });
    const { orch } = harness({ runner: rn, linkProbe: probeA });
    expect(stepOf((await orch.start()).snapshot, 'mapper')).toMatchObject({ status: 'ok', kind: 'link-not-yet' });
    expect(probeA.start).toHaveBeenCalled();

    const probeB = fakeLinkProbe({ up: false });
    const { orch: orch2 } = harness({
      elrsDetect: vi.fn(async () => ({ configured: true, detected: true })),
      linkProbe: probeB,
    });
    expect(stepOf((await orch2.start()).snapshot, 'mapper')).toMatchObject({ status: 'ok', kind: 'link-not-yet' });
    expect(probeB.start).toHaveBeenCalled();
  });

  it('a link that drops mid-drive takes the claim back, and returns it when the radio comes back', async () => {
    const probe = fakeLinkProbe({ up: true });
    const { orch, pushes } = harness({ linkProbe: probe });
    await orch.start();
    probe.set(false);
    expect(stepOf(pushes[pushes.length - 1], 'mapper')).toMatchObject({ status: 'fail', kind: 'link-down' });
    probe.set(true);
    expect(stepOf(pushes[pushes.length - 1], 'mapper')).toMatchObject({ status: 'ok', kind: 'running' });
  });

  it('STOP and dispose() stop watching the link (no stream outlives the drive program)', async () => {
    const probe = fakeLinkProbe({ up: true });
    const { orch } = harness({ linkProbe: probe });
    await orch.start();
    orch.stop();
    expect(probe.stop).toHaveBeenCalledTimes(1);
    orch.dispose();
    expect(probe.stop).toHaveBeenCalledTimes(2);
  });
});

// --- OD-4: the telemetry step -----------------------------------------------
// On the shipped defaults the telemetry source is 'none' and NO screen can tell
// Lola the battery is low. This step selects the drive program's read-only
// stream — the only source that can run while race day holds the serial port.
describe('RaceDayOrchestrator — the car-readings step (OD-4)', () => {
  const status = (over = {}) => {
    const st = { source: 'none', receiving: false, ...over };
    return () => st;
  };

  it('selects the read-only mapper source when nothing is configured, and says so once readings arrive', async () => {
    const st = { source: 'none', receiving: false };
    const saved = [];
    const settings = settingsWith();
    const { orch, ap } = harness({
      telemetryStatus: () => st,
      settings,
    });
    // The NARROW patch + apply is what the step does (OD-19); model the runtime
    // following it. save() is deliberately not the seam any more — see the
    // credential regression block at the end of this file.
    orch._settingsStore.patchTelemetrySource = (source) => {
      saved.push(source);
      st.source = source;
      st.receiving = true;
      return { ok: true, changed: true };
    };
    const res = await orch.start();
    expect(saved).toEqual(['mapper-grpc']);
    expect(ap.apply).toHaveBeenCalled();
    expect(stepOf(res.snapshot, 'telemetry')).toMatchObject({ status: 'ok', kind: 'live' });
  });

  it('never reaches for save(): the full round trip is what destroyed the hotspot credential (OD-19)', async () => {
    const st = { source: 'none', receiving: false };
    const { orch } = harness({ telemetryStatus: () => st });
    const save = vi.fn(() => ({}));
    orch._settingsStore.save = save;
    await orch.start();
    expect(save).not.toHaveBeenCalled();
    expect(orch._settingsStore.patchTelemetrySource).toHaveBeenCalledWith('mapper-grpc');
  });

  it('a credential this computer cannot read stops the write before it starts (OD-19)', async () => {
    // Exactly the two states where a credential EXISTS and could be harmed.
    for (const state of ['undecryptable', 'session-only']) {
      const store = fakeSettingsStore(settingsWith());
      store.credentialStatus = () => ({ state, encryptionAvailable: true, hasPassword: false });
      const { orch } = harness({
        settingsStore: store,
        telemetryStatus: () => ({ source: 'none', receiving: false }),
      });
      const res = await orch.start();
      expect(store.patchTelemetrySource, state).not.toHaveBeenCalled();
      expect(stepOf(res.snapshot, 'telemetry'), state).toMatchObject({ status: 'skipped', kind: 'unavailable' });
      expect(res.snapshot.telemetrySelected, state).toBe(false);
    }
  });

  // OD-19 refinement (2026-09-04): 'unavailable' means nothing is stored AND
  // there is no OS encryption — there is no credential to lose, so refusing the
  // write there only cost the giftee a battery number for nothing.
  it("'unavailable' has nothing to protect, so the write goes ahead (OD-19 refinement)", async () => {
    const store = fakeSettingsStore(settingsWith());
    store.credentialStatus = () => ({ state: 'unavailable', encryptionAvailable: false, hasPassword: false });
    const { orch } = harness({
      settingsStore: store,
      telemetryStatus: () => ({ source: 'none', receiving: false }),
    });
    const res = await orch.start();
    expect(store.patchTelemetrySource).toHaveBeenCalledWith('mapper-grpc');
    expect(stepOf(res.snapshot, 'telemetry').status).toBe('ok');
    expect(res.snapshot.telemetrySelected).toBe(true);
  });

  it('a store that REFUSES the patch is reported, not assumed to have worked', async () => {
    const store = fakeSettingsStore(settingsWith());
    store.patchTelemetrySource = vi.fn(() => ({ ok: false, kind: 'unreadable' }));
    const { orch } = harness({
      settingsStore: store,
      telemetryStatus: () => ({ source: 'none', receiving: false }),
    });
    const res = await orch.start();
    expect(stepOf(res.snapshot, 'telemetry')).toMatchObject({ status: 'skipped', kind: 'unavailable' });
    expect(res.snapshot.telemetrySelected).toBe(false);
    expect(res.ok).toBe(true);
  });

  it('a configured source with no reading yet is ok, and SAYS the car has not spoken', async () => {
    const { orch } = harness({ telemetryStatus: status({ source: 'mapper-grpc', receiving: false }) });
    const res = await orch.start();
    expect(stepOf(res.snapshot, 'telemetry')).toMatchObject({ status: 'ok', kind: 'waiting' });
    // It never fails and never halts: whether the car is switched on is not
    // race day's business.
    expect(res.ok).toBe(true);
    expect(stepOf(res.snapshot, 'bridge').status).not.toBe('pending');
  });

  it("a source chosen on purpose is left alone", async () => {
    for (const source of ['replay', 'crsf-serial']) {
      const store = fakeSettingsStore(settingsWith());
      const { orch } = harness({ settingsStore: store, telemetryStatus: status({ source }) });
      const res = await orch.start();
      expect(stepOf(res.snapshot, 'telemetry'), source).toMatchObject({ status: 'skipped', kind: 'own-source' });
      expect(store.patchTelemetrySource, source).not.toHaveBeenCalled();
    }
  });

  it('a developer setting that pins the source off is reported, not fought', async () => {
    const ap = fakeApplier();
    ap.effective = vi.fn(() => ({ envOverridden: { telemetrySource: true } }));
    const store = fakeSettingsStore(settingsWith());
    const { orch } = harness({ applier: ap, settingsStore: store, telemetryStatus: status({ source: 'none' }) });
    const res = await orch.start();
    expect(stepOf(res.snapshot, 'telemetry')).toMatchObject({ status: 'skipped', kind: 'held-off' });
    expect(store.patchTelemetrySource).not.toHaveBeenCalled();
  });

  it('a failed write does not take the whole bring-up down — the card just says the number stays blank', async () => {
    const { orch } = harness({ telemetryStatus: status({ source: 'none' }) });
    orch._settingsStore.patchTelemetrySource = () => { throw new Error('disk full'); };
    const res = await orch.start();
    expect(res.ok).toBe(true);
    expect(stepOf(res.snapshot, 'telemetry')).toMatchObject({ status: 'skipped', kind: 'unavailable' });
  });

  it('a throwing status seam is treated as "nothing yet", never as a crash', async () => {
    const { orch } = harness({
      telemetryStatus: () => { throw new Error('boom'); },
    });
    const res = await orch.start();
    // A wedged 'pending' step under a green headline is the exact dishonesty
    // race day exists to remove, so the step must still resolve.
    expect(stepOf(res.snapshot, 'telemetry').status).not.toBe('pending');
    expect(res.ok).toBe(true);
  });
});

// --- OD-19: the ONE write race day is allowed to make ------------------------
// Adversarial review, blocking finding 1. The telemetry step used to go through
// the full settingsStore.save() round trip: load() -> normalizeSettings()
// (which DROPS network.hotspot.passwordEnc) -> serialize() (which re-writes it
// only from a plaintext it could decrypt). With a token this computer cannot
// read — a restored settings.json, a changed Windows profile — the plaintext is
// '' and the re-written file carried NO passwordEnc at all: race day, an
// UNATTENDED writer reachable from one giftee press, silently and permanently
// destroyed the saved hotspot password.
//
// The probe below is the reviewer's (scratchpad/rev_gsB_probe4.js) driven
// through the REAL store and the REAL orchestrator, so the regression is pinned
// where the damage happened rather than at the seam.
describe('RaceDayOrchestrator — race day never destroys the saved hotspot password (OD-19)', () => {
  // A safeStorage whose ciphertext is NOT readable on this computer, and whose
  // protect() is deliberately NON-deterministic: any re-encryption round trip
  // shows up as a changed token, so "copied through verbatim" is provable.
  let sealCounter = 0;
  const foreignSafe = ({ decryptable = false } = {}) => ({
    isEncryptionAvailable: () => true,
    encryptString: (s) => {
      sealCounter += 1;
      return Buffer.from(`seal${sealCounter}:${String(s)}`, 'utf8');
    },
    decryptString: (buf) => {
      if (!decryptable) throw new Error('this ciphertext was written by another machine');
      const t = Buffer.from(buf).toString('utf8');
      return t.slice(t.indexOf(':') + 1);
    },
  });

  const seed = (raw) => {
    const dir = mkdtempSync(join(tmpdir(), 'w17-raceday-cred-'));
    writeFileSync(join(dir, 'settings.json'), `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    return dir;
  };
  const onDisk = (store) => JSON.parse(readFileSync(store.file, 'utf8'));

  const SEEDED = (over = {}) => ({
    fpvMode: 'solo',
    network: { kind: 'hotspot', hotspot: { ssid: 'W17-GRID', password: '', passwordEnc: 'w17cred:v1:AAAA' } },
    racePrep: { mapperPath: '/w17/mapper.exe', profilePath: '/w17/w17-ds4.json', autoBridge: false },
    telemetry: { source: 'none', port: '' },
    ...over,
  });

  it('an UNREADABLE saved password survives the telemetry step, byte for byte', async () => {
    const dir = seed(SEEDED());
    const store = createSettingsStore({
      dir,
      credentialStore: createCredentialStore({ safeStorage: foreignSafe() }),
    });
    expect(store.load().network.hotspot.password).toBe('');
    expect(store.credentialStatus().state).toBe('undecryptable');

    const st = { source: 'none', receiving: false };
    const { orch } = harness({ settingsStore: store, telemetryStatus: () => st });
    const res = await orch.start();

    // The one thing that must never happen.
    expect(onDisk(store).network.hotspot.passwordEnc).toBe('w17cred:v1:AAAA');
    // And the operator is told the readings could not be switched on rather
    // than being handed a silent success (OD-19: skip with 'unavailable').
    expect(stepOf(res.snapshot, 'telemetry')).toMatchObject({ status: 'skipped', kind: 'unavailable' });
    expect(res.ok).toBe(true);
  });

  it('a password kept for THIS SESSION only is not written away either', async () => {
    // No OS encryption at all, and a password entered THIS session: the store
    // holds it in memory and disk carries neither plaintext nor a token. Race
    // day must not rewrite the file that would have to carry it.
    const dir = seed(SEEDED({ network: { kind: 'hotspot', hotspot: { ssid: 'W17-GRID', password: '' } } }));
    const store = createSettingsStore({
      dir,
      credentialStore: createCredentialStore({ safeStorage: { isEncryptionAvailable: () => false } }),
    });
    store.save({ network: { hotspot: { password: 'entered-this-session' } } });
    expect(store.credentialStatus().state).toBe('session-only');
    const before = readFileSync(store.file, 'utf8');

    const st = { source: 'none', receiving: false };
    const { orch } = harness({ settingsStore: store, telemetryStatus: () => st });
    const res = await orch.start();

    expect(stepOf(res.snapshot, 'telemetry')).toMatchObject({ status: 'skipped', kind: 'unavailable' });
    expect(readFileSync(store.file, 'utf8')).toBe(before);        // nothing written at all
    expect(onDisk(store).network.hotspot.password).toBe('');      // and never the plaintext
    expect(onDisk(store).telemetry.source).toBe('none');
  });

  // The refined half of the same ruling: nothing stored, no OS encryption. The
  // write proceeds, and it must not invent a credential key on its way through.
  it("with NOTHING stored the write proceeds and invents no credential key (OD-19 refinement)", async () => {
    const dir = seed(SEEDED({ network: { kind: 'hotspot', hotspot: { ssid: 'W17-GRID', password: '' } } }));
    const store = createSettingsStore({
      dir,
      credentialStore: createCredentialStore({ safeStorage: { isEncryptionAvailable: () => false } }),
    });
    store.load();
    expect(store.credentialStatus().state).toBe('unavailable');

    const st = { source: 'none', receiving: false };
    const { orch } = harness({ settingsStore: store, telemetryStatus: () => st });
    const res = await orch.start();

    const after = onDisk(store);
    expect(after.telemetry.source).toBe('mapper-grpc');            // the giftee gets a battery number
    expect(after.network.hotspot.passwordEnc).toBeUndefined();     // no key invented
    expect(after.network.hotspot.password).toBe('');               // and still no plaintext
    expect(after.network.hotspot.ssid).toBe('W17-GRID');
    expect(stepOf(res.snapshot, 'telemetry').status).toBe('ok');
    expect(res.snapshot.telemetrySelected).toBe(true);
  });

  it('with a READABLE credential the source IS written — and the ciphertext is copied through, never re-encrypted', async () => {
    const dir = seed(SEEDED({
      network: { kind: 'hotspot', hotspot: { ssid: 'W17-GRID', password: '', passwordEnc: 'w17cred:v1:c2VhbDA6cHc=' } },
    }));
    // A store that CAN read the token, so the old code path would decrypt and
    // re-encrypt it; the non-deterministic seal makes that visible.
    const store = createSettingsStore({
      dir,
      credentialStore: createCredentialStore({ safeStorage: foreignSafe({ decryptable: true }) }),
    });
    const before = onDisk(store).network.hotspot.passwordEnc;

    const st = { source: 'none', receiving: false };
    const { orch } = harness({ settingsStore: store, telemetryStatus: () => st });
    const res = await orch.start();

    const after = onDisk(store);
    expect(after.telemetry.source).toBe('mapper-grpc');   // the write happened
    expect(after.network.hotspot.passwordEnc).toBe(before); // verbatim, not re-sealed
    expect(after.network.hotspot.password).toBe('');        // still no plaintext on disk
    expect(after.network.hotspot.ssid).toBe('W17-GRID');    // nothing else moved
    expect(after.fpvMode).toBe('solo');
    expect(stepOf(res.snapshot, 'telemetry').status).toBe('ok');
  });

  it('the GARAGE is told the setting changed — and only when it actually did', async () => {
    // No stored Wi-Fi password at all: nothing for the write to endanger, so
    // the guard lets it through and the setting really does change.
    const dir = seed(SEEDED({ network: { kind: 'hotspot', hotspot: { ssid: 'W17-GRID', password: '' } } }));
    const store = createSettingsStore({
      dir,
      credentialStore: createCredentialStore({ safeStorage: foreignSafe({ decryptable: true }) }),
    });
    expect(store.load().network.hotspot.password).toBe('');
    expect(store.credentialStatus().state).toBe('none');
    const st = { source: 'none', receiving: false };
    const { orch } = harness({ settingsStore: store, telemetryStatus: () => st });
    expect(orch.snapshot().telemetrySelected).toBe(false);
    const res = await orch.start();
    expect(res.snapshot.telemetrySelected).toBe(true);

    // A run that changes nothing makes no claim.
    const dir2 = seed(SEEDED({ telemetry: { source: 'crsf-serial', port: '' } }));
    const store2 = createSettingsStore({ dir: dir2 });
    const { orch: orch2 } = harness({
      settingsStore: store2,
      telemetryStatus: () => ({ source: 'crsf-serial', receiving: false }),
    });
    const res2 = await orch2.start();
    expect(res2.snapshot.telemetrySelected).toBe(false);
  });
});
