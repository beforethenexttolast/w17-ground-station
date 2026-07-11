import { describe, it, expect } from 'vitest';
import { adapterRowState, scanStatusText } from '../shared/wifiView.mjs';

const IFACES = [
    { name: 'Wi-Fi', description: 'Intel(R) Wi-Fi 6 AX201 160MHz', connected: true, ssid: 'PaddockNet', signalPct: 90 },
    { name: 'Wi-Fi 2', description: 'Ralink RT5370 USB Wireless Adapter', connected: false, ssid: '', signalPct: null },
];

describe('adapterRowState (option A+E: the row is a readable state, not a hidden picker)', () => {
    it('failed listing says SO — with the reason, distinct from "no adapters"', () => {
        const s = adapterRowState({ ok: false, ifaces: [], error: 'wlansvc is not running' });
        expect(s.mode).toBe('failed');
        expect(s.label).toBe('ADAPTER LIST FAILED');
        expect(s.hint).toContain('wlansvc is not running');
    });

    it('zero adapters shows the dongle troubleshooting hint (with RESCAN)', () => {
        const s = adapterRowState({ ok: true, ifaces: [] });
        expect(s.mode).toBe('missing');
        expect(s.label).toBe('NO WLAN ADAPTER DETECTED');
        expect(s.hint).toMatch(/dongle/i);
        expect(s.hint).toContain('RESCAN');
    });

    it('one adapter is a readonly confirmation, connected SSID included', () => {
        const s = adapterRowState({ ok: true, ifaces: [IFACES[0]] });
        expect(s.mode).toBe('single');
        expect(s.label).toBe('Wi-Fi — Intel(R) Wi-Fi 6 AX201 160MHz · PaddockNet');
        expect(s.hint).toBeUndefined();
    });

    it('a disconnected single adapter omits the SSID suffix', () => {
        const s = adapterRowState({ ok: true, ifaces: [IFACES[1]] });
        expect(s.label).toBe('Wi-Fi 2 — Ralink RT5370 USB Wireless Adapter');
    });

    it('two adapters become a picker; first is selected with nothing saved', () => {
        const s = adapterRowState({ ok: true, ifaces: IFACES }, '');
        expect(s.mode).toBe('select');
        expect(s.options.map((o) => o.value)).toEqual(['Wi-Fi', 'Wi-Fi 2']);
        expect(s.selected).toBe('Wi-Fi');
        expect(s.hint).toBeUndefined();
    });

    it('the persisted adapter is restored while it still exists', () => {
        const s = adapterRowState({ ok: true, ifaces: IFACES }, 'Wi-Fi 2');
        expect(s.selected).toBe('Wi-Fi 2');
        expect(s.hint).toBeUndefined();
    });

    it('a vanished persisted adapter falls back to the first, and says so', () => {
        const s = adapterRowState({ ok: true, ifaces: [IFACES[0], { ...IFACES[1], name: 'Wi-Fi 3' }] }, 'Wi-Fi 2');
        expect(s.selected).toBe('Wi-Fi');
        expect(s.hint).toContain('"Wi-Fi 2" not found');
    });

    it('tolerates a missing/empty result object', () => {
        expect(adapterRowState().mode).toBe('missing');
        expect(adapterRowState({ ok: true }).mode).toBe('missing');
    });
});

describe('scanStatusText', () => {
    it('networks found -> empty status; none found -> NO NETWORKS FOUND', () => {
        expect(scanStatusText({ ok: true, networks: [{ ssid: 'X' }] })).toBe('');
        expect(scanStatusText({ ok: true, networks: [] })).toBe('NO NETWORKS FOUND');
    });

    it('a failed scan shows the reason, never "no networks"', () => {
        expect(scanStatusText({ ok: false, networks: [], error: 'radio off' })).toBe('SCAN FAILED — radio off');
        expect(scanStatusText({ ok: false })).toBe('SCAN FAILED — unknown error');
    });
});
