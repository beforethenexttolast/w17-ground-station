import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ElrsLauncher } = require('../main/elrsLauncher.js');

const ok = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '' });

function launcher(result, platform) {
  const calls = [];
  const run = async (cmd, args) => { calls.push({ cmd, args }); return result; };
  return { elrs: new ElrsLauncher({ run, platform }), calls };
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
