import { describe, it, expect } from 'vitest';
import {
    adapterRowState, scanStatusText, hotspotPaneState,
    joinPlan, networkBadge,
    WPA3_ONLY_MESSAGE, ENTERPRISE_MESSAGE, OPEN_NETWORK_WARNING, UNKNOWN_SECURITY_MESSAGE,
} from '../shared/wifiView.mjs';

const IFACES = [
    { name: 'Wi-Fi', description: 'Intel(R) Wi-Fi 6 AX201 160MHz', connected: true, ssid: 'PaddockNet', signalPct: 90 },
    { name: 'Wi-Fi 2', description: 'Ralink RT5370 USB Wireless Adapter', connected: false, ssid: '', signalPct: null },
];

// The ADAPTER card (audit Q7 option 2): the row is always a readable card, not
// a hidden picker. adapterRowState is the single source of truth for what the
// card shows in every state; setupFlow.js only renders what comes back.
describe('adapterRowState — ADAPTER card model', () => {
    it('failed listing says SO (ADAPTER CHECK FAILED) — with the reason, distinct from "no adapters"; RESCAN', () => {
        const s = adapterRowState({ ok: false, ifaces: [], error: 'wlansvc is not running' });
        expect(s.mode).toBe('failed');
        expect(s.status).toBe('ADAPTER CHECK FAILED');
        expect(s.warn).toBe(true);
        expect(s.rescan).toBe(true);
        expect(s.hint).toContain('wlansvc is not running');
        expect(s.detail).toBeUndefined(); // no adapter to detail
    });

    it('the failure reason is sanitized — whitespace collapsed and capped', () => {
        const noisy = 'line one\n\n   line two\t\ttabbed   ' + 'x'.repeat(400);
        const s = adapterRowState({ ok: false, ifaces: [], error: noisy });
        expect(s.hint).not.toContain('\n');
        expect(s.hint).not.toContain('\t');
        expect(s.hint.length).toBeLessThan(200); // headline + 160-char reason cap
    });

    it('zero adapters shows the dongle troubleshooting hint (with RESCAN)', () => {
        const s = adapterRowState({ ok: true, ifaces: [] });
        expect(s.mode).toBe('missing');
        expect(s.status).toBe('NO WLAN ADAPTER DETECTED');
        expect(s.warn).toBe(true);
        expect(s.rescan).toBe(true);
        expect(s.hint).toMatch(/dongle/i);
        expect(s.hint).toContain('RESCAN');
    });

    it('one adapter is a readonly confirmation: name/description/chip/SSID/signal from the SAME object, SELECTED', () => {
        const s = adapterRowState({ ok: true, ifaces: [IFACES[0]] });
        expect(s.mode).toBe('single');
        expect(s.selectedNote).toBe('SELECTED');
        expect(s.options).toBeUndefined(); // no dropdown for a single adapter
        expect(s.detail).toEqual({
            name: 'Wi-Fi',
            description: 'Intel(R) Wi-Fi 6 AX201 160MHz',
            connected: true,
            ssid: 'PaddockNet',
            signalPct: 90,
            chip: { text: 'CONNECTED', tone: 'connected' },
        });
    });

    it('a disconnected single adapter shows a DISCONNECTED chip and no SSID/signal', () => {
        const s = adapterRowState({ ok: true, ifaces: [IFACES[1]] });
        expect(s.mode).toBe('single');
        expect(s.detail.chip).toEqual({ text: 'DISCONNECTED', tone: 'idle' });
        expect(s.detail.connected).toBe(false);
        expect(s.detail.ssid).toBe('');
        expect(s.detail.signalPct).toBeNull();
    });

    it('two adapters become a native <select>; first selected with nothing saved, CHANGE ADAPTER, detail follows', () => {
        const s = adapterRowState({ ok: true, ifaces: IFACES }, '');
        expect(s.mode).toBe('select');
        expect(s.selectorLabel).toBe('CHANGE ADAPTER');
        expect(s.selected).toBe('Wi-Fi');
        expect(s.options.map((o) => o.value)).toEqual(['Wi-Fi', 'Wi-Fi 2']);
        expect(s.detail.name).toBe('Wi-Fi'); // the selected adapter's detail
        expect(s.detail.chip.tone).toBe('connected');
        expect(s.savedMissing).toBeUndefined();
    });

    it('option labels include the adapter description (and SSID+signal when connected)', () => {
        const s = adapterRowState({ ok: true, ifaces: IFACES }, '');
        expect(s.options[0].label).toBe('Wi-Fi — Intel(R) Wi-Fi 6 AX201 160MHz · PaddockNet · 90%');
        expect(s.options[1].label).toBe('Wi-Fi 2 — Ralink RT5370 USB Wireless Adapter');
    });

    it('the persisted adapter is restored while it still exists, and its detail is shown', () => {
        const s = adapterRowState({ ok: true, ifaces: IFACES }, 'Wi-Fi 2');
        expect(s.selected).toBe('Wi-Fi 2');
        expect(s.detail.name).toBe('Wi-Fi 2');
        expect(s.detail.chip.tone).toBe('idle');
        expect(s.hint).toBeUndefined();
    });

    it('a vanished persisted adapter is NEVER silently replaced: amber NOT DETECTED, nothing selected, SELECT ADAPTER', () => {
        const s = adapterRowState({ ok: true, ifaces: [IFACES[0], { ...IFACES[1], name: 'Wi-Fi 3' }] }, 'Wi-Fi 2');
        expect(s.mode).toBe('select');
        expect(s.selected).toBe(''); // the user must pick — no silent fallback (audit M2/Q7)
        expect(s.selectorLabel).toBe('SELECT ADAPTER');
        expect(s.savedMissing).toBe('Wi-Fi 2');
        expect(s.detail).toEqual({
            name: 'Wi-Fi 2', description: '', connected: false, ssid: '', signalPct: null,
            chip: { text: 'NOT DETECTED', tone: 'missing' },
        });
        expect(s.options[0]).toEqual({ value: '', label: 'Wi-Fi 2 — NOT DETECTED', disabled: true });
        expect(s.options.slice(1).map((o) => o.value)).toEqual(['Wi-Fi', 'Wi-Fi 3']);
        expect(s.hint).toContain('"Wi-Fi 2" was not detected');
        expect(s.hint).toContain('choose an available adapter');
    });

    it('a vanished persisted adapter demands a choice even when only ONE other adapter remains', () => {
        const s = adapterRowState({ ok: true, ifaces: [IFACES[0]] }, 'Wi-Fi 2');
        expect(s.mode).toBe('select'); // not a silent readonly switch to the built-in
        expect(s.selected).toBe('');
        expect(s.savedMissing).toBe('Wi-Fi 2');
        expect(s.options[0].disabled).toBe(true);
        expect(s.options[1].value).toBe('Wi-Fi');
    });

    it('guide mode (no netsh on this OS) still yields a readable ADAPTER state with a sim hint', () => {
        const s = adapterRowState({ guide: true });
        expect(s.mode).toBe('guide');
        expect(s.status).toBe('Adapter selection is available in the Windows application.');
        expect(s.hint).toContain('W17_WIFI_SIM');
        expect(s.detail).toBeUndefined(); // never lists host interfaces as adapters
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

// The join decision + row badge are pure functions of the NORMALIZED security
// kind (audit B3 / Q3) — never of localized netsh prose. setupFlow.js renders
// exactly what these return; main/wifiManager.js mirrors the same decision.
describe('networkBadge — right-aligned row tag', () => {
    it('shows KNOWN for a saved profile, else the security kind', () => {
        expect(networkBadge({ security: 'wpa2-personal', known: true })).toBe('known');
        expect(networkBadge({ security: 'open' })).toBe('OPEN');
        expect(networkBadge({ security: 'wpa2-personal' })).toBe('WPA2');
        expect(networkBadge({ security: 'wpa2-wpa3-transition' })).toBe('WPA2/3');
        expect(networkBadge({ security: 'wpa3-only' })).toBe('WPA3');
        expect(networkBadge({ security: 'enterprise' })).toBe('802.1X');
        expect(networkBadge({ security: 'unknown' })).toBe('?');
        expect(networkBadge({})).toBe('?'); // missing security is never a raw auth string
    });
});

describe('joinPlan — security-scoped join decision', () => {
    it('open (new): warn + JOIN, no password field', () => {
        const p = joinPlan({ ssid: 'Cafe', security: 'open', known: false });
        expect(p).toEqual({ action: 'open', security: 'open', warn: OPEN_NETWORK_WARNING });
        expect(p.warn).toMatch(/unencrypted/i);
    });

    it('open (saved): still an open action (warn shown; the manager reuses the saved profile)', () => {
        expect(joinPlan({ ssid: 'Cafe', security: 'open', known: true }).action).toBe('open');
    });

    it('WPA2 saved: connect directly, no password prompt', () => {
        expect(joinPlan({ ssid: 'Home', security: 'wpa2-personal', known: true })).toEqual({ action: 'join', security: 'wpa2-personal' });
    });

    it('WPA2 new: prompt for a password, no caution note', () => {
        const p = joinPlan({ ssid: 'Home', security: 'wpa2-personal', known: false });
        expect(p.action).toBe('password');
        expect(p.note).toBeUndefined();
    });

    it('WPA2/WPA3 transition: password path over WPA2, with a note', () => {
        const p = joinPlan({ ssid: 'Blend', security: 'wpa2-wpa3-transition', known: false });
        expect(p.action).toBe('password');
        expect(p.note).toMatch(/WPA2/);
    });

    it('WPA3-only: rejected with the exact Q3 wording', () => {
        const p = joinPlan({ ssid: 'Modern', security: 'wpa3-only' });
        expect(p.action).toBe('reject');
        expect(p.reject).toBe('WPA3-only networks are not currently supported. Use a WPA2 network or start the W17 hotspot.');
        expect(p.reject).toBe(WPA3_ONLY_MESSAGE);
    });

    it('enterprise: rejected with a clear unsupported message (not a PSK prompt)', () => {
        const p = joinPlan({ ssid: 'Corp', security: 'enterprise' });
        expect(p.action).toBe('reject');
        expect(p.reject).toBe(ENTERPRISE_MESSAGE);
        expect(p.reject).toMatch(/802\.1X/);
    });

    it('unknown security (new, no saved profile): rejected conservatively — never a WPA2 password/join path', () => {
        const p = joinPlan({ ssid: 'Legacy', security: 'unknown', known: false, auth: 'Some Odd Auth', encryption: 'CCMP' });
        expect(p.action).toBe('reject'); // NOT 'password'
        expect(p.reject).toBe('This network’s security type could not be identified. Use a known WPA2 network or start the W17 hotspot.');
        expect(p.reject).toBe(UNKNOWN_SECURITY_MESSAGE);
        // Sanitized raw auth/enc retained for DIAGNOSTICS only (not the primary message).
        expect(p.diag).toMatch(/Some Odd Auth/);
        expect(p.diag).toMatch(/CCMP/);
        expect(p.reject).not.toMatch(/Some Odd Auth/);
        // A missing security field defaults to unknown -> also rejected, never password.
        expect(joinPlan({ ssid: 'X' }).action).toBe('reject');
    });

    it('unknown security WITH a saved Windows profile joins via that profile (constructs nothing)', () => {
        // The saved-profile carve-out: `known` connects via the existing profile,
        // exactly like any other known network — no speculative WPA2 build.
        expect(joinPlan({ ssid: 'WeirdSaved', security: 'unknown', known: true }))
            .toEqual({ action: 'join', security: 'unknown' });
    });
});

// The HOTSPOT pane (audit B1/N3): hotspotPaneState maps the main-process
// lifecycle snapshot to controls/text. Both buttons always exist; STOP is
// enabled ONLY while this app owns the hotspot, and the probe never blocks —
// probing/unsupported/failed/externally-active are distinct readable states.
describe('hotspotPaneState — HOTSPOT pane model', () => {
    const inactive = (over = {}) => ({
        phase: 'inactive', owned: false, backend: null, ssid: '', hostIp: null,
        lastError: null, probe: { status: 'supported', backend: 'mobile', externallyActive: false },
        ...over,
    });

    it('no snapshot (state IPC unavailable): everything off, honest status', () => {
        const v = hotspotPaneState(null);
        expect(v.status).toContain('HOTSPOT STATE UNAVAILABLE');
        expect(v).toMatchObject({ start: false, stop: false, inputs: false, warn: true });
    });

    it('probing: CHECKING HOTSPOT SUPPORT…, START disabled but inputs still editable (N3)', () => {
        const v = hotspotPaneState(inactive({ probe: { status: 'probing' } }));
        expect(v.status).toBe('CHECKING HOTSPOT SUPPORT…');
        expect(v).toMatchObject({ start: false, stop: false, inputs: true, recheck: false });
        // an idle (never-run) probe reads the same way
        expect(hotspotPaneState(inactive({ probe: { status: 'idle' } })).status).toBe('CHECKING HOTSPOT SUPPORT…');
    });

    it('supported + inactive: READY with the backend named; START enabled, STOP not', () => {
        const v = hotspotPaneState(inactive());
        expect(v.status).toBe('READY — mobile backend');
        expect(v).toMatchObject({ start: true, stop: false, inputs: true });
    });

    it('unsupported: says so, START disabled, RECHECK offered — capability, not adapter state', () => {
        const v = hotspotPaneState(inactive({ probe: { status: 'unsupported', backend: null, externallyActive: false } }));
        expect(v.status).toContain('NOT SUPPORTED');
        expect(v.status).toContain('join a network');
        expect(v).toMatchObject({ start: false, stop: false, warn: true, recheck: true });
    });

    it('failed check: distinct from unsupported, retryable via RECHECK', () => {
        const v = hotspotPaneState(inactive({ probe: { status: 'failed' } }));
        expect(v.status).toBe('HOTSPOT SUPPORT CHECK FAILED — RECHECK to retry');
        expect(v).toMatchObject({ start: false, stop: false, warn: true, recheck: true, inputs: true });
    });

    it('externally active hotspot: shown, NEVER app-owned — no usable STOP, no START on top of it', () => {
        const v = hotspotPaneState(inactive({ probe: { status: 'supported', backend: 'mobile', externallyActive: true } }));
        expect(v.status).toContain('not started by this app');
        expect(v).toMatchObject({ start: false, stop: false, warn: true, recheck: true });
        expect(v.hint).toContain('Windows Settings');
    });

    it('STARTING/STOPPING: conflicting controls disabled, transition visible', () => {
        const starting = hotspotPaneState(inactive({ phase: 'starting' }));
        expect(starting.status).toBe('STARTING HOTSPOT…');
        expect(starting).toMatchObject({ start: false, stop: false, inputs: false });
        const stopping = hotspotPaneState(inactive({ phase: 'stopping', owned: true }));
        expect(stopping.status).toBe('STOPPING HOTSPOT…');
        expect(stopping).toMatchObject({ start: false, stop: false, inputs: false });
    });

    it('LIVE: teal success line with SSID + host IP; STOP enabled, START disabled', () => {
        const v = hotspotPaneState(inactive({
            phase: 'live', owned: true, backend: 'mobile', ssid: 'W17-GRID', hostIp: '192.168.137.1',
        }));
        expect(v.status).toBe('LIVE (mobile) — join "W17-GRID" on the iPhone · this PC: 192.168.137.1');
        expect(v).toMatchObject({ live: true, start: false, stop: true, inputs: false });
    });

    it('config-mismatch partial start: LIVE-but-wrong presentation, never the "join it" success line', () => {
        const v = hotspotPaneState(inactive({
            phase: 'live', owned: true, backend: 'mobile', ssid: '',
            lastError: { kind: 'config-mismatch', error: 'mobile hotspot started but the requested SSID was not applied — press STOP HOTSPOT and retry' },
        }));
        expect(v.status).toBe('HOTSPOT RUNNING WITH THE WRONG NETWORK NAME');
        expect(v.hint).toContain('STOP HOTSPOT');
        expect(v).toMatchObject({ warn: true, start: false, stop: true, live: false });
    });

    it('failed stop: STOP FAILED with the reason, STOP stays enabled for retry (ownership retained)', () => {
        const v = hotspotPaneState(inactive({
            phase: 'live', owned: true, backend: 'mobile', ssid: 'W17-GRID',
            lastError: { kind: 'stop-failed', error: 'winrt stop threw' },
        }));
        expect(v.status).toBe('STOP FAILED — winrt stop threw');
        expect(v.hint).toContain('STOP HOTSPOT to retry');
        expect(v).toMatchObject({ warn: true, start: false, stop: true });
    });

    it('failed start (inactive + lastError): error shown with the B2 suggestion as a hint; retry enabled', () => {
        const v = hotspotPaneState(inactive({
            lastError: {
                kind: 'start-failed',
                error: 'hostednetwork start failed: Zugriff verweigert',
                suggestion: 'The legacy hotspot backend may require administrator privileges — restarting the ground station as administrator may help.',
            },
        }));
        expect(v.status).toContain('hostednetwork start failed');
        expect(v.hint).toMatch(/may require administrator/);
        expect(v).toMatchObject({ warn: true, start: true, stop: false, inputs: true, recheck: true });
    });
});
