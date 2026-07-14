// The B1 lifecycle authority (main/hotspotLifecycle.js): the approved runtime
// model INACTIVE -> STARTING -> LIVE -> STOPPING over the real HotspotManager
// with a routed fake runner, plus the N3 capability probe (cached,
// single-flight, refreshable, controlled failure). Ownership rows of the B1
// matrix that live at this level are asserted here; the manager-level rows
// stay pinned in test/hotspot.test.js.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { HotspotManager } = require('../main/hotspot.js');
const { HotspotLifecycle } = require('../main/hotspotLifecycle.js');

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const ok = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '' });
const fail = (stderr = 'boom', stdout = '') => ({ ok: false, code: 1, stdout, stderr });

// Same router pattern as test/hotspot.test.js: needle substring -> response.
function fakeRun(routes) {
  const calls = [];
  const run = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const key = `${cmd} ${args.join(' ')}`;
    for (const [needle, handler] of Object.entries(routes)) {
      if (key.includes(needle)) {
        return typeof handler === 'function' ? handler({ cmd, args, opts }) : handler;
      }
    }
    return fail(`unrouted: ${key.slice(0, 80)}`);
  };
  return { run, calls };
}

const PS_START_KEY = 'StartTetheringAsync';
const PS_STOP_KEY = 'StopTetheringAsync';
const PS_PROBE_KEY = 'PROBE_OK';
const DRIVERS_KEY = 'wlan show drivers';

const probeOk = ok('PROBE_STATE_Off\nPROBE_OK');
const probeNoProfile = { ok: false, code: 2, stdout: 'RESULT_NO_PROFILE', stderr: '' };

const MOBILE_OK_ROUTES = {
  [PS_PROBE_KEY]: probeOk,
  [DRIVERS_KEY]: ok(fixture('netsh_drivers_en.txt')),
  [PS_START_KEY]: ok('START_OK'),
  [PS_STOP_KEY]: ok('STOP_OK'),
};

function build(routes, { manager: managerOverrides } = {}) {
  const { run, calls } = fakeRun(routes);
  const manager = Object.assign(
    new HotspotManager({ run, platform: 'win32' }),
    managerOverrides || {},
  );
  const lifecycle = new HotspotLifecycle({ manager });
  const phases = [];
  lifecycle.onChange((snap) => phases.push(snap.phase));
  return { lifecycle, manager, calls, phases };
}

const CREDS = { ssid: 'W17-GRID', password: 'lights0ut!' };

