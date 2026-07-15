// Pure view-model for the PIT WALL network step. ESM (renderer + vitest), no
// IO: setupFlow.js feeds it the wifi IPC results and renders what comes back.
// Keeping the decisions here makes the ADAPTER card states and scan status
// text unit-testable without a DOM — repo style, like checklist.mjs.

// <select> option label — name plus driver description plus (when connected)
// the SSID and signal from the SAME parsed adapter object, so a dropdown row
// can never describe two adapters. The card body shows the selected adapter's
// detail separately; the extra network info here helps pick the RIGHT adapter
// (the M2 case: the dongle that is already on W17-GRID vs the built-in on the
// home/camera LAN).
const ifaceLabel = (i) => [
    `${i.name}${i.description ? ` — ${i.description}` : ''}`,
    ...(i.connected ? [i.ssid] : []),
    ...(i.connected && i.signalPct !== null && i.signalPct !== undefined ? [`${i.signalPct}%`] : []),
].join(' · ');

// The connection-state chip for one adapter: teal when connected, muted when
// not. The amber NOT DETECTED chip is produced only for a vanished saved
// adapter (see below) — a present adapter is never "missing".
const ifaceChip = (i) => (i.connected
    ? { text: 'CONNECTED', tone: 'connected' }
    : { text: 'DISCONNECTED', tone: 'idle' });

// The card-body detail for the adapter this card is ABOUT (the single adapter,
// or the currently-selected one). SSID/signal appear only while connected —
// each field comes from the same parsed adapter object, never merged (M2).
const ifaceDetail = (i) => ({
    name: i.name,
    description: i.description || '',
    connected: !!i.connected,
    ssid: i.connected ? (i.ssid || '') : '',
    signalPct: i.connected ? (i.signalPct ?? null) : null,
    chip: ifaceChip(i),
});

// netsh error text for the ADAPTER-CHECK-FAILED card: collapse whitespace and
// cap the length so a rambling localized message can't blow up the card (and,
// defensively, can't carry anything unexpected — adapter listing has no
// credentials, but the card stays terse regardless).
const sanitizeReason = (err) => String(err ?? 'unknown error').replace(/\s+/g, ' ').trim().slice(0, 160) || 'unknown error';

// listInterfaces result + the persisted adapter name -> the ADAPTER card model
// (audit Q7 option 2). The card is ALWAYS rendered on PIT WALL: a state you can
// read beats a picker that silently hides. Modes:
//   guide   — no netsh on this OS: say where adapter selection lives.
//   failed  — netsh broke: say so (ADAPTER CHECK FAILED), with the reason —
//             distinct from "no adapters"; RESCAN retries.
//   missing — zero adapters: dongle troubleshooting hint; RESCAN retries.
//   single  — readonly confirmation of the one adapter netsh will use, with a
//             clear SELECTED indication. No dropdown for a single adapter.
//   select  — several adapters (or a vanished saved one): a native <select>.
//             The persisted choice is restored while it still exists. A saved
//             adapter that is NOT detected anymore is NEVER silently replaced
//             (audit M2/Q7): the card shows it amber + NOT DETECTED, offers the
//             available adapters with nothing selected (selected:''), and the
//             caller must block adapter-pinned operations until the user picks.
//
// Shape (fields present depend on mode):
//   { mode,
//     status?, warn?, rescan?, hint?,        // guide/failed/missing headline
//     detail?, selectedNote?,                // single + select adapter detail
//     options?, selected?, selectorLabel?,   // select-mode dropdown
//     savedMissing? }                        // select-mode NOT-DETECTED name
export function adapterRowState(res = {}, savedAdapter = '') {
    if (res.guide) {
        return {
            mode: 'guide',
            status: 'Adapter selection is available in the Windows application.',
            hint: 'dev preview: W17_WIFI_SIM=two-adapters npm start (also one-adapter, no-adapter, netsh-fail)',
        };
    }
    const ifaces = res.ifaces || [];
    if (res.ok === false) {
        return {
            mode: 'failed',
            status: 'ADAPTER CHECK FAILED',
            warn: true,
            rescan: true,
            hint: `netsh could not list WLAN adapters — ${sanitizeReason(res.error)}`,
        };
    }
    if (ifaces.length === 0) {
        return {
            mode: 'missing',
            status: 'NO WLAN ADAPTER DETECTED',
            warn: true,
            rescan: true,
            hint: 'USB Wi-Fi dongle not detected — check the port/driver, then RESCAN',
        };
    }
    const savedPresent = savedAdapter && ifaces.some((i) => i.name === savedAdapter);
    if (savedAdapter && !savedPresent) {
        // Saved adapter gone: show it amber + NOT DETECTED, require an explicit
        // pick. selected:'' keeps the caller from pinning to an adapter the
        // user never chose (the M2 hazard: silently joining W17-GRID on the
        // built-in and dropping the home/camera link).
        return {
            mode: 'select',
            savedMissing: savedAdapter,
            selectorLabel: 'SELECT ADAPTER',
            selected: '',
            detail: {
                name: savedAdapter, description: '', connected: false, ssid: '', signalPct: null,
                chip: { text: 'NOT DETECTED', tone: 'missing' },
            },
            options: [
                { value: '', label: `${savedAdapter} — NOT DETECTED`, disabled: true },
                ...ifaces.map((i) => ({ value: i.name, label: ifaceLabel(i) })),
            ],
            hint: `saved adapter "${savedAdapter}" was not detected — choose an available adapter, or reconnect it and RESCAN`,
        };
    }
    if (ifaces.length === 1) {
        return { mode: 'single', detail: ifaceDetail(ifaces[0]), selectedNote: 'SELECTED' };
    }
    const selected = savedPresent ? savedAdapter : ifaces[0].name;
    return {
        mode: 'select',
        selected,
        selectorLabel: 'CHANGE ADAPTER',
        detail: ifaceDetail(ifaces.find((i) => i.name === selected)),
        options: ifaces.map((i) => ({ value: i.name, label: ifaceLabel(i) })),
    };
}

