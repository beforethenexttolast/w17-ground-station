import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { HotspotManager, PS_SCRIPTS } = require('../main/hotspot.js');

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const ok = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '' });
const fail = (stderr = 'boom', stdout = '') => ({ ok: false, code: 1, stdout, stderr });

// Router keyed on command + leading args; records calls (incl. env opts). The
// PowerShell scripts are matched by unique marker substrings in their text.
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

// Marker substrings unique to each fail-closed script (see main/hotspot.js).
const PS_START_KEY = 'StartTetheringAsync';
const PS_STOP_KEY = 'StopTetheringAsync';
const PS_PROBE_KEY = 'PROBE_OK'; // present only in the probe script
const DRIVERS_KEY = 'wlan show drivers';

// New token vocabulary the manager keys on.
const probeOk = ok('PROBE_STATE_Off\nPROBE_OK');
const probeNoProfile = { ok: false, code: 2, stdout: 'RESULT_NO_PROFILE', stderr: '' };
const startOk = ok('START_OK');
const stopOk = ok('STOP_OK');

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

  it('tethering profile + RT5370 drivers: prefers mobile, exposes the WinRT state', async () => {
    const { hs } = manager({
      [PS_PROBE_KEY]: probeOk,
      [DRIVERS_KEY]: ok(fixture('netsh_drivers_en.txt')),
    });
    const res = await hs.probeBackends();
    expect(res).toMatchObject({ canHotspot: true, mobile: true, hosted: true, preferred: 'mobile' });
    expect(res.mobileState).toBe('Off');
  });

  it('no tetherable profile falls back to hostednetwork; unknown drivers still count as worth trying', async () => {
    const noProfile = { [PS_PROBE_KEY]: probeNoProfile };
    const withYes = manager({ ...noProfile, [DRIVERS_KEY]: ok(fixture('netsh_drivers_en.txt')) });
    expect((await withYes.hs.probeBackends()).preferred).toBe('hosted');
    const withUnknown = manager({ ...noProfile, [DRIVERS_KEY]: ok('nothing relevant') });
    expect((await withUnknown.hs.probeBackends()).preferred).toBe('hosted');
  });

  it('neither backend: canHotspot false', async () => {
    const { hs } = manager({
      [PS_PROBE_KEY]: probeNoProfile,
      [DRIVERS_KEY]: ok('    Unterstützte gehostete Netzwerke  : Nein'),
    });
    expect(await hs.probeBackends())
      .toMatchObject({ canHotspot: false, mobile: false, hosted: false, preferred: null });
  });
});

