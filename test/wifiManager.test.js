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

// Realistic `netsh wlan show interfaces` text for inline scenarios: full
// per-adapter blocks (name first, several fields) exactly like the fixtures —
// bare SSID/Signal lines without a Name field are not something netsh emits.
const ifaceBlock = ({ name, ssid = null, signalPct = 90 }) => [
  `    Name                   : ${name}`,
  '    Description            : Test WLAN Adapter',
  '    GUID                   : 12345678-1234-1234-1234-123456789abc',
  '    Physical address       : aa:bb:cc:dd:ee:ff',
  ...(ssid
    ? [
      '    State                  : connected',
      `    SSID                   : ${ssid}`,
      `    Signal                 : ${signalPct}%`,
    ]
    : ['    State                  : disconnected']),
].join('\n');
const interfacesText = (...blocks) =>
  `There are ${blocks.length} interfaces on the system:\n\n${blocks.join('\n\n')}\n`;

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
    // No capability is not an error: ok:true with nothing found.
    expect(await wifi.scan()).toEqual({ ok: true, networks: [] });
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
    const res = await wifi.scan();
    expect(res.ok).toBe(true);
    expect(res.networks.map((n) => [n.ssid, n.known])).toEqual([
      ['PaddockNet', true],
      ['Cafe Guest 2.4', false],
    ]);
  });

  it('scan failure returns ok:false WITH the reason, never throws', async () => {
    const { wifi } = manager({ 'wlan show networks': fail('radio off') });
    expect(await wifi.scan()).toEqual({ ok: false, networks: [], error: 'radio off' });
  });

  it('a chosen adapter is passed to netsh as interface=; omitted otherwise', async () => {
    const { wifi, calls } = manager({
      'wlan show networks': ok(fixture('netsh_networks_en.txt')),
      'wlan show profiles': ok(fixture('netsh_profiles_en.txt')),
    });
    await wifi.scan({ iface: 'Wi-Fi 2' });
    const networksCall = calls.find((c) => c.args.includes('networks'));
    expect(networksCall.args).toContain('interface=Wi-Fi 2');
    calls.length = 0;
    await wifi.scan();
    const plainCall = calls.find((c) => c.args.includes('networks'));
    expect(plainCall.args.some((a) => a.startsWith('interface='))).toBe(false);
  });
});

describe('WifiManager.listInterfaces', () => {
  it('lists every WLAN adapter on win32', async () => {
    const { wifi } = manager({ 'wlan show interfaces': ok(fixture('netsh_interfaces_two_en.txt')) });
    const res = await wifi.listInterfaces();
    expect(res.ok).toBe(true);
    expect(res.ifaces.map((i) => [i.name, i.connected])).toEqual([
      ['Wi-Fi', true],
      ['Wi-Fi 2', false],
    ]);
  });

  it('non-Windows is ok:true/empty; a netsh failure is ok:false WITH the reason', async () => {
    expect(await manager({}, 'darwin').wifi.listInterfaces()).toEqual({ ok: true, ifaces: [] });
    const { wifi } = manager({ 'wlan show interfaces': fail('wlan svc down') });
    expect(await wifi.listInterfaces()).toEqual({ ok: false, ifaces: [], error: 'wlan svc down' });
  });
});

