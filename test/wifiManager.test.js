import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WifiManager } = require('../main/wifiManager.js');

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const ok = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '' });
const fail = (stderr = 'boom') => ({ ok: false, code: 1, stdout: '', stderr });

// Fake command runner: routes on the netsh subcommand, records every call.
function fakeRun(routes) {
  const calls = [];
  const run = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const key = args.slice(0, 3).join(' ');
    for (const [prefix, handler] of Object.entries(routes)) {
      if (key.startsWith(prefix)) {
        return typeof handler === 'function' ? handler({ cmd, args, opts, calls }) : handler;
      }
    }
    return fail(`unrouted: ${cmd} ${args.join(' ')}`);
  };
  return { run, calls };
}

// The join loop's 20 s deadline uses Date.now(); fake the clock and let the
// injected sleep advance it so timeout paths run instantly.
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1_000_000); });
afterEach(() => { vi.useRealTimers(); });
const fakeSleep = async (ms) => { vi.setSystemTime(Date.now() + ms); };

function manager(routes, platform = 'win32') {
  const { run, calls } = fakeRun(routes);
  const wifi = new WifiManager({
    tmpDir: mkdtempSync(join(tmpdir(), 'w17-wifi-')),
    run, platform, sleep: fakeSleep,
  });
  return { wifi, calls };
}

describe('WifiManager.capabilities / non-Windows guardrails', () => {
  it('win32 can scan and join; others cannot and never spawn', async () => {
    expect(new WifiManager({ platform: 'win32' }).capabilities())
      .toEqual({ platform: 'win32', canScan: true, canJoin: true });
    const { wifi, calls } = manager({}, 'darwin');
    expect(wifi.capabilities()).toEqual({ platform: 'darwin', canScan: false, canJoin: false });
    expect(await wifi.scan()).toEqual([]);
    expect((await wifi.join({ ssid: 'X' })).ok).toBe(false);
    expect(calls.filter((c) => c.cmd === 'netsh')).toHaveLength(0);
  });
});

describe('WifiManager.scan', () => {
  it('merges visible networks with known-profile flags (case-insensitive)', async () => {
    const { wifi } = manager({
      'wlan show networks': ok(fixture('netsh_networks_en.txt')),
      'wlan show profiles': ok(fixture('netsh_profiles_en.txt')),
    });
    const nets = await wifi.scan();
    expect(nets.map((n) => [n.ssid, n.known])).toEqual([
      ['PaddockNet', true],
      ['Cafe Guest 2.4', false],
    ]);
  });

  it('scan failure degrades to an empty list, never throws', async () => {
    const { wifi } = manager({ 'wlan show networks': fail('radio off') });
    expect(await wifi.scan()).toEqual([]);
  });
});

describe('WifiManager.join', () => {
  const connectedIfaces = ok([
    '    SSID                   : PaddockNet',
    '    Signal                 : 90%',
  ].join('\n'));
  const disconnectedIfaces = ok('    State                  : disconnected');

  it('known network: connect then poll until the SSID is up', async () => {
    let polls = 0;
    const { wifi, calls } = manager({
      'wlan connect name=PaddockNet': ok('Connection request was completed successfully.'),
      'wlan show interfaces': () => (polls++ < 2 ? disconnectedIfaces : connectedIfaces),
    });
    expect(await wifi.join({ ssid: 'PaddockNet' })).toEqual({ ok: true });
    // No password -> no profile install.
    expect(calls.some((c) => c.args.includes('add'))).toBe(false);
  });

  it('new network: installs a temp profile XML (deleted afterwards) before connecting', async () => {
    let profileSeen = null;
    const { wifi } = manager({
      'wlan add profile': ({ args }) => {
        const path = args.find((a) => a.startsWith('filename=')).slice('filename='.length);
        profileSeen = { path, existedDuringAdd: existsSync(path), xml: readFileSync(path, 'utf8') };
        return ok('Profile PaddockNet is added on interface Wi-Fi.');
      },
      'wlan connect name=PaddockNet': ok(),
      'wlan show interfaces': connectedIfaces,
    });
    expect((await wifi.join({ ssid: 'PaddockNet', password: 'pit&wall<pw>' })).ok).toBe(true);
    expect(profileSeen.existedDuringAdd).toBe(true);
    expect(profileSeen.xml).toContain('<name>PaddockNet</name>');
    expect(profileSeen.xml).toContain('pit&amp;wall&lt;pw&gt;'); // escaped, never raw
    expect(existsSync(profileSeen.path)).toBe(false); // key material cleaned up
  });

  it('add-profile and connect failures surface their reason', async () => {
    const addFail = manager({ 'wlan add profile': fail('bad profile') });
    expect((await addFail.wifi.join({ ssid: 'X', password: 'password1' })).error)
      .toMatch(/add profile failed/);
    const connFail = manager({ 'wlan connect name=X': fail('no such profile') });
    expect((await connFail.wifi.join({ ssid: 'X' })).error).toMatch(/connect failed/);
  });

  it('never-connecting network times out with a clear error (fake clock)', async () => {
    const { wifi } = manager({
      'wlan connect name=Slow': ok(),
      'wlan show interfaces': disconnectedIfaces,
    });
    const res = await wifi.join({ ssid: 'Slow' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not connected to Slow/);
  });

  it('requires an ssid', async () => {
    const { wifi } = manager({});
    expect((await wifi.join({})).error).toBe('ssid required');
  });
});

describe('WifiManager.status', () => {
  it('parses interfaces and always reports adapter IPv4s', async () => {
    const { wifi } = manager({ 'wlan show interfaces': ok(fixture('netsh_interfaces_en.txt')) });
    const st = await wifi.status();
    expect(st.connected).toBe(true);
    expect(st.ssid).toBe('PaddockNet');
    expect(Array.isArray(st.adapterIps)).toBe(true);
  });

  it('non-Windows still reports adapter IPs for the guide-mode VERIFY', async () => {
    const { wifi } = manager({}, 'linux');
    const st = await wifi.status();
    expect(st.connected).toBe(false);
    expect(Array.isArray(st.adapterIps)).toBe(true);
  });
});