describe('HotspotManager.start', () => {
  const probeMobileOk = {
    [PS_PROBE_KEY]: probeOk,
    [DRIVERS_KEY]: ok(fixture('netsh_drivers_en.txt')),
  };

  it('rejects WPA2-invalid passwords before touching the OS', async () => {
    const { hs, calls } = manager({});
    const res = await hs.start({ ssid: 'W17-GRID', password: 'short' });
    expect(res.ok).toBe(false);
    expect(res.kind).toBe('config-failed');
    expect(res.error).toMatch(/8\+/);
    expect(calls).toHaveLength(0);
  });

  it('mobile backend success — SSID/password ride ENV, never the script text; ownership set', async () => {
    let startCall = null;
    const { hs } = manager({
      ...probeMobileOk,
      [PS_START_KEY]: (c) => { startCall = c; return startOk; },
    });
    const res = await hs.start({ ssid: 'W17-GRID', password: 'lights0ut!' });
    expect(res).toMatchObject({ ok: true, method: 'mobile', ssid: 'W17-GRID' });
    expect(startCall.opts.env).toEqual({ W17_HOTSPOT_SSID: 'W17-GRID', W17_HOTSPOT_PASS: 'lights0ut!' });
    expect(startCall.args.join(' ')).not.toContain('lights0ut!'); // no injection surface
    expect(hs.active()).toBe('mobile');
  });

  it('START_ALREADY_ON: not ours — no ownership, no fallback, actionable message', async () => {
    const { hs, calls } = manager({
      ...probeMobileOk,
      [PS_START_KEY]: ok('START_ALREADY_ON'),
      'set hostednetwork': ok(), // must NOT be reached
      'start hostednetwork': ok('The hosted network started.'),
    });
    const res = await hs.start({ ssid: 'W17-GRID', password: 'lights0ut!' });
    expect(res).toMatchObject({ ok: false, kind: 'already-on', fallback: false });
    expect(hs.active()).toBeNull();
    // Fail-closed: it never fell through to the hosted backend.
    expect(calls.some((c) => c.args.join(' ').includes('start hostednetwork'))).toBe(false);
  });

  it('START_CONFIG_MISMATCH: we own it (for STOP/retry) and do NOT fall back', async () => {
    const { hs, calls } = manager({
      ...probeMobileOk,
      [PS_START_KEY]: ok('START_CONFIG_MISMATCH'),
      'set hostednetwork': ok(),
      'start hostednetwork': ok(),
    });
    const res = await hs.start({ ssid: 'W17-GRID', password: 'lights0ut!' });
    expect(res).toMatchObject({ ok: false, kind: 'config-mismatch', fallback: false });
    expect(hs.active()).toBe('mobile'); // ownership retained so the UI can STOP it
    expect(calls.some((c) => c.args.join(' ').includes('start hostednetwork'))).toBe(false);
  });

  it('mobile config failure falls back to hostednetwork when available', async () => {
    const { hs, calls } = manager({
      ...probeMobileOk,
      [PS_START_KEY]: ok('START_CONFIG_FAILED some winrt error'),
      'set hostednetwork': ok(),
      'start hostednetwork': ok('The hosted network started.'),
    });
    const res = await hs.start({ ssid: 'W17-GRID', password: 'lights0ut!' });
    expect(res).toMatchObject({ ok: true, method: 'hosted', ssid: 'W17-GRID' });
    const setArgs = calls.find((c) => c.args.includes('set')).args;
    expect(setArgs).toContain('ssid=W17-GRID'); // argv element, not shell string
    expect(setArgs).toContain('key=lights0ut!');
    expect(hs.active()).toBe('hosted');
  });

  it('mobile config failure with NO hosted backend surfaces the real mobile failure', async () => {
    const { hs } = manager({
      [PS_PROBE_KEY]: probeOk,
      [DRIVERS_KEY]: ok('    Hosted network supported  : No'),
      [PS_START_KEY]: ok('START_CONFIG_FAILED some winrt error'),
    });
    const res = await hs.start({ ssid: 'W17-GRID', password: 'lights0ut!' });
    expect(res).toMatchObject({ ok: false, kind: 'config-failed' });
    expect(hs.active()).toBeNull();
  });

  it('mobile and hosted failures carry a stable backend tag so the classes stay distinguishable', async () => {
    const mobileFail = manager({
      ...probeMobileOk,
      [PS_START_KEY]: ok('START_FAILED_Unknown detail'),
      [DRIVERS_KEY]: ok('    Hosted network supported  : No'),
    });
    expect(await mobileFail.hs.start({ ssid: 'W17-GRID', password: 'lights0ut!' }))
      .toMatchObject({ ok: false, kind: 'start-failed', backend: 'mobile' });
    const hostedFail = manager({
      [PS_PROBE_KEY]: probeNoProfile,
      [DRIVERS_KEY]: ok(fixture('netsh_drivers_en.txt')),
      'set hostednetwork': fail('boom'),
    });
    expect(await hostedFail.hs.start({ ssid: 'W17-GRID', password: 'lights0ut!' }))
      .toMatchObject({ ok: false, kind: 'config-failed', backend: 'hosted' });
  });

  it('no backend available: actionable message, join-a-network escape hatch', async () => {
    const { hs } = manager({
      [PS_PROBE_KEY]: probeNoProfile,
      [DRIVERS_KEY]: ok('    Hosted network supported  : No'),
    });
    const res = await hs.start({ ssid: 'W17-GRID', password: 'lights0ut!' });
    expect(res).toMatchObject({ ok: false, kind: 'unsupported' });
    expect(res.error).toMatch(/join a network instead/);
  });

  it('never echoes the password into any result string', async () => {
    const { hs } = manager({
      ...probeMobileOk,
      [PS_START_KEY]: ok('START_FAILED_Unknown extra detail'),
      [DRIVERS_KEY]: ok('    Hosted network supported  : No'),
    });
    const res = await hs.start({ ssid: 'W17-GRID', password: 'lights0ut!' });
    expect(JSON.stringify(res)).not.toContain('lights0ut!');
  });
});