describe('WifiManager.join', () => {
  const connectedIfaces = ok(interfacesText(ifaceBlock({ name: 'Wi-Fi', ssid: 'PaddockNet' })));
  const disconnectedIfaces = ok(interfacesText(ifaceBlock({ name: 'Wi-Fi' })));

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

  it('polls status once per second against the 20 s deadline', async () => {
    let statusPolls = 0;
    const { wifi } = manager({
      'wlan connect name=Slow': ok(),
      'wlan show interfaces': () => { statusPolls += 1; return disconnectedIfaces; },
    });
    await wifi.join({ ssid: 'Slow' });
    expect(statusPolls).toBe(20); // JOIN_TIMEOUT_MS / JOIN_POLL_MS
  });

  it('requires an ssid', async () => {
    const { wifi } = manager({});
    expect((await wifi.join({})).error).toBe('ssid required');
  });

  it('a chosen adapter pins add-profile and connect to that interface', async () => {
    const { wifi, calls } = manager({
      'wlan add profile': ok(),
      'wlan connect name=PaddockNet': ok(),
      'wlan show interfaces': connectedIfaces,
    });
    await wifi.join({ ssid: 'PaddockNet', password: 'password1', iface: 'Wi-Fi 2' });
    const add = calls.find((c) => c.args.includes('add'));
    const connect = calls.find((c) => c.args.includes('connect'));
    expect(add.args).toContain('interface=Wi-Fi 2');
    expect(connect.args).toContain('interface=Wi-Fi 2');
  });
});

