import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ElrsLauncher } = require('../main/elrsLauncher.js');

const ok = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '' });

function launcher(result, platform) {
  const calls = [];
  const run = async (cmd, args) => { calls.push({ cmd, args }); return result; };
  return { elrs: new ElrsLauncher({ run, platform }), calls };
}

// Fake child seam: NO real process is ever spawned in this suite (workspace
// rule — the launcher's real child is the control path itself). A REAL
// EventEmitter, so an 'error' emit with no listener THROWS exactly as it does
// in production — that is what makes the correctness-3 test below a genuine
// regression proof rather than a restatement of the fix.
function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.unref = vi.fn();
  return child;
}

// A launcher whose spawn + existence checks are faked, so the spawn OPTIONS can
// be inspected without starting anything.
function spawnHarness({ env, exists = true } = {}) {
  const spawned = [];
  let child = null;
  const logs = [];
  const elrs = new ElrsLauncher({
    platform: 'win32',
    existsSync: () => exists,
    log: (m) => logs.push(m),
    env,
    spawnFn: (bin, argv, opts) => {
      child = fakeChild();
      spawned.push({ bin, argv, opts, child });
      return child;
    },
  });
  return { elrs, spawned, logs, child: () => child };
}

describe('ElrsLauncher.detectRunning', () => {
  it('no path configured: not configured, nothing spawned', async () => {
    const { elrs, calls } = launcher(ok(), 'win32');
    expect(await elrs.detectRunning('')).toEqual({ configured: false, detected: false });
    expect(calls).toHaveLength(0);
  });

  it('win32 detects via tasklist image-name filter (CSV rows)', async () => {
    const csv = '"elrs-joystick-control.exe","4242","Console","1","58,124 K"';
    const { elrs, calls } = launcher(ok(csv), 'win32');
    const res = await elrs.detectRunning('C:\\Tools\\elrs\\elrs-joystick-control.exe');
    expect(res).toEqual({ configured: true, detected: true, method: 'tasklist' });
    expect(calls[0].cmd).toBe('tasklist');
    expect(calls[0].args).toContain('IMAGENAME eq elrs-joystick-control.exe');
  });

  it('the localized "no tasks" sentence counts as not running', async () => {
    const { elrs } = launcher(ok('INFO: No tasks are running which match the specified criteria.'), 'win32');
    expect((await elrs.detectRunning('C:\\x\\elrs-joystick-control.exe')).detected).toBe(false);
  });

  it('non-Windows detects via pgrep -f on the basename', async () => {
    const { elrs, calls } = launcher(ok('1234\n'), 'darwin');
    const res = await elrs.detectRunning('/opt/elrs/elrs-joystick-control');
    expect(res).toEqual({ configured: true, detected: true, method: 'pgrep' });
    expect(calls[0].cmd).toBe('pgrep');
    expect(calls[0].args).toEqual(['-f', 'elrs-joystick-control']);
  });
});

describe('ElrsLauncher.launchDetached guard paths (no real spawn)', () => {
  it('refuses without a configured path', () => {
    const { elrs } = launcher(ok(), 'darwin');
    expect(elrs.launchDetached('').ok).toBe(false);
    expect(elrs.launchDetached('').error).toMatch(/no elrs/);
  });

  it('refuses a path that does not exist', () => {
    const { elrs } = launcher(ok(), 'darwin');
    const res = elrs.launchDetached('/definitely/not/here/elrs.exe');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/);
  });
});

// --- review boundaries-4/5: the GRID convenience LAUNCH starts the SAME program
// race day manages, and race day adopts an externally-launched instance as
// ok/'external'. An un-scrubbed launch here would therefore survive as race
// day's drive program, carrying exactly the W17_* flags the argv whitelist
// refuses to pass. ------------------------------------------------------------

describe('ElrsLauncher.launchDetached — child environment (boundaries-4/5)', () => {
  it("the launched child carries NO W17_* variable, in any letter case", () => {
    const { elrs, spawned } = spawnHarness({
      env: {
        PATH: 'C:\\Windows\\System32',
        SystemRoot: 'C:\\Windows',
        W17_HEADTRACK_INGEST: '1',
        w17_headtrack_ingest: '1',
        W17_HeadTrack_Ingest: '1',
        W17_ANY_FUTURE_KNOB: 'x',
      },
    });
    expect(elrs.launchDetached('C:\\Tools\\elrs\\elrs-joystick-control.exe')).toEqual({ ok: true });
    const opts = spawned[0].opts;
    // An env option MUST be present — its ABSENCE is the bug (full inheritance).
    expect(opts.env).toBeDefined();
    expect(Object.keys(opts.env).filter((k) => k.toUpperCase().startsWith('W17_'))).toEqual([]);
    // Everything else the program needs still passes through.
    expect(opts.env.PATH).toBe('C:\\Windows\\System32');
    expect(opts.env.SystemRoot).toBe('C:\\Windows');
  });

  it("the rest of the deliberate 'launch it like a human would' contract is unchanged", () => {
    const { elrs, spawned, child } = spawnHarness({ env: { PATH: '/usr/bin' } });
    elrs.launchDetached('/opt/elrs/elrs-joystick-control');
    const { opts } = spawned[0];
    expect(opts.detached).toBe(true);      // it outlives this viewer
    expect(opts.stdio).toBe('ignore');     // no pipes, no handle to talk through
    expect(opts.windowsHide).toBe(false);  // it has its own UI/console — let it show
    expect(opts.cwd).toBe('/opt/elrs');
    expect(child().unref).toHaveBeenCalled();
  });
});

// --- review correctness-3 (re-opened; the same shape as correctness-4 on the
// mediamtx supervisor): spawn() returns cleanly and reports a START failure
// asynchronously. An 'error' event with no listener is an uncaught exception,
// so the try/catch around spawn does not cover it and the GRID's convenience
// button would take the whole viewer down. ------------------------------------

describe('ElrsLauncher.launchDetached — asynchronous spawn failure (correctness-3)', () => {
  it('a present-but-unrunnable program is handled, not thrown, and is reported as not running', () => {
    const { elrs, spawned, logs } = spawnHarness({ env: { PATH: '/usr/bin' } });
    // existsSync passed (the file IS there) — this is the quarantined /
    // wrong-arch / EACCES case that only surfaces after spawn returns.
    expect(elrs.launchDetached('C:\\Tools\\elrs\\elrs-joystick-control.exe')).toEqual({ ok: true });
    const err = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
    expect(() => spawned[0].child.emit('error', err)).not.toThrow();
    expect(logs.join('\n')).toMatch(/could not start .*\(EACCES\); it is not running/);
  });

  it('the launcher still keeps no handle on the child: no kill/stop path is introduced', () => {
    const { elrs } = spawnHarness({ env: {} });
    expect(elrs.stop).toBeUndefined();
    expect(elrs.kill).toBeUndefined();
    expect(elrs.restart).toBeUndefined();
  });
});
