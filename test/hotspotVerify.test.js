// main/hotspotVerify.js — the honest hotspot DHCP/ICS readiness model (2D,
// Windows observation #4). A start-command success is NOT client-readiness;
// this classifies what CAN be verified locally into verified vs degraded, and
// its facts are redacted-by-construction (tokens/addresses/enum names — never a
// command line or a credential). No Windows commands run here — fake `run` +
// fake networkInterfaces, exactly the macOS-safe seam.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    createHotspotVerifier, classifyHotspotReadiness, parseServiceTokens, icsGateway,
} = require('../main/hotspotVerify.js');

const ok = (stdout) => ({ ok: true, code: 0, stdout, stderr: '' });
const fail = (stderr, code = 1) => ({ ok: false, code, stdout: '', stderr });
const nics = (obj) => () => obj;
const GW = { 'Local Area Connection* 2': [{ family: 'IPv4', internal: false, address: '192.168.137.1' }] };
const NO_GW = { Ethernet: [{ family: 'IPv4', internal: false, address: '10.0.0.5' }] };

describe('classifyHotspotReadiness — verified vs degraded (2D)', () => {
    it('mobile: tether On + icssvc Running + a .137 gateway ⇒ VERIFIED', () => {
        const r = classifyHotspotReadiness('mobile', {
            tetherState: 'On', services: { SharedAccess: 'Running', icssvc: 'Running' }, gateway: { hostIp: '192.168.137.1', iface: 'vEthernet' },
        });
        expect(r).toEqual({ status: 'verified', reasons: [] });
    });

    it('hosted: SharedAccess Running + a .137 gateway ⇒ VERIFIED', () => {
        const r = classifyHotspotReadiness('hosted', {
            services: { SharedAccess: 'Running', icssvc: null }, gateway: { hostIp: '192.168.137.1', iface: 'Wi-Fi' },
        });
        expect(r.status).toBe('verified');
    });

    it('DEGRADED when the ICS gateway (192.168.137.x) is missing — the classic "Obtaining IP address" stall', () => {
        const r = classifyHotspotReadiness('mobile', {
            tetherState: 'On', services: { SharedAccess: 'Running', icssvc: 'Running' }, gateway: { hostIp: null, iface: null },
        });
        expect(r.status).toBe('degraded');
        expect(r.reasons.join(' ')).toMatch(/Obtaining IP address/);
    });

    it('hosted DEGRADED when Internet Connection Sharing (SharedAccess) is not Running — hostednetwork has no DHCP without ICS', () => {
        const stopped = classifyHotspotReadiness('hosted', { services: { SharedAccess: 'Stopped', icssvc: null }, gateway: { hostIp: '192.168.137.1' } });
        expect(stopped.status).toBe('degraded');
        expect(stopped.reasons.join(' ')).toMatch(/no DHCP without ICS/);
        const unread = classifyHotspotReadiness('hosted', { services: { SharedAccess: null, icssvc: null }, gateway: { hostIp: '192.168.137.1' } });
        expect(unread.reasons.join(' ')).toMatch(/could not be read/);
    });

    it('mobile DEGRADED when tethering is Off, unreadable, or the Mobile Hotspot service is down', () => {
        expect(classifyHotspotReadiness('mobile', { tetherState: 'Off', services: {}, gateway: { hostIp: '192.168.137.1' } }).reasons.join(' ')).toMatch(/tethering reports "Off"/);
        expect(classifyHotspotReadiness('mobile', { tetherState: null, services: {}, gateway: { hostIp: '192.168.137.1' } }).reasons.join(' ')).toMatch(/probe failed/);
        expect(classifyHotspotReadiness('mobile', { tetherState: 'On', services: { icssvc: 'Stopped' }, gateway: { hostIp: '192.168.137.1' } }).reasons.join(' ')).toMatch(/icssvc\) is Stopped/);
    });

    it('a check that errored surfaces as a degraded reason naming the step + exit code (no raw command line)', () => {
        const r = classifyHotspotReadiness('mobile', {
            tetherState: 'On', services: { icssvc: 'Running' }, gateway: { hostIp: '192.168.137.1' },
            errors: [{ step: 'service-query', code: 1, detail: 'access denied' }],
        });
        expect(r.status).toBe('degraded');
        expect(r.reasons[0]).toBe('service-query check failed (exit 1): access denied');
    });
});