// --- audit M2: join verification must be pinned to the selected adapter ---
// The supported bench topology is the built-in adapter on the home/camera
// network while the RT5370 dongle joins W17-GRID. Success/failure must be
// judged ONLY by the selected adapter's own interface block, in either
// enumeration order.
describe('WifiManager.join — adapter-pinned verification (audit M2)', () => {
  const both = fixture('netsh_interfaces_two_both_en.txt'); // Wi-Fi:HOME/84 + Wi-Fi 2:W17-GRID/66
  const bothReversed = fixture('netsh_interfaces_two_both_reversed_en.txt'); // same blocks, dongle first
  const connecting = fixture('netsh_interfaces_dongle_connecting_en.txt'); // dongle authenticating, no SSID yet

  it('a successful dongle join is recognized in BOTH enumeration orders (built-in stays on HOME)', async () => {
    for (const text of [both, bothReversed]) {
      const { wifi, calls } = manager({
        'wlan connect name=W17-GRID': ok(),
        'wlan show interfaces': ok(text),
      });
      expect(await wifi.join({ ssid: 'W17-GRID', iface: 'Wi-Fi 2' })).toEqual({ ok: true });
      expect(calls.find((c) => c.args.includes('connect')).args).toContain('interface=Wi-Fi 2');
    }
  });

  it("another adapter already on the TARGET network can never fake the selected adapter's success", async () => {
    // The merged parser would have read the built-in's W17-GRID as "joined".
    const text = interfacesText(
      ifaceBlock({ name: 'Wi-Fi', ssid: 'W17-GRID' }),
      ifaceBlock({ name: 'Wi-Fi 2' }), // the selected dongle never connects
    );
    const { wifi } = manager({
      'wlan connect name=W17-GRID': ok(),
      'wlan show interfaces': ok(text),
    });
    const res = await wifi.join({ ssid: 'W17-GRID', iface: 'Wi-Fi 2' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not connected to W17-GRID on adapter "Wi-Fi 2"');
    expect(res.error).toContain('adapter is not connected');
  });

  it('a transitional poll (associating, no SSID yet) keeps polling until the SSID is up', async () => {
    let polls = 0;
    const { wifi } = manager({
      'wlan connect name=W17-GRID': ok(),
      'wlan show interfaces': () => (polls++ < 2 ? ok(connecting) : ok(both)),
    });
    expect(await wifi.join({ ssid: 'W17-GRID', iface: 'Wi-Fi 2' })).toEqual({ ok: true });
    expect(polls).toBeGreaterThan(2);
  });

  it('a selected adapter that disappears during polling is reported honestly from the LAST poll', async () => {
    let polls = 0;
    const single = ok(fixture('netsh_interfaces_en.txt')); // only the built-in remains
    const { wifi } = manager({
      'wlan connect name=W17-GRID': ok(),
      'wlan show interfaces': () => (polls++ < 1 ? ok(connecting) : single),
    });
    const res = await wifi.join({ ssid: 'W17-GRID', iface: 'Wi-Fi 2' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('adapter "Wi-Fi 2" not detected');
    // Nothing from another adapter and nothing stale from earlier polls:
    expect(res.error).not.toContain('HOME');
    expect(res.error).not.toContain('PaddockNet');
  });

  it('the SSID match is exact and case-sensitive (a differently-cased SSID is a different network)', async () => {
    const text = interfacesText(ifaceBlock({ name: 'Wi-Fi 2', ssid: 'w17-grid' }));
    const { wifi } = manager({
      'wlan connect name=W17-GRID': ok(),
      'wlan show interfaces': ok(text),
    });
    const res = await wifi.join({ ssid: 'W17-GRID', iface: 'Wi-Fi 2' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('currently connected to w17-grid');
  });

  it('when the status check itself keeps failing, the timeout says so instead of blaming the network', async () => {
    const { wifi } = manager({
      'wlan connect name=W17-GRID': ok(),
      'wlan show interfaces': fail('wlansvc stopped'),
    });
    const res = await wifi.join({ ssid: 'W17-GRID', iface: 'Wi-Fi 2' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('could not verify the join');
    expect(res.error).toContain('wlansvc stopped');
  });
});

// --- audit B3: security scope + open-network join ---
// join() branches on the normalized `security` kind (never localized prose):
// open networks get an open profile (no key), WPA3-only/enterprise/hidden are
// rejected BEFORE any OS call with a stable kind + controlled message, and a
// secured network with no saved profile and no password is a controlled
// `password-required` rather than a bare netsh failure.
describe('WifiManager.join — security scope (audit B3)', () => {
  const connectedIfaces = ok(interfacesText(ifaceBlock({ name: 'Wi-Fi', ssid: 'Cafe Guest 2.4' })));

  it('a NEW open network installs an OPEN profile (no key), connects, and cleans it up', async () => {
    let profileSeen = null;
    const { wifi, calls } = manager({
      'wlan add profile': ({ args }) => {
        const p = args.find((a) => a.startsWith('filename=')).slice('filename='.length);
        profileSeen = { path: p, existedDuringAdd: existsSync(p), xml: readFileSync(p, 'utf8') };
        return ok('Profile Cafe Guest 2.4 is added on interface Wi-Fi.');
      },
      'wlan connect name=Cafe Guest 2.4': ok(),
      'wlan show interfaces': connectedIfaces,
    });
    const res = await wifi.join({ ssid: 'Cafe Guest 2.4', security: 'open', known: false });
    expect(res).toEqual({ ok: true });
    expect(profileSeen.existedDuringAdd).toBe(true);
    expect(profileSeen.xml).toContain('<authentication>open</authentication>');
    expect(profileSeen.xml).toContain('<encryption>none</encryption>');
    expect(profileSeen.xml).not.toContain('keyMaterial'); // no credential invented
    expect(existsSync(profileSeen.path)).toBe(false);      // temp profile cleaned up
    // No password argument was ever needed anywhere.
    expect(calls.some((c) => c.args.some((a) => /password/i.test(a)))).toBe(false);
  });

  it('a SAVED open network joins via its profile — no unnecessary profile install', async () => {
    const { wifi, calls } = manager({
      'wlan connect name=Cafe Guest 2.4': ok(),
      'wlan show interfaces': connectedIfaces,
    });
    expect(await wifi.join({ ssid: 'Cafe Guest 2.4', security: 'open', known: true })).toEqual({ ok: true });
    expect(calls.some((c) => c.args.includes('add'))).toBe(false); // reused the saved profile
  });

  it('an open join is pinned to the selected adapter (add profile + connect)', async () => {
    const { wifi, calls } = manager({
      'wlan add profile': ok(),
      'wlan connect name=Cafe Guest 2.4': ok(),
      'wlan show interfaces': ok(interfacesText(
        ifaceBlock({ name: 'Wi-Fi' }),
        ifaceBlock({ name: 'Wi-Fi 2', ssid: 'Cafe Guest 2.4' }),
      )),
    });
    expect(await wifi.join({ ssid: 'Cafe Guest 2.4', security: 'open', known: false, iface: 'Wi-Fi 2' })).toEqual({ ok: true });
    expect(calls.find((c) => c.args.includes('add')).args).toContain('interface=Wi-Fi 2');
    expect(calls.find((c) => c.args.includes('connect')).args).toContain('interface=Wi-Fi 2');
  });

  it('WPA3-only is rejected BEFORE any OS call, with the exact Q3 message', async () => {
    const { wifi, calls } = manager({});
    const res = await wifi.join({ ssid: 'Modern6E', security: 'wpa3-only', password: 'whatever1' });
    expect(res.ok).toBe(false);
    expect(res.kind).toBe('unsupported-wpa3');
    expect(res.error).toBe('WPA3-only networks are not currently supported. Use a WPA2 network or start the W17 hotspot.');
    expect(calls).toHaveLength(0); // never attempts an inappropriate WPA2 profile
  });

  it('enterprise is rejected before any OS call (no PSK password prompt path)', async () => {
    const { wifi, calls } = manager({});
    const res = await wifi.join({ ssid: 'CorpNet', security: 'enterprise' });
    expect(res.ok).toBe(false);
    expect(res.kind).toBe('unsupported-enterprise');
    expect(res.error).toContain('Enterprise (802.1X) networks are not currently supported');
    expect(calls).toHaveLength(0);
  });

  it('a hidden/empty or whitespace SSID is a controlled unsupported-hidden-network, never raw netsh', async () => {
    for (const ssid of ['', '   ']) {
      const { wifi, calls } = manager({});
      const res = await wifi.join({ ssid, security: 'open' });
      expect(res.ok).toBe(false);
      expect(res.kind).toBe('unsupported-hidden-network');
      expect(res.error).toMatch(/Hidden or unnamed networks/);
      expect(calls).toHaveLength(0);
    }
  });

  it('a secured network with no saved profile and no password fails conservatively (password-required)', async () => {
    const { wifi, calls } = manager({});
    const res = await wifi.join({ ssid: 'HomeWPA2', security: 'wpa2-personal', known: false });
    expect(res.ok).toBe(false);
    expect(res.kind).toBe('password-required');
    expect(res.error).toContain('needs a Wi-Fi password');
    expect(calls).toHaveLength(0); // no bare connect that netsh would reject
  });

  it('a NEW unknown-security network is rejected before any OS call — no WPA2 profile, no connect, even with a password', async () => {
    const { wifi, calls } = manager({});
    // A password must NOT coax a speculative WPA2 profile out of an unknown network.
    const res = await wifi.join({ ssid: 'Legacy', security: 'unknown', known: false, password: 'password1' });
    expect(res.ok).toBe(false);
    expect(res.kind).toBe('unsupported-unknown-security');
    expect(res.error).toBe('This network’s security type could not be identified. Use a known WPA2 network or start the W17 hotspot.');
    expect(calls).toHaveLength(0); // no add profile, no connect
  });

  it('an unknown-security network WITH a saved Windows profile connects via it (builds nothing)', async () => {
    const { wifi, calls } = manager({
      'wlan connect name=WeirdSaved': ok(),
      'wlan show interfaces': ok(interfacesText(ifaceBlock({ name: 'Wi-Fi', ssid: 'WeirdSaved' }))),
    });
    expect(await wifi.join({ ssid: 'WeirdSaved', security: 'unknown', known: true })).toEqual({ ok: true });
    expect(calls.some((c) => c.args.includes('add'))).toBe(false); // reused the saved profile — no new profile XML
  });

  it('the WPA2 passphrase rides the temp profile FILE only — never netsh argv or the returned error', async () => {
    const secret = 'sp ace&<pw>"';
    const { wifi, calls } = manager({
      'wlan add profile': fail('bad profile'), // realistic: netsh never echoes the key
    });
    const res = await wifi.join({ ssid: 'HomeWPA2', security: 'wpa2-personal', known: false, password: secret });
    expect(res.ok).toBe(false);
    // The key was written into the temp XML only; no command argument carries it…
    expect(calls.flatMap((c) => c.args).some((a) => a.includes(secret))).toBe(false);
    // …and the surfaced error withholds it too.
    expect(JSON.stringify(res)).not.toContain(secret);
  });
});

describe('WifiManager.status', () => {
  const both = ok(fixture('netsh_interfaces_two_both_en.txt'));
  const bothReversed = ok(fixture('netsh_interfaces_two_both_reversed_en.txt'));

  it('parses interfaces and always reports adapter IPv4s', async () => {
    const { wifi } = manager({ 'wlan show interfaces': ok(fixture('netsh_interfaces_en.txt')) });
    const st = await wifi.status();
    expect(st.ok).toBe(true);
    expect(st.connected).toBe(true);
    expect(st.ssid).toBe('PaddockNet');
    expect(st.signalPct).toBe(90);
    expect(Array.isArray(st.adapterIps)).toBe(true);
  });

  it('non-Windows still reports adapter IPs for the guide-mode VERIFY', async () => {
    const { wifi } = manager({}, 'linux');
    const st = await wifi.status();
    expect(st.connected).toBe(false);
    expect(Array.isArray(st.adapterIps)).toBe(true);
  });

  it('pinned status returns ONLY the selected adapter block — ssid and signal stay paired (audit M2)', async () => {
    const { wifi } = manager({ 'wlan show interfaces': both });
    const dongle = await wifi.status({ iface: 'Wi-Fi 2' });
    expect(dongle).toMatchObject({
      ok: true, iface: 'Wi-Fi 2', present: true,
      connected: true, ssid: 'W17-GRID', signalPct: 66,
    });
    const builtin = await wifi.status({ iface: 'Wi-Fi' });
    expect(builtin).toMatchObject({ connected: true, ssid: 'HOME', signalPct: 84 });
  });

  it('enumeration order cannot change a pinned result', async () => {
    for (const text of [both, bothReversed]) {
      const { wifi } = manager({ 'wlan show interfaces': text });
      const st = await wifi.status({ iface: 'Wi-Fi 2' });
      expect([st.connected, st.ssid, st.signalPct]).toEqual([true, 'W17-GRID', 66]);
    }
  });

  it('a missing selected adapter is its own explicit result, never another adapter status', async () => {
    const { wifi } = manager({ 'wlan show interfaces': ok(fixture('netsh_interfaces_en.txt')) });
    const st = await wifi.status({ iface: 'Wi-Fi 2' });
    expect(st).toMatchObject({ ok: true, iface: 'Wi-Fi 2', present: false, connected: false, ssid: '' });
    expect(st.error).toContain('adapter "Wi-Fi 2" not detected');
  });

  it('a failed netsh status check is ok:false WITH the reason — not "not connected"', async () => {
    const { wifi } = manager({ 'wlan show interfaces': fail('wlansvc stopped') });
    expect(await wifi.status({ iface: 'Wi-Fi 2' })).toMatchObject({ ok: false, error: 'wlansvc stopped' });
    expect(await wifi.status()).toMatchObject({ ok: false, error: 'wlansvc stopped' });
  });

  it('aggregate (unpinned) status takes every field from ONE connected block, never a merge', async () => {
    const { wifi } = manager({ 'wlan show interfaces': both });
    const st = await wifi.status();
    // First CONNECTED block wins as a unit: HOME pairs with 84, never with 66.
    expect([st.iface, st.ssid, st.signalPct]).toEqual(['Wi-Fi', 'HOME', 84]);
  });
});