// --- network security scope (audit B3 / decision Q3) ----------------------
// The renderer branches on the normalized `security` kind (shared/wifiParse.js
// classifyWifiSecurity), never on localized netsh prose. These messages are the
// single source of truth for the UI; main/wifiManager.js keeps byte-identical
// copies of the rejection strings as a defensive backstop (kept in sync by
// test/wifiView.test.js + test/wifiManager.test.js pinning the exact Q3 text).
export const OPEN_NETWORK_WARNING = 'OPEN NETWORK — no password; traffic is unencrypted';
export const WPA3_ONLY_MESSAGE = 'WPA3-only networks are not currently supported. Use a WPA2 network or start the W17 hotspot.';
export const ENTERPRISE_MESSAGE = 'Enterprise (802.1X) networks are not currently supported. Use a WPA2 network or start the W17 hotspot.';
export const UNKNOWN_SECURITY_MESSAGE = 'This network’s security type could not be identified. Use a known WPA2 network or start the W17 hotspot.';
const TRANSITION_NOTE = 'WPA2/WPA3 network — joining over WPA2';

// Sanitized raw auth/encryption for DIAGNOSTICS only (audit B3) — surfaced on a
// rejected unknown-security row as a tooltip, never as the primary UI message.
// Whitespace-collapsed and capped so a rambling localized value stays terse.
const securityDiag = (n = {}) => {
    const clip = (v, max) => String(v).replace(/\s+/g, ' ').trim().slice(0, max);
    const parts = [];
    if (n.auth) parts.push(`auth "${clip(n.auth, 60)}"`);
    if (n.encryption) parts.push(`enc "${clip(n.encryption, 40)}"`);
    return parts.length ? `unrecognized security — ${parts.join(' · ')}` : '';
};

// The short right-aligned tag for a network row. A saved profile shows KNOWN;
// otherwise the security kind is surfaced so the user sees what a row needs
// before clicking it.
const SECURITY_BADGE = {
    open: 'OPEN',
    'wpa2-personal': 'WPA2',
    'wpa2-wpa3-transition': 'WPA2/3',
    'wpa3-only': 'WPA3',
    enterprise: '802.1X',
    unknown: '?',
};
export function networkBadge(n = {}) {
    return n.known ? 'known' : (SECURITY_BADGE[n.security] || '?');
}

