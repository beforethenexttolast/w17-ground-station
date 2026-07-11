// Pure view-model for the PIT WALL network step. ESM (renderer + vitest), no
// IO: setupFlow.js feeds it the wifi IPC results and renders what comes back.
// Keeping the decisions here makes the adapter-row states and scan status
// text unit-testable without a DOM — repo style, like checklist.mjs.

// One adapter, one line: "Wi-Fi — Intel(R) Wi-Fi 6 AX201 160MHz · PaddockNet".
const ifaceLabel = (i) =>
    `${i.name}${i.description ? ` — ${i.description}` : ''}${i.connected ? ` · ${i.ssid}` : ''}`;

// listInterfaces result + the persisted adapter name -> what the ADAPTER row
// shows. The row is ALWAYS rendered where netsh exists (option A+E): a state
// you can read beats a picker that silently hides. Modes:
//   failed  — netsh broke: say so, with the reason (not "no adapters").
//   missing — zero adapters: dongle troubleshooting hint.
//   single  — readonly confirmation of the one adapter netsh will use.
//   select  — the picker; persisted choice restored while it still exists.
export function adapterRowState(res = {}, savedAdapter = '') {
    const ifaces = res.ifaces || [];
    if (res.ok === false) {
        return {
            mode: 'failed',
            label: 'ADAPTER LIST FAILED',
            hint: `netsh could not list WLAN adapters — ${res.error || 'unknown error'}`,
        };
    }
    if (ifaces.length === 0) {
        return {
            mode: 'missing',
            label: 'NO WLAN ADAPTER DETECTED',
            hint: 'USB Wi-Fi dongle not detected — check the port/driver, then RESCAN',
        };
    }
    if (ifaces.length === 1) {
        return { mode: 'single', label: ifaceLabel(ifaces[0]) };
    }
    const saved = savedAdapter && ifaces.some((i) => i.name === savedAdapter);
    return {
        mode: 'select',
        options: ifaces.map((i) => ({ value: i.name, label: ifaceLabel(i) })),
        selected: saved ? savedAdapter : ifaces[0].name,
        ...(savedAdapter && !saved
            ? { hint: `saved adapter "${savedAdapter}" not found — using ${ifaces[0].name}` }
            : {}),
    };
}

// scan result -> the join pane's status line. A failed scan (radio off, WLAN
// service down) is NOT an empty airspace — show the reason.
export function scanStatusText(res = {}) {
    if (res.ok === false) return `SCAN FAILED — ${res.error || 'unknown error'}`;
    return (res.networks || []).length ? '' : 'NO NETWORKS FOUND';
}
