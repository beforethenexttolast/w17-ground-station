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
//
// HINT WORDING IS PLAIN LANGUAGE BY REQUIREMENT (vision operator model /
// 2026-08-16 audit defect 11): the operator is a non-hobbyist, so a failing
// row must say what happened and what to DO in gift-manual vocabulary —
// never mediamtx / WebRTC / H.264 / COM ports / repo file paths / component
// names. The technical detail stays where technicians look (docs/SETUP.md,
// console logs); test/checklist.test.js pins both the exact strings and the
// jargon ban. When editing a hint, keep the shape "what's wrong — what to do".
export function buildChecklist({ mode, telemetryConfigured = false, elrsConfigured = false } = {}) {
    const checks = [
        {
            id: 'video-lock', label: 'VIDEO LOCK', required: true,
            hint: 'no picture from the car — is the car switched on? give it a few seconds after power-on',
        },
        {
            id: 'controller', label: 'CONTROLLER', required: true,
            hint: 'controller not detected — plug it in or press the PS button (the keyboard arrows work too)',
        },
    ];
    if (telemetryConfigured) {
        checks.push({
            id: 'telemetry', label: 'TELEMETRY', required: true,
            hint: 'no data from the car yet — make sure the car is switched on, or check the telemetry settings in ⚙',
        });
    }
    if (mode === 'iphone-hud') {
        checks.push({
            id: 'iphone-reachable', label: 'IPHONE REACHABLE', required: true,
            hint: 'phone not reachable — put the phone and this computer on the same Wi-Fi, or use the hotspot',
        });
    }
    // elrs-joystick-control drives the car; only meaningful when a path is
    // configured — otherwise the row shows as skipped, never blocks. The hint
    // names it "the program that drives the car" (the giftee never learns the
    // component name) and leads with LAUNCH — the button the renderer puts on
    // this very row whenever a path is configured.
    checks.push({
        id: 'elrs-running', label: 'ELRS CONTROL', required: elrsConfigured,
        hint: 'the program that drives the car is not running — press LAUNCH, or set its location in ⚙',
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