// B2: a hostednetwork start failure exposes no locale-neutral CAUSE, so the
// class stays a generic 'start-failed' in EVERY locale; the administrator
// hint is a SUGGESTION driven by the structured elevation token (PS_ELEV),
// never by matching localized error prose.
describe('hosted start failure classification (audit B2 — locale-neutral)', () => {
  const ELEV_KEY = 'WindowsPrincipal'; // unique to the PS_ELEV script text
  const hostedOnly = {
    [PS_PROBE_KEY]: probeNoProfile,
    [DRIVERS_KEY]: ok(fixture('netsh_drivers_en.txt')),
    'set hostednetwork': ok(),
  };
  const startHosted = (routes) =>
    manager(routes).hs.start({ ssid: 'W17-GRID', password: 'lights0ut!' });

  it('EN failure text + non-elevated process: generic start-failed with the admin hint as a MAY-suggestion', async () => {
    const res = await startHosted({
      ...hostedOnly,
      'start hostednetwork': fail(fixture('netsh_hosted_start_failed_en.txt')),
      [ELEV_KEY]: ok('ELEV_LIMITED'),
    });
    expect(res).toMatchObject({ ok: false, kind: 'start-failed', backend: 'hosted', elevated: false });
    expect(res.suggestion).toMatch(/may require administrator privileges/);
    expect(res.suggestion).not.toMatch(/needs elevation|must run|definitely/i); // suggestion, not diagnosis
    expect(res.error).toContain('Access is denied.'); // sanitized raw detail retained for diagnostics
  });

  it('non-English (DE) failure text produces the SAME category and suggestion — no prose is matched', async () => {
    const res = await startHosted({
      ...hostedOnly,
      'start hostednetwork': fail(fixture('netsh_hosted_start_failed_de.txt')),
      [ELEV_KEY]: ok('ELEV_LIMITED'),
    });
    // The DE text contains NONE of the old regex's keywords; classification
    // must be identical to the EN case anyway.
    expect(res).toMatchObject({ ok: false, kind: 'start-failed', backend: 'hosted', elevated: false });
    expect(res.suggestion).toMatch(/may require administrator privileges/);
    expect(res.error).toContain('Zugriff'); // localized detail kept for diagnostics only
  });

  it('an already-elevated process gets the failure WITHOUT the admin suggestion (elevation ruled out)', async () => {
    const res = await startHosted({
      ...hostedOnly,
      'start hostednetwork': fail(fixture('netsh_hosted_start_failed_en.txt')),
      [ELEV_KEY]: ok('ELEV_ADMIN'),
    });
    expect(res).toMatchObject({ ok: false, kind: 'start-failed', backend: 'hosted', elevated: true });
    expect(res.suggestion).toBeUndefined();
  });

  it('a broken elevation check keeps the generic suggestion (elevated: null — unknown, not asserted)', async () => {
    const res = await startHosted({
      ...hostedOnly,
      'start hostednetwork': fail('whatever locale'),
      [ELEV_KEY]: fail('powershell unavailable'),
    });
    expect(res).toMatchObject({ ok: false, kind: 'start-failed', backend: 'hosted', elevated: null });
    expect(res.suggestion).toMatch(/may require administrator privileges/);
  });

  it('a failed hosted FALLBACK carries the mobile failure it superseded (fallbackFrom)', async () => {
    const res = await startHosted({
      [PS_PROBE_KEY]: probeOk,
      [DRIVERS_KEY]: ok(fixture('netsh_drivers_en.txt')),
      [PS_START_KEY]: ok('START_CONFIG_FAILED winrt refused'),
      'set hostednetwork': ok(),
      'start hostednetwork': fail(fixture('netsh_hosted_start_failed_en.txt')),
      [ELEV_KEY]: ok('ELEV_LIMITED'),
    });
    expect(res).toMatchObject({ ok: false, kind: 'start-failed', backend: 'hosted' });
    expect(res.fallbackFrom).toMatchObject({ kind: 'config-failed' });
    expect(res.fallbackFrom.error).toContain('winrt refused');
  });

  it('never echoes the password through the hosted failure path (error, suggestion, fallbackFrom)', async () => {
    const res = await startHosted({
      [PS_PROBE_KEY]: probeOk,
      [DRIVERS_KEY]: ok(fixture('netsh_drivers_en.txt')),
      [PS_START_KEY]: ok('START_CONFIG_FAILED nope'),
      'set hostednetwork': ok(),
      'start hostednetwork': fail('kaputt'),
      [ELEV_KEY]: fail('kaputt'),
    });
    expect(JSON.stringify(res)).not.toContain('lights0ut!');
  });

  it('the source contains no English-only elevation regex (the L1 defect stays dead)', () => {
    const src = readFileSync(new URL('../main/hotspot.js', import.meta.url), 'utf8');
    expect(src).not.toContain('denied|elevat');
    expect(src).not.toContain('needsElevation');
    expect(src).not.toMatch(/toLowerCase\(\)/); // no case-folded prose matching anywhere
  });
});