describe('HotspotLifecycle start/stop (audit B1)', () => {
  it('initial snapshot: INACTIVE, unowned, probe never ran, no error', () => {
    const { lifecycle } = build({});
    expect(lifecycle.snapshot()).toEqual({
      seq: 0, phase: 'inactive', owned: false, backend: null, ssid: '', hostIp: null,
      lastError: null, probe: { status: 'idle' },
    });
  });

  it('snapshots carry a strictly increasing seq so the mirror can drop out-of-order deliveries', async () => {
    // Electron pushes are NOT guaranteed to arrive in emit order (seen in the
    // sim acceptance pass); seq is the causal order the renderer enforces.
    const seqs = [];
    const { lifecycle } = build(MOBILE_OK_ROUTES);
    lifecycle.onChange((snap) => seqs.push(snap.seq));
    await lifecycle.start(CREDS);
    await lifecycle.stop();
    expect(seqs).toEqual([1, 2, 3, 4]); // starting, live, stopping, inactive
    expect(lifecycle.snapshot().seq).toBe(4); // pulls report the last change's seq
  });

  it('mobile start success: STARTING then LIVE, owned, backend/ssid in the snapshot', async () => {
    const { lifecycle, phases } = build(MOBILE_OK_ROUTES);
    const res = await lifecycle.start(CREDS);
    expect(res.ok).toBe(true);
    expect(phases).toEqual(['starting', 'live']);
    expect(lifecycle.snapshot()).toMatchObject({
      phase: 'live', owned: true, backend: 'mobile', ssid: 'W17-GRID', lastError: null,
    });
  });

  it('hosted start success: LIVE and owned via the hosted backend', async () => {
    const { lifecycle } = build({
      [PS_PROBE_KEY]: probeNoProfile,
      [DRIVERS_KEY]: ok(fixture('netsh_drivers_en.txt')),
      'set hostednetwork': ok(),
      'start hostednetwork': ok('The hosted network started.'),
    });
    expect((await lifecycle.start(CREDS)).ok).toBe(true);
    expect(lifecycle.snapshot()).toMatchObject({ phase: 'live', owned: true, backend: 'hosted' });
  });

  it('failed start returns to INACTIVE (never a fake LIVE) with an actionable lastError + suggestion', async () => {
    const { lifecycle, phases } = build({
      [PS_PROBE_KEY]: probeNoProfile,
      [DRIVERS_KEY]: ok(fixture('netsh_drivers_en.txt')),
      'set hostednetwork': ok(),
      'start hostednetwork': fail(fixture('netsh_hosted_start_failed_en.txt')),
      WindowsPrincipal: ok('ELEV_LIMITED'),
    });
    const res = await lifecycle.start(CREDS);
    expect(res.ok).toBe(false);
    expect(phases).toEqual(['starting', 'inactive']);
    const snap = lifecycle.snapshot();
    expect(snap).toMatchObject({ phase: 'inactive', owned: false, backend: null });
    expect(snap.lastError.kind).toBe('start-failed');
    expect(snap.lastError.error).toContain('hostednetwork start failed');
    expect(snap.lastError.suggestion).toMatch(/may require administrator/); // B2 suggestion reaches the mirror
  });

  it('config-mismatch partial start: LIVE + owned + error, ssid NOT claimed (matrix row: owned=Yes)', async () => {
    const { lifecycle } = build({ ...MOBILE_OK_ROUTES, [PS_START_KEY]: ok('START_CONFIG_MISMATCH') });
    const res = await lifecycle.start(CREDS);
    expect(res.ok).toBe(false);
    const snap = lifecycle.snapshot();
    expect(snap).toMatchObject({ phase: 'live', owned: true, backend: 'mobile', ssid: '' });
    expect(snap.lastError.kind).toBe('config-mismatch');
  });

  it('external hotspot already running (START_ALREADY_ON): INACTIVE and NEVER owned (matrix row: No)', async () => {
    const { lifecycle } = build({ ...MOBILE_OK_ROUTES, [PS_START_KEY]: ok('START_ALREADY_ON') });
    await lifecycle.start(CREDS);
    const snap = lifecycle.snapshot();
    expect(snap).toMatchObject({ phase: 'inactive', owned: false });
    expect(snap.lastError.kind).toBe('already-on');
  });

  it('mobile start status failure with no confirmed start: INACTIVE, not owned (matrix row: No)', async () => {
    const { lifecycle } = build({
      ...MOBILE_OK_ROUTES,
      [PS_START_KEY]: ok('START_FAILED_Unknown boom'),
      [DRIVERS_KEY]: ok('    Hosted network supported  : No'),
    });
    await lifecycle.start(CREDS);
    expect(lifecycle.snapshot()).toMatchObject({ phase: 'inactive', owned: false });
  });

  it('stop success: STOPPING then INACTIVE, ownership and error cleared', async () => {
    const { lifecycle, phases } = build(MOBILE_OK_ROUTES);
    await lifecycle.start(CREDS);
    phases.length = 0;
    const res = await lifecycle.stop();
    expect(res.ok).toBe(true);
    expect(phases).toEqual(['stopping', 'inactive']);
    expect(lifecycle.snapshot()).toMatchObject({
      phase: 'inactive', owned: false, backend: null, ssid: '', lastError: null,
    });
  });

  it('failed stop returns to LIVE with ownership retained (matrix row: Yes); retry then succeeds', async () => {
    let stopBroken = true;
    const { lifecycle, phases } = build({
      ...MOBILE_OK_ROUTES,
      [PS_STOP_KEY]: () => (stopBroken ? fail('winrt stop threw') : ok('STOP_OK')),
    });
    await lifecycle.start(CREDS);
    phases.length = 0;
    const res = await lifecycle.stop();
    expect(res).toMatchObject({ ok: false, kind: 'stop-failed' });
    expect(phases).toEqual(['stopping', 'live']);
    const snap = lifecycle.snapshot();
    expect(snap).toMatchObject({ phase: 'live', owned: true, backend: 'mobile' });
    expect(snap.lastError.kind).toBe('stop-failed');
    // Retry after the failed stop — ownership survived, so this must work.
    stopBroken = false;
    expect((await lifecycle.stop()).ok).toBe(true);
    expect(lifecycle.snapshot()).toMatchObject({ phase: 'inactive', owned: false, lastError: null });
  });

  it('duplicate START during STARTING is suppressed: busy result, ONE backend start', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { lifecycle, calls } = build({
      ...MOBILE_OK_ROUTES,
      [PS_START_KEY]: async () => { await gate; return ok('START_OK'); },
    });
    const first = lifecycle.start(CREDS);
    const dup = await lifecycle.start(CREDS);
    expect(dup).toMatchObject({ ok: false, kind: 'busy' });
    expect(dup.error).toContain('in progress');
    release();
    expect((await first).ok).toBe(true);
    expect(calls.filter((c) => c.args.join(' ').includes(PS_START_KEY))).toHaveLength(1);
  });

  it('duplicate STOP during STOPPING is suppressed: busy result, ONE backend stop', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { lifecycle, calls } = build({
      ...MOBILE_OK_ROUTES,
      [PS_STOP_KEY]: async () => { await gate; return ok('STOP_OK'); },
    });
    await lifecycle.start(CREDS);
    const first = lifecycle.stop();
    const dup = await lifecycle.stop();
    expect(dup).toMatchObject({ ok: false, kind: 'busy' });
    release();
    expect((await first).ok).toBe(true);
    expect(calls.filter((c) => c.args.join(' ').includes(PS_STOP_KEY))).toHaveLength(1);
  });

  it('START while LIVE is suppressed (STOP first), and STOP during STARTING is busy', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { lifecycle } = build({
      ...MOBILE_OK_ROUTES,
      [PS_START_KEY]: async () => { await gate; return ok('START_OK'); },
    });
    const first = lifecycle.start(CREDS);
    expect(await lifecycle.stop()).toMatchObject({ ok: false, kind: 'busy' }); // stop during STARTING
    release();
    await first;
    const dup = await lifecycle.start(CREDS);
    expect(dup).toMatchObject({ ok: false, kind: 'busy' });
    expect(dup.error).toContain('STOP HOTSPOT first');
  });

  it('STOP with nothing owned is a no-op: zero backend calls — an external hotspot is never stopped', async () => {
    const { lifecycle, calls } = build(MOBILE_OK_ROUTES);
    expect(await lifecycle.stop()).toEqual({ ok: true, noop: true });
    expect(calls).toHaveLength(0);
  });

  it('a REJECTING manager start becomes a controlled INACTIVE error and leaks no credentials', async () => {
    const { lifecycle } = build({}, {
      manager: {
        start: async () => { throw new Error(`spawn blew up holding "${CREDS.password}"`); },
      },
    });
    const res = await lifecycle.start(CREDS);
    expect(res).toMatchObject({ ok: false, kind: 'ps-error' });
    const snap = lifecycle.snapshot();
    expect(snap).toMatchObject({ phase: 'inactive', owned: false });
    expect(JSON.stringify(snap)).not.toContain(CREDS.password);
    expect(JSON.stringify(res)).not.toContain(CREDS.password);
  });

  it('a REJECTING manager stop keeps LIVE + ownership (controlled stop-failed)', async () => {
    const { lifecycle } = build(MOBILE_OK_ROUTES);
    await lifecycle.start(CREDS);
    lifecycle._manager.stop = async () => { throw new Error('ipc pipe died'); };
    const res = await lifecycle.stop();
    expect(res).toMatchObject({ ok: false, kind: 'stop-failed' });
    expect(lifecycle.snapshot()).toMatchObject({ phase: 'live', owned: true });
  });

  it('snapshots never carry the password across a full start/stop cycle', async () => {
    const seen = [];
    const { lifecycle } = build(MOBILE_OK_ROUTES);
    lifecycle.onChange((snap) => seen.push(JSON.stringify(snap)));
    await lifecycle.start(CREDS);
    await lifecycle.stop();
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(s).not.toContain(CREDS.password);
  });

  it('whenSettled resolves only after the in-flight transition lands (quit-policy seam)', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { lifecycle } = build({
      ...MOBILE_OK_ROUTES,
      [PS_START_KEY]: async () => { await gate; return ok('START_OK'); },
    });
    const start = lifecycle.start(CREDS);
    let settled = false;
    const wait = lifecycle.whenSettled().then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false); // start still in flight
    release();
    await wait;
    expect(lifecycle.snapshot().phase).toBe('live');
    await start;
  });
});

