// Pure GRID checklist engine. ESM (renderer + vitest). No IO: the renderer
// polls its probes and feeds plain results in; this module only decides which
// checks apply, their status, and whether the primary START may enable.
//
// Engine-level invariant (by decision): the START ANYWAY override is ALWAYS
// allowed — canStart() gates only the primary button. A viewer checklist must
// never be able to lock the driver out of the HUD.

export const OVERRIDE_ALWAYS_ALLOWED = true;

// effective: { mode, telemetryConfigured, elrsConfigured }
// Every check carries a fix `hint` — the renderer shows it ONLY while the
// check is failing, so a red row always says what to do about it.
export function buildChecklist({ mode, telemetryConfigured = false, elrsConfigured = false } = {}) {
    const checks = [
        {
            id: 'video-lock', label: 'VIDEO LOCK', required: true,
            hint: 'no video — camera on? mediamtx path? WebRTC needs H.264 (docs/SETUP.md)',
        },
        {
            id: 'controller', label: 'CONTROLLER', required: true,
            hint: 'connect a pad and press any button — or drive with the keyboard',
        },
    ];
    if (telemetryConfigured) {
        checks.push({
            id: 'telemetry', label: 'TELEMETRY', required: true,
            hint: 'check telemetry source + COM port in ⚙',
        });
    }
    if (mode === 'iphone-hud') {
        checks.push({
            id: 'iphone-reachable', label: 'IPHONE REACHABLE', required: true,
            hint: 'both devices on the same non-isolated network? guest Wi-Fi often blocks device-to-device — use the hotspot',
        });
    }
    // elrs-joystick-control drives the car; only meaningful when a path is
    // configured — otherwise the row shows as skipped, never blocks.
    checks.push({
        id: 'elrs-running', label: 'ELRS CONTROL', required: elrsConfigured,
        hint: 'set the elrs-joystick-control path in ⚙, then LAUNCH',
    });
    return checks.map((c) => ({ ...c, status: 'pending' }));
}

// results: { [id]: true | false | undefined | 'skipped' }
export function applyProbes(checks, results = {}) {
    return checks.map((c) => {
        const r = results[c.id];
        const status = r === true ? 'ok'
            : r === false ? 'fail'
            : r === 'skipped' ? 'skipped'
            : 'pending';
        return { ...c, status };
    });
}

export function canStart(checks) {
    return checks.every((c) => !c.required || c.status === 'ok' || c.status === 'skipped');
}