describe('icsGateway + parseServiceTokens (locale-neutral, address-based)', () => {
    it('finds the first non-internal 192.168.137.x IPv4 and the interface that carries it', () => {
        expect(icsGateway(nics(GW))).toEqual({ hostIp: '192.168.137.1', iface: 'Local Area Connection* 2' });
        expect(icsGateway(nics(NO_GW))).toEqual({ hostIp: null, iface: null });
        expect(icsGateway(nics({}))).toEqual({ hostIp: null, iface: null });
    });

    it('parses SVC_<name>_<Status> enum tokens and treats QUERYFAILED as unknown (null)', () => {
        expect(parseServiceTokens('SVC_SharedAccess_Running\nSVC_icssvc_Stopped\nSVC_DONE'))
            .toEqual({ SharedAccess: 'Running', icssvc: 'Stopped' });
        expect(parseServiceTokens('SVC_SharedAccess_QUERYFAILED\nSVC_icssvc_Running'))
            .toEqual({ SharedAccess: null, icssvc: 'Running' });
        expect(parseServiceTokens('')).toEqual({ SharedAccess: null, icssvc: null });
    });
});

describe('createHotspotVerifier — IO collector + classifier behind one seam (2D)', () => {
    const routedRun = (probeStdout, svcStdout) => vi.fn(async (_cmd, args) => {
        const script = args.join(' ');
        if (script.includes('SVC_')) return ok(svcStdout);       // the Get-Service script (PS_SVC)
        return ok(probeStdout);                                   // the tethering-state probe
    });

    it('collects tether state + services + gateway and classifies VERIFIED on a healthy mobile hotspot', async () => {
        const verify = createHotspotVerifier({
            run: routedRun('PROBE_STATE_On\nPROBE_OK', 'SVC_SharedAccess_Running\nSVC_icssvc_Running\nSVC_DONE'),
            platform: 'win32', networkInterfaces: nics(GW), log: () => {},
        });
        const r = await verify({ backend: 'mobile' });
        expect(r.status).toBe('verified');
        expect(r.facts).toEqual({ tetherState: 'On', gateway: { hostIp: '192.168.137.1', iface: 'Local Area Connection* 2' }, services: { SharedAccess: 'Running', icssvc: 'Running' } });
    });

    it('a probe/service COMMAND FAILURE is captured as a degraded reason, never thrown', async () => {
        const run = vi.fn(async (_cmd, args) => (args.join(' ').includes('SVC_') ? fail('Get-Service: Access is denied') : fail('probe blew up')));
        const verify = createHotspotVerifier({ run, platform: 'win32', networkInterfaces: nics(NO_GW), log: () => {} });
        const r = await verify({ backend: 'mobile' });
        expect(r.status).toBe('degraded');
        expect(r.reasons.some((x) => /tethering-probe check failed/.test(x))).toBe(true);
        expect(r.reasons.some((x) => /service-query check failed/.test(x))).toBe(true);
    });

    it('off-Windows the check reports degraded honestly (Windows-only) and runs no command', async () => {
        const run = vi.fn();
        const verify = createHotspotVerifier({ run, platform: 'darwin', networkInterfaces: nics(GW) });
        const r = await verify({ backend: 'mobile' });
        expect(r.status).toBe('degraded');
        expect(r.reasons).toEqual(['local readiness checks are Windows-only']);
        expect(run).not.toHaveBeenCalled();
    });
});
