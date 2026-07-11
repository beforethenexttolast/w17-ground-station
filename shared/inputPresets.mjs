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

// Best-effort layout suggestion from Gamepad.id (Chromium ids carry the
// vendor: Sony 054c, Microsoft 045e). Informational only — it preselects
// the SEAT FIT label preset; the manual preset pills always override, and
// an unrecognized pad returns null (caller keeps the current choice).
const SONY_ID = /dualshock|dualsense|054c|sony|wireless controller/i;
const XBOX_ID = /xbox|xinput|045e|microsoft/i;
export function detectPresetFromId(id) {
    const s = String(id || '');
    if (SONY_ID.test(s)) return 'dualshock';
    if (XBOX_ID.test(s)) return 'xbox';
    return null;
}

// SEAT FIT live highlight: which mirrored BUTTON roles are currently pressed
// on this pad, through the chosen preset map. Read-only display support —
// buttons only, deliberately: the camera/right-stick axes are excluded, the
// same pan/tilt boundary the preview itself pins (renderer/padPreview.js).
const BUTTON_ROLES = Object.freeze({
    throttle: 'throttleBtn',
    brake: 'brakeBtn',
    gearUp: 'gearUpBtn',
    gearDown: 'gearDownBtn',
    drs: 'drsBtn',
    boost: 'boostBtn',
    overtake: 'overtakeBtn',
});
const PRESS_THRESHOLD = 0.05; // analog triggers count as pressed past this

export function pressedRoles(pad, presetKey) {
    if (!pad || !pad.buttons) return [];
    const map = getPreset(presetKey).map;
    const roles = [];
    for (const [role, mapKey] of Object.entries(BUTTON_ROLES)) {
        const b = pad.buttons[map[mapKey]];
        if (b && (b.pressed || b.value > PRESS_THRESHOLD)) roles.push(role);
    }
    return roles;
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