// A scanned network -> the join decision the renderer renders. `action`:
//   'reject'   — outside scope (WPA3-only / enterprise / unrecognized): show
//                `reject`, no join; `diag` (unknown only) carries the sanitized
//                raw auth/enc for a diagnostics tooltip, never the primary text.
//   'open'     — open network: show `warn` (unencrypted), JOIN with no password;
//                the manager installs an open profile when there is no saved one.
//   'join'     — a saved profile: connect directly, no prompt, NOTHING built.
//   'password' — a secured network with no saved profile: prompt for a key
//                (`note` carries a caution for the transition kind).
// A SAVED network is always `join` (connect via the existing Windows profile —
// no new profile constructed, no speculation), so an `unknown`-security network
// that Windows already has a profile for still joins; only a NEW unknown network
// is rejected conservatively (never a speculative WPA2 profile/join — audit B3).
// The manager is passed `{ security, known }` so its own backstop matches.
export function joinPlan(n = {}) {
    const security = n.security || 'unknown';
    if (security === 'wpa3-only') return { action: 'reject', security, reject: WPA3_ONLY_MESSAGE };
    if (security === 'enterprise') return { action: 'reject', security, reject: ENTERPRISE_MESSAGE };
    if (security === 'open') return { action: 'open', security, warn: OPEN_NETWORK_WARNING };
    if (n.known) return { action: 'join', security };            // saved profile — build nothing
    if (security === 'wpa2-wpa3-transition') return { action: 'password', security, note: TRANSITION_NOTE };
    if (security === 'unknown') return { action: 'reject', security, reject: UNKNOWN_SECURITY_MESSAGE, diag: securityDiag(n) };
    return { action: 'password', security }; // wpa2-personal, no saved profile
}

// A failed wifi:join result -> a SHORT summary line + the full technical detail
// (audit 2E / Windows observation #5). The manager already classified the
// failure with a `kind` and redacted + capped its `error`; this splits it into
// a terse uppercase status (which can never overlap other UI) and an expandable
// DETAILS body. `hasDetail` is false when the detail adds nothing over the
// summary, so the DETAILS box stays hidden rather than echoing the headline.
const JOIN_ERROR_SUMMARY = {
    'adapter-missing': 'ADAPTER REMOVED',
    'add-profile-failed': 'COULD NOT SAVE NETWORK PROFILE',
    'connect-failed': 'CONNECT COMMAND FAILED',
    'status-unavailable': 'COULD NOT VERIFY CONNECTION',
    'join-timeout': 'JOIN TIMED OUT',
};
export function classifyJoinError(res = {}) {
    const summary = JOIN_ERROR_SUMMARY[res.kind] || 'JOIN FAILED';
    const detail = String(res.error || '').trim();
    return { kind: res.kind || 'unknown', summary, detail, hasDetail: !!detail && detail.toUpperCase() !== summary };
}

// scan result -> the join pane's status line. A failed scan (radio off, WLAN
// service down) is NOT an empty airspace — show the reason.
export function scanStatusText(res = {}) {
    if (res.ok === false) return `SCAN FAILED — ${res.error || 'unknown error'}`;
    return (res.networks || []).length ? '' : 'NO NETWORKS FOUND';
}

