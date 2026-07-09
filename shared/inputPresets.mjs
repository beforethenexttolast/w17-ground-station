// Controller layout presets + gamepad selection for the HUD mirror. ESM
// (renderer imports it directly, like shared/linkState.mjs); pure and
// unit-tested. This ONLY affects what the on-screen HUD mirrors — driving
// stays with elrs-joystick-control, which reads the pad itself.
//
// Chromium normalizes DualShock and Xbox pads to the "standard" mapping, so
// the indices genuinely coincide; the presets differ in the human-readable
// button names the SEAT FIT test strip shows, and exist as the seam where a
// genuinely different layout would slot in without touching hud.js.

export const DEFAULT_PRESET = 'dualshock';

// The dualshock map is the HUD's original hardcoded layout, pinned by test —
// selecting it (or having no settings at all) is bit-identical to before.
const STANDARD_MAP = Object.freeze({
    steerAxis: 0,
    throttleBtn: 7,
    brakeBtn: 6,
    gearUpBtn: 5,
    gearDownBtn: 4,
    drsBtn: 3,
    boostBtn: 1,
    overtakeBtn: 2,
    camPanAxis: 2,
    camTiltAxis: 3,
});

export const PRESETS = Object.freeze({
    dualshock: Object.freeze({
        label: 'DualShock',
        map: STANDARD_MAP,
        buttonNames: Object.freeze({
            throttle: 'R2', brake: 'L2', gearUp: 'R1', gearDown: 'L1',
            drs: '△', boost: '○', overtake: '□',
        }),
    }),
    xbox: Object.freeze({
        label: 'Xbox',
        map: STANDARD_MAP,
        buttonNames: Object.freeze({
            throttle: 'RT', brake: 'LT', gearUp: 'RB', gearDown: 'LB',
            drs: 'Y', boost: 'B', overtake: 'X',
        }),
    }),
    generic: Object.freeze({
        label: 'Generic',
        map: STANDARD_MAP,
        buttonNames: Object.freeze({
            throttle: 'BTN 7', brake: 'BTN 6', gearUp: 'BTN 5', gearDown: 'BTN 4',
            drs: 'BTN 3', boost: 'BTN 1', overtake: 'BTN 2',
        }),
    }),
});

export function getPreset(name) {
    return PRESETS[name] || PRESETS[DEFAULT_PRESET];
}

// Pick the pad the HUD mirrors. Exact id match wins (persisted choice);
// otherwise first connected pad — the original behavior. Gamepad.id is stable
// per model but not per unit, so two identical pads fall back gracefully.
export function selectGamepad(pads, preferredId) {
    const list = [...(pads || [])].filter(Boolean);
    if (preferredId) {
        const exact = list.find((p) => p.id === preferredId);
        if (exact) return exact;
    }
    return list[0] || null;
}