describe('HotspotLifecycle capability probe (audit N3)', () => {
  it('reports probing while in flight, supported + backend when done', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { lifecycle } = build({
      [PS_PROBE_KEY]: async () => { await gate; return probeOk; },
      [DRIVERS_KEY]: ok(fixture('netsh_drivers_en.txt')),
    });
    const p = lifecycle.probe();
    expect(lifecycle.snapshot().probe).toEqual({ status: 'probing' });
    release();
    const res = await p;
    expect(res).toMatchObject({ status: 'supported', backend: 'mobile', externallyActive: false });
    expect(lifecycle.snapshot().probe).toMatchObject({ status: 'supported', backend: 'mobile' });
  });

  it('concurrent probes share ONE PowerShell run; completed results are cached for re-entry', async () => {
    const { lifecycle, calls } = build({
      [PS_PROBE_KEY]: probeOk,
      [DRIVERS_KEY]: ok(fixture('netsh_drivers_en.txt')),
    });
    const [a, b] = await Promise.all([lifecycle.probe(), lifecycle.probe()]);
    expect(a).toEqual(b);
    await lifecycle.probe(); // third entry: cached, no new run
    expect(calls.filter((c) => c.cmd === 'powershell')).toHaveLength(1);
  });

  it('refresh forces a re-probe (the RECHECK path)', async () => {
    const { lifecycle, calls } = build({
      [PS_PROBE_KEY]: probeOk,
      [DRIVERS_KEY]: ok(fixture('netsh_drivers_en.txt')),
    });
    await lifecycle.probe();
    await lifecycle.probe({ refresh: true });
    expect(calls.filter((c) => c.cmd === 'powershell')).toHaveLength(2);
  });

  it('unsupported when no backend exists', async () => {
    const { lifecycle } = build({
      [PS_PROBE_KEY]: probeNoProfile,
      [DRIVERS_KEY]: ok('    Hosted network supported  : No'),
    });
    expect(await lifecycle.probe()).toMatchObject({ status: 'unsupported', backend: null });
  });

  it('a rejecting probe becomes a controlled failed status, retryable via refresh', async () => {
    let broken = true;
    const { lifecycle } = build({}, {
      manager: {
        probeBackends: async () => {
          if (broken) throw new Error('winrt exploded');
          return { canHotspot: true, mobile: true, hosted: true, preferred: 'mobile', mobileState: 'Off' };
        },
      },
    });
    expect(await lifecycle.probe()).toMatchObject({ status: 'failed' });
    expect(lifecycle.snapshot().probe.status).toBe('failed');
    broken = false;
    expect(await lifecycle.probe({ refresh: true })).toMatchObject({ status: 'supported' });
  });

  it('detects an externally active hotspot (WinRT already On, not ours) — shown, never owned', async () => {
    const { lifecycle } = build({
      [PS_PROBE_KEY]: ok('PROBE_STATE_On\nPROBE_OK'),
      [DRIVERS_KEY]: ok(fixture('netsh_drivers_en.txt')),
    });
    const res = await lifecycle.probe();
    expect(res).toMatchObject({ status: 'supported', externallyActive: true, mobileState: 'On' });
    expect(lifecycle.snapshot().owned).toBe(false);
  });

  it('a hotspot WE own is not "externally active" even while WinRT reports On', async () => {
    const { lifecycle } = build({
      ...MOBILE_OK_ROUTES,
      [PS_PROBE_KEY]: ok('PROBE_STATE_On\nPROBE_OK'), // On because OUR start succeeded
    });
    await lifecycle.start(CREDS); // ownership set by the successful start
    const res = await lifecycle.probe({ refresh: true });
    expect(lifecycle.snapshot().owned).toBe(true);
    expect(res.externallyActive).toBe(false);
  });

  it('probe transitions emit change notifications (probing -> done)', async () => {
    const { lifecycle } = build({
      [PS_PROBE_KEY]: probeOk,
      [DRIVERS_KEY]: ok(fixture('netsh_drivers_en.txt')),
    });
    const stages = [];
    lifecycle.onChange((snap) => stages.push(snap.probe.status));
    await lifecycle.probe();
    expect(stages).toEqual(['probing', 'supported']);
  });
});
