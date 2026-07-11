import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SCENARIOS, simScenario, createSimRun } = require('../main/wifiSim.js');
const { WifiManager } = require('../main/wifiManager.js');
const { HotspotManager } = require('../main/hotspot.js');
const { parseNetshInterfacesList, parseNetshNetworks, parseNetshDrivers } = require('../shared/wifiParse.js');

describe('simScenario (env gate)', () => {
    it('unset or empty env means NO sim — the real managers must be used', () => {
        expect(simScenario({})).toBeNull();
        expect(simScenario({ W17_WIFI_SIM: '' })).toBeNull();
        expect(simScenario()).toBeNull();
    });

    it('known scenarios pass through; unknown warns and falls back', () => {
        for (const s of SCENARIOS) expect(simScenario({ W17_WIFI_SIM: s })).toBe(s);
        const warnings = [];
        expect(simScenario({ W17_WIFI_SIM: 'zzz' }, (m) => warnings.push(m))).toBe('two-adapters');
        expect(warnings.join(' ')).toContain('zzz');
    });
});

describe('createSimRun — canned output feeds the REAL parsers', () => {
    // Parser-level assertions on purpose: they pin the sim text's structure
    // without depending on the managers' result shapes.
    it('two-adapters: interface list parses to built-in + dongle, first connected', async () => {
        const run = createSimRun('two-adapters');
        const res = await run('netsh', ['wlan', 'show', 'interfaces']);
        expect(res.ok).toBe(true);
        const ifaces = parseNetshInterfacesList(res.stdout);
        expect(ifaces.map((i) => [i.name, i.connected])).toEqual([
            ['Wi-Fi', true],
            ['Wi-Fi 2', false],
        ]);
        expect(ifaces[0].ssid).toBe('PaddockNet');
        expect(ifaces[1].description).toContain('RT5370');
    });

    it('one-adapter / no-adapter parse to 1 and 0 adapters', async () => {
        const one = await createSimRun('one-adapter')('netsh', ['wlan', 'show', 'interfaces']);
        expect(parseNetshInterfacesList(one.stdout)).toHaveLength(1);
        const none = await createSimRun('no-adapter')('netsh', ['wlan', 'show', 'interfaces']);
        expect(none.ok).toBe(true);
        expect(parseNetshInterfacesList(none.stdout)).toHaveLength(0);
    });

    it('scan output parses to visible networks with signal and auth', async () => {
        const res = await createSimRun('two-adapters')('netsh', ['wlan', 'show', 'networks', 'mode=bssid']);
        const nets = parseNetshNetworks(res.stdout);
        expect(nets.map((n) => n.ssid)).toEqual(['PaddockNet', 'Cafe Guest 2.4']);
        expect(nets[0].signalPct).toBe(87);
        expect(nets[1].auth).toBe('Open');
    });

    it('drivers output reports hosted-network support', async () => {
        const res = await createSimRun('one-adapter')('netsh', ['wlan', 'show', 'drivers']);
        expect(parseNetshDrivers(res.stdout)).toEqual({ hostedNetworkSupported: true });
    });

    it('netsh-fail: every netsh and powershell command fails with a reason', async () => {
        const run = createSimRun('netsh-fail');
        for (const args of [['wlan', 'show', 'interfaces'], ['wlan', 'show', 'networks'], ['wlan', 'connect', 'name=X']]) {
            const res = await run('netsh', args);
            expect(res.ok).toBe(false);
            expect(res.stderr).toContain('wlansvc');
        }
        expect((await run('powershell', ['-Command', 'x'])).ok).toBe(false);
    });

    it('unrouted commands fail instead of pretending', async () => {
        const res = await createSimRun('two-adapters')('rm', ['-rf', 'x']);
        expect(res.ok).toBe(false);
    });
});

describe('sim run through the real managers', () => {
    it('WifiManager joins a scanned network; the sim then reports it connected', async () => {
        const wifi = new WifiManager({
            run: createSimRun('two-adapters'),
            platform: 'win32',
            sleep: async () => {},
        });
        const scan = await wifi.scan();
        expect(scan.ok).toBe(true);
        expect(scan.networks.find((n) => n.ssid === 'PaddockNet').known).toBe(true);
        const res = await wifi.join({ ssid: 'Cafe Guest 2.4' });
        expect(res).toEqual({ ok: true });
        const st = await wifi.status();
        expect(st.connected).toBe(true);
        expect(st.ssid).toBe('Cafe Guest 2.4');
    });

    it('HotspotManager starts via the mobile backend in sim', async () => {
        const hotspot = new HotspotManager({ run: createSimRun('two-adapters'), platform: 'win32' });
        const probe = await hotspot.probeBackends();
        expect(probe).toMatchObject({ canHotspot: true, preferred: 'mobile' });
        const res = await hotspot.start({ ssid: 'W17-GRID', password: 'pitwall99' });
        expect(res.ok).toBe(true);
        expect(res.method).toBe('mobile');
        expect((await hotspot.stop()).ok).toBe(true);
    });

    it('netsh-fail degrades exactly like a broken WLAN service', async () => {
        const wifi = new WifiManager({ run: createSimRun('netsh-fail'), platform: 'win32', sleep: async () => {} });
        const list = await wifi.listInterfaces();
        expect(list.ok).toBe(false);
        expect(list.ifaces).toEqual([]);
        expect(list.error).toContain('wlansvc');
        const scan = await wifi.scan();
        expect(scan.ok).toBe(false);
        expect(scan.error).toContain('wlansvc');
        const hotspot = new HotspotManager({ run: createSimRun('netsh-fail'), platform: 'win32' });
        const res = await hotspot.start({ ssid: 'W17-GRID', password: 'pitwall99' });
        expect(res.ok).toBe(false);
    });
});
