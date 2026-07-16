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

// Deduplicate the raw navigator.getGamepads() list for DISPLAY (SEAT FIT device
// rows). The Gamepad API exposes each connected device in its own stable slot
// (`index`); we key on that so a doubled reference to the SAME slot collapses to
// one row, while two genuinely distinct devices (even two identical pads with an
// equal `id`) are BOTH preserved. We deliberately do NOT dedupe by `id`: that
// would hide a second identical controller. The limit stated honestly — if one
// physical pad is enumerated twice by two OS backends (XInput + DirectInput on
// Windows) it occupies two slots with (often) the same id, and the Gamepad API
// gives no reliable way to prove they are the same unit; that case needs Windows
// validation, not a guess here.
export function dedupeGamepads(pads) {
    const seen = new Set();
    const out = [];
    for (const p of (pads || [])) {
        if (!p) continue;
        const key = typeof p.index === 'number' ? `#${p.index}` : `id:${p.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(p);
    }
    return out;
}

// A SESSION-STABLE display identity for a connected gamepad: the OS slot index
// PLUS the model id (task §3). Within one running session the Gamepad API keeps a
// device in a stable `index`, so index+id distinguishes two IDENTICAL controllers
// (same id, different slot) that `id` alone cannot. It is deliberately NOT a
// hardware identity: across app/OS restarts the OS may assign a different index,
// and identical devices carry the same id — so this key must never be persisted
// as if it pinned a specific unit (see resolveSelectedPad + docs). The unit
// separator keeps a weird id from colliding two keys.
const KEY_SEP = '␟';
export function gamepadKey(pad) {
    if (!pad) return '';
    const idx = typeof pad.index === 'number' ? pad.index : '?';
    return `#${idx}${KEY_SEP}${pad.id}`;
}

// Pick the pad the SEAT FIT mirror follows, from a session-stable CHOSEN KEY
// (gamepadKey: slot index + id). Rules (task §3):
//   - No explicit choice yet (chosenKey '') → follow the first connected slot,
//     the auto default (matches the original first-pad behaviour).
//   - An explicit choice → match it EXACTLY by session key, so two identical pads
//     in different slots stay independently selectable and a click selects
//     exactly one.
//   - If the chosen device is gone — a disconnect, or a reconnect the OS put in a
//     DIFFERENT slot — return null: the selection is MISSING. We do NOT silently
//     fall through to an identical peer or to another slot; that would fabricate a
//     device switch the operator never made. Honest behaviour: the caller shows
//     "no controller" for the selection and the operator re-picks.
export function resolveSelectedPad(pads, { chosenKey = '' } = {}) {
    const list = (pads || []).filter(Boolean);
    if (!list.length) return null;
    if (!chosenKey) return list[0];
    return list.find((p) => gamepadKey(p) === chosenKey) || null;
}

// Transport (USB vs Bluetooth) is NOT reliably derivable from the browser
// Gamepad API — `Gamepad.id` carries the model, occasionally a vendor id, but no
// dependable bus/transport field across Chromium/OS combinations. Per the task's
// rule we never guess: the label is always UNKNOWN here. (A future SDL/mapper
// diagnostics source could report transport; that is the mapper's authority, not
// this viewer's — see docs/camera_aim_display_semantics.md §3.)
export const TRANSPORT_UNKNOWN = 'UNKNOWN';
export function transportLabel(/* pad */) {
    return TRANSPORT_UNKNOWN;
}

// Read the mirrored ANALOG axes for a pad through the chosen preset map, clamped
// to [-1, 1]. Display-only (SEAT FIT stick mirror + test strip): steering is the
// left stick X; camPan/camTilt are the right stick X/Y. A missing pad/axis reads
// as neutral 0 so a disconnect resolves to center, never a stale deflection.
export function axisValues(pad, presetKey) {
    const m = getPreset(presetKey).map;
    const ax = (pad && pad.axes) || [];
    const c = (i) => { const n = Number(ax[i]); return Number.isFinite(n) ? (n < -1 ? -1 : n > 1 ? 1 : n) : 0; };
    return { steer: c(m.steerAxis), camPan: c(m.camPanAxis), camTilt: c(m.camTiltAxis) };
}

// What is actually driving the mirror right now — for the SEAT FIT input-source
// badge (task §5: never show NO CONTROLLER beside a live axis unless it is
// explicitly marked simulation). `demo` is the HUD preview/replay path; a pad
// present means live controller; otherwise no controller and the keyboard
// fallback stands. This decides only the LABEL — the caller still reads neutral
// axes when there is no pad, so the visualization cannot animate under NONE.
export function inputSourceView({ pad = null, demo = false } = {}) {
    if (demo) return { source: 'simulated', label: 'SIMULATED · PREVIEW', live: false };
    if (pad) return { source: 'live', label: 'LIVE CONTROLLER', live: true };
    return { source: 'none', label: 'NO CONTROLLER · KEYBOARD FALLBACK', live: false };
}
