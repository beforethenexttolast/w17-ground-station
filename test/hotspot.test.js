import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { HotspotManager } = require('../main/hotspot.js');

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const ok = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '' });
const fail = (stderr = 'boom', stdout = '') => ({ ok: false, code: 1, stdout, stderr });

// Router keyed on command + leading args; records calls (incl. env opts).
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

// PowerShell scripts are routed by the marker strings they emit/contain.
const PS_PROBE_KEY = "Write-Output 'TETHER_OK'";
const PS_START_KEY = 'StartTetheringAsync';
const PS_STOP_KEY = 'StopTetheringAsync';
const DRIVERS_KEY = 'wlan show drivers';

function manager(routes, platform = 'win32') {
  const { run, calls } = fakeRun(routes);
  return { hs: new HotspotManager({ run, platform }), calls };
}

describe('HotspotManager.probeBackends', () => {
  it('non-Windows: nothing available, nothing spawned', async () => {
    const { hs, calls } = manager({}, 'darwin');
    expect(await hs.probeBackends())
      .toEqual({ canHotspot: false, mobile: false, hosted: false, preferred: null });
    expect(calls).toHaveLength(0);
  });

  it('tethering profile + RT5370 drivers: prefers the mobile backend', async () => {
    const { hs } = manager({
      [PS_PROBE_KEY]: ok('TETHER_OK'),
      [DRIVERS_KEY]: ok(fixture('netsh_drivers_en.txt')),
    });
    expect(await hs.probeBackends())
      .toEqual({ canHotspot: true, mobile: true, hosted: true, preferred: 'mobile' });
  });

  it('no tetherable profile falls back to hostednetwork; unknown drivers still count as worth trying', async () => {
    const noProfile = { [PS_PROBE_KEY]: { ok: false, code: 2, stdout: 'NO_PROFILE', stderr: '' } };
    const withYes = manager({ ...noProfile, [DRIVERS_KEY]: ok(fixture('netsh_drivers_en.txt')) });
    expect((await withYes.hs.probeBackends()).preferred).toBe('hosted');
    const withUnknown = manager({ ...noProfile, [DRIVERS_KEY]: ok('nothing relevant') });
    expect((await withUnknown.hs.probeBackends()).preferred).toBe('hosted');
  });

  it('neither backend: canHotspot false', async () => {
    const { hs } = manager({
      [PS_PROBE_KEY]: fail(),
      [DRIVERS_KEY]: ok('    Unterstützte gehostete Netzwerke  : Nein'),
    });
    expect(await hs.probeBackends())
      .toEqual({ canHotspot: false, mobile: false, hosted: false, preferred: null });
  });
});

describe('HotspotManager.start', () => {
  const probeMobileOk = {
    [PS_PROBE_KEY]: ok('TETHER_OK'),
    [DRIVERS_KEY]: ok(fixture('netsh_drivers_en.txt')),
  };

  it('rejects WPA2-invalid passwords before touching the OS', async () => {
    const { hs, calls } = manager({});
    expect((await hs.start({ ssid: 'W17-GRID', password: 'short' })).error).toMatch(/8\+/);
    expect(calls).toHaveLength(0);
  });

  it('mobile backend success — SSID/password ride ENV, never the script text', async () => {
    let startCall = null;
    const { hs } = manager({
      ...probeMobileOk,
      [PS_START_KEY]: (c) => { startCall = c; return ok('START_Success'); },
    });
    const res = await hs.start({ ssid: 'W17-GRID', password: 'lights0ut!' });
    expect(res.ok).toBe(true);
    expect(res.method).toBe('mobile');
    expect(startCall.opts.env).toEqual({ W17_HOTSPOT_SSID: 'W17-GRID', W17_HOTSPOT_PASS: 'lights0ut!' });
    expect(startCall.args.join(' ')).not.toContain('lights0ut!'); // no injection surface
  });

  it('mobile refusal falls back to hostednetwork', async () => {
    const { hs, calls } = manager({
      ...probeMobileOk,
      [PS_START_KEY]: ok('START_EntitlementCheckFailure'),
      'set hostednetwork': ok(),
      'start hostednetwork': ok('The hosted network started.'),
    });
    const res = await hs.start({ ssid: 'W17-GRID', password: 'lights0ut!' });
    expect(res).toMatchObject({ ok: true, method: 'hosted', ssid: 'W17-GRID' });
    const setArgs = calls.find((c) => c.args.includes('set')).args;
    expect(setArgs).toContain('ssid=W17-GRID'); // argv element, not shell string
    expect(setArgs).toContain('key=lights0ut!');
  });

  it('hostednetwork access-denied is reported as an elevation requirement', async () => {
    const { hs } = manager({
      [PS_PROBE_KEY]: fail(),
      [DRIVERS_KEY]: ok(fixture('netsh_drivers_en.txt')),
      'set hostednetwork': ok(),
      'start hostednetwork': fail('You do not have permission. Access is denied.'),
    });
    const res = await hs.start({ ssid: 'W17-GRID', password: 'lights0ut!' });
    expect(res.ok).toBe(false);
    expect(res.needsElevation).toBe(true);
    expect(res.error).toMatch(/administrator/);
  });

  it('no backend available: actionable message, join-a-network escape hatch', async () => {
    const { hs } = manager({
      [PS_PROBE_KEY]: fail(),
      [DRIVERS_KEY]: ok('    Hosted network supported  : No'),
    });
    const res = await hs.start({ ssid: 'W17-GRID', password: 'lights0ut!' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/join a network instead/);
  });
});

describe('HotspotManager.stop', () => {
  it('stops via the backend that actually started; no-op when never started', async () => {
    const idle = manager({});
    expect(await idle.hs.stop()).toEqual({ ok: true });
    expect(idle.calls).toHaveLength(0);

    const { hs, calls } = manager({
      [PS_PROBE_KEY]: fail(),
      [DRIVERS_KEY]: ok(fixture('netsh_drivers_en.txt')),
      'set hostednetwork': ok(),
      'start hostednetwork': ok(),
      'stop hostednetwork': ok(),
    });
    await hs.start({ ssid: 'W17-GRID', password: 'lights0ut!' });
    expect((await hs.stop()).ok).toBe(true);
    expect(calls.some((c) => c.args.join(' ').includes('stop hostednetwork'))).toBe(true);
    expect(calls.some((c) => `${c.cmd} ${c.args.join(' ')}`.includes(PS_STOP_KEY))).toBe(false);
  });
});