// Hotspot lifecycle snapshot (main/hotspotLifecycle.js, mirrored over IPC) ->
// the HOTSPOT pane's controls and text (audit B1/N3). Pure decisions only;
// setupFlow.js renders what comes back. Field meanings:
//   status  — the pane's status line;
//   live    — teal LIVE styling; warn — amber styling;
//   hint    — second line (troubleshooting / suggestion), '' = hidden;
//   detail  — a list of longer technical lines for the expandable DETAILS box
//     (2E: kept out of the status line so it can never overlap); [] = hidden;
//   start/stop/inputs — control enablement (conflicting controls are disabled
//     during STARTING/STOPPING; STOP is enabled ONLY while this app owns the
//     hotspot — an externally running hotspot never gets a usable STOP);
//   recheck — offer the RECHECK SUPPORT re-probe button;
//   reverify — offer the REVERIFY (re-run the local DHCP/ICS readiness check)
//     button; only while a hotspot is live and a verifier exists.
// The lifecycle phase always outranks the capability probe: a LIVE hotspot is
// LIVE regardless of what a (re)probe would currently say. A LIVE hotspot whose
// local readiness has NOT verified (Windows observation #4) is never shown as a
// plain success — degraded/verifying/interrupted states are distinct.
export function hotspotPaneState(snap) {
    const view = (status, over = {}) => ({
        status, live: false, warn: false, hint: '', detail: [], start: false, stop: false, inputs: false, recheck: false, reverify: false, ...over,
    });
    if (!snap) {
        // The state mirror itself is unavailable (state IPC rejected): keep
        // every control off rather than guessing an ownership state.
        return view('HOTSPOT STATE UNAVAILABLE — leave and re-enter PIT WALL to retry', { warn: true });
    }
    if (snap.phase === 'starting') return view('STARTING HOTSPOT…');
    if (snap.phase === 'stopping') return view('STOPPING HOTSPOT…');
    if (snap.phase === 'live') {
        if (snap.lastError && snap.lastError.kind === 'stop-failed') {
            return view(`STOP FAILED — ${snap.lastError.error || 'unknown error'}`, {
                warn: true,
                hint: 'the hotspot is still running and still owned by this app — STOP HOTSPOT to retry',
                stop: true,
            });
        }
        if (snap.lastError) {
            // Config-mismatch partial start: broadcasting, app-owned, wrong
            // SSID — never presented with the normal "join it" success line.
            return view('HOTSPOT RUNNING WITH THE WRONG NETWORK NAME', {
                warn: true,
                hint: snap.lastError.error || 'press STOP HOTSPOT, then retry',
                stop: true,
            });
        }
        // Adapter loss while live (Windows observation #3): the radio cannot be
        // broadcasting with its adapter gone, so LIVE would be a false state.
        if (snap.interrupted) {
            return view('HOTSPOT INTERRUPTED — WLAN adapter lost while live', {
                warn: true,
                hint: `${snap.interrupted} — press STOP HOTSPOT to clean up, reconnect the adapter, then start again`,
                stop: true,
            });
        }
        const liveLine = `LIVE (${snap.backend}) — join "${snap.ssid}" on the iPhone${snap.hostIp ? ` · this PC: ${snap.hostIp}` : ''}`;
        const readiness = snap.readiness || { status: 'idle', reasons: [] };
        // Honest readiness (Windows observation #4): a start-command success is
        // NOT client-readiness. Until the local ICS/gateway/service checks pass
        // the pane says VERIFYING; a failed check says DEGRADED (never a plain
        // join-it success); only 'verified' or 'idle' (no verifier) shows LIVE.
        if (readiness.status === 'verifying') {
            return view(`${liveLine} · VERIFYING READINESS…`, { live: true, stop: true });
        }
        if (readiness.status === 'degraded') {
            const reasons = readiness.reasons || [];
            return view(`LIVE (${snap.backend}) — NOT READY FOR CLIENTS`, {
                warn: true,
                hint: reasons[0] || 'a local readiness check failed — clients may stall at "Obtaining IP address"',
                detail: reasons,
                stop: true,
                reverify: true,
            });
        }
        if (readiness.status === 'verified') {
            return view(`${liveLine} · READY`, { live: true, stop: true, reverify: true });
        }
        // idle: no verifier available on this platform — plain LIVE, unchanged.
        return view(liveLine, { live: true, stop: true });
    }
    // INACTIVE: the capability probe and the last failure govern the controls.
    const probe = snap.probe || { status: 'idle' };
    if (probe.status === 'probing' || probe.status === 'idle') {
        return view('CHECKING HOTSPOT SUPPORT…', { inputs: true });
    }
    if (probe.status === 'failed') {
        return view('HOTSPOT SUPPORT CHECK FAILED — RECHECK to retry', { warn: true, inputs: true, recheck: true });
    }
    if (probe.status === 'unsupported') {
        return view('HOTSPOT NOT SUPPORTED ON THIS MACHINE — join a network instead', { warn: true, recheck: true });
    }
    if (probe.externallyActive) {
        return view('A HOTSPOT IS ALREADY RUNNING ON THIS MACHINE (not started by this app)', {
            warn: true,
            hint: 'use it as-is, or stop it in Windows Settings and RECHECK',
            recheck: true,
        });
    }
    if (snap.lastError) {
        return view(snap.lastError.error || 'HOTSPOT START FAILED', {
            warn: true,
            hint: snap.lastError.suggestion || '',
            start: true,
            inputs: true,
            recheck: true,
        });
    }
    return view(`READY — ${probe.backend || 'hotspot'} backend`, { start: true, inputs: true });
}