describe('HotspotManager.stop (ownership — audit N2)', () => {
  it('no-op when never started', async () => {
    const idle = manager({});
    expect(await idle.hs.stop()).toEqual({ ok: true });
    expect(idle.calls).toHaveLength(0);
  });

  it('stops via the backend that started; ownership cleared only after success', async () => {
    const { hs, calls } = manager({
      [PS_PROBE_KEY]: probeNoProfile,
      [DRIVERS_KEY]: ok(fixture('netsh_drivers_en.txt')),
      'set hostednetwork': ok(),
      'start hostednetwork': ok(),
      'stop hostednetwork': ok(),
    });
    await hs.start({ ssid: 'W17-GRID', password: 'lights0ut!' });
    expect(hs.active()).toBe('hosted');
    expect((await hs.stop()).ok).toBe(true);
    expect(hs.active()).toBeNull();
    expect(calls.some((c) => c.args.join(' ').includes('stop hostednetwork'))).toBe(true);
    expect(calls.some((c) => `${c.cmd} ${c.args.join(' ')}`.includes(PS_STOP_KEY))).toBe(false);
  });

  it('a FAILED stop retains ownership so the UI can retry (no false INACTIVE)', async () => {
    const { hs } = manager({
      ...{ [PS_PROBE_KEY]: probeOk, [DRIVERS_KEY]: ok(fixture('netsh_drivers_en.txt')) },
      [PS_START_KEY]: startOk,
      [PS_STOP_KEY]: fail('winrt stop threw'),
    });
    await hs.start({ ssid: 'W17-GRID', password: 'lights0ut!' });
    expect(hs.active()).toBe('mobile');
    const res = await hs.stop();
    expect(res).toMatchObject({ ok: false, kind: 'stop-failed', backend: 'mobile' });
    expect(hs.active()).toBe('mobile'); // ownership retained → retry possible
  });

  it('mobile stop succeeds only on the STOP_OK token', async () => {
    const { hs } = manager({
      ...{ [PS_PROBE_KEY]: probeOk, [DRIVERS_KEY]: ok(fixture('netsh_drivers_en.txt')) },
      [PS_START_KEY]: startOk,
      [PS_STOP_KEY]: stopOk,
    });
    await hs.start({ ssid: 'W17-GRID', password: 'lights0ut!' });
    expect((await hs.stop()).ok).toBe(true);
    expect(hs.active()).toBeNull();
  });
});

// H1: static structure assertions over the generated PowerShell. These prove
// the fail-closed shape without executing WinRT (bench-only — §3 checklist).
describe('fail-closed PowerShell structure (audit H1)', () => {
  const { probe, start, stop, elev } = PS_SCRIPTS;

  it('every script sets strict error handling and loads the WinRT assembly', () => {
    for (const s of [probe, start, stop]) {
      expect(s).toContain("$ErrorActionPreference = 'Stop'");
      expect(s).toContain('Add-Type -AssemblyName System.Runtime.WindowsRuntime');
      expect(s).toContain('GetInternetConnectionProfile');
      expect(s).toContain("Write-Output 'RESULT_NO_PROFILE'");
    }
  });

  it('defines both awaiters — generic Await and non-generic AwaitAction', () => {
    for (const s of [probe, start, stop]) {
      expect(s).toContain('function Await(');
      expect(s).toContain('function AwaitAction(');
      // Await targets IAsyncOperation`1; AwaitAction targets IAsyncAction.
      expect(s).toContain("IAsyncOperation`1");
      expect(s).toContain("IAsyncAction");
    }
  });

  it('configure uses AwaitAction (IAsyncAction), start uses the generic Await', () => {
    // ConfigureAccessPointAsync returns IAsyncAction — it must go through
    // AwaitAction, never the generic Await, or it throws on real Windows.
    expect(start).toMatch(/AwaitAction \(\$manager\.ConfigureAccessPointAsync/);
    expect(start).toMatch(/Await \(\$manager\.StartTetheringAsync\(\)\) \(\[/);
  });

  it('a configuration failure exits BEFORE StartTetheringAsync is ever invoked', () => {
    const configFailExit = start.indexOf('exit 3');
    const startInvoke = start.indexOf('StartTetheringAsync');
    expect(configFailExit).toBeGreaterThan(0);
    expect(configFailExit).toBeLessThan(startInvoke); // fail-closed ordering
  });

  it('the success token is printed only after the SSID readback check', () => {
    expect(start.indexOf('START_CONFIG_MISMATCH')).toBeLessThan(start.indexOf("'START_OK'"));
    expect(start.indexOf('StartTetheringAsync')).toBeLessThan(start.indexOf("'START_OK'"));
  });

  it('reads credentials from env only, never interpolated, and uses no double quotes (argv-safe)', () => {
    expect(start).toContain('$env:W17_HOTSPOT_SSID');
    expect(start).toContain('$env:W17_HOTSPOT_PASS');
    for (const s of [probe, start, stop, elev]) {
      expect(s).not.toContain('"'); // single-quote-only → spawn argv can't corrupt it
    }
  });

  it('the elevation check (audit B2) is strict, token-based, and asks the OS — not the error text', () => {
    expect(elev).toContain("$ErrorActionPreference = 'Stop'");
    expect(elev).toContain('WindowsPrincipal');
    expect(elev).toContain('IsInRole');
    expect(elev).toContain("Write-Output 'ELEV_ADMIN'");
    expect(elev).toContain("Write-Output 'ELEV_LIMITED'");
    expect(elev).toContain('ELEV_ERROR'); // its own failures are a token too, not silence
  });
});
