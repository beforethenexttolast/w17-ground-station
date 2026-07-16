// Steering-wheel input model for the HUD mirror. ESM, pure, renderer-safe
// (no Node/Electron imports — imported directly like shared/inputPresets.mjs).
// This ONLY affects what the on-screen HUD mirrors; driving stays with
// elrs-joystick-control, which reads the device itself. VIEWER-ONLY: nothing
// here reaches a control output.
//
// Why a SEPARATE module from inputPresets.mjs: `PRESETS` is frozen and pinned
// bit-identical for the DualShock layout, and it models throttle/brake as
// digital BUTTONS (`throttleBtn`/`brakeBtn`). A wheel reports its pedals as
// analog AXES that often rest at one extreme (e.g. +1 released, -1 floored) and
// need per-device rest/full calibration. That shape does not fit the button
// preset, so the wheel gets its own profile with axis pedals + calibration.
//
// Inversion is IMPLICIT in the rest/full ordering: a pedal that rests at +1 and
// floors at -1 is simply rest:+1, full:-1 — no separate "inverted" flag.

// The default profile: sensible axis/button indices for a generic wheel plus the
// classic "rests high, floors low" pedal calibration (rest +1 → full -1). It is
// only a STARTING POINT for the SEAT FIT assign/calibrate UI; the persisted
// per-device profile overrides it (normalizeWheelSettings). Frozen so a caller
// cannot mutate the shared default; callers build patched copies instead.
export const DEFAULT_WHEEL_PROFILE = Object.freeze({
    steer: Object.freeze({ axis: 0 }),
    pedalMode: 'separate', // 'separate' | 'combined'
    throttle: Object.freeze({ axis: 1, rest: 1, full: -1 }),
    brake: Object.freeze({ axis: 2, rest: 1, full: -1 }),
    // Combined single-axis pedal: rests in the MIDDLE, one direction is throttle,
    // the other is brake (some wheels expose gas+brake on one combined axis).
    combined: Object.freeze({ axis: 1, rest: 0, throttleEnd: 1, brakeEnd: -1 }),
    deadzone: 0.05,
    buttons: Object.freeze({
        gearUp: 5, gearDown: 4, drs: 3, boost: 1, overtake: 2,
    }),
});

const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);
const clampAxis = (n) => (n < -1 ? -1 : n > 1 ? 1 : n);
const finite = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// Normalized pedal travel in [0, 1] from a raw axis reading, given the device's
// calibrated rest/full endpoints and a deadzone. The mapping is
// t = (raw - rest) / (full - rest), which handles either travel direction, so
// inversion is implicit in whether rest < full or rest > full. The deadzone is
// applied in the NORMALIZED domain near rest and rescaled so the curve stays
// continuous (no jump at the edge of the zone) and still reaches 1.0 at full.
// A missing/non-finite raw reads as REST → 0, so a disconnect resolves to
// "pedal released", never a stale value (mirrors axisValues' neutral behaviour).
export function pedalValue(raw, { rest = 0, full = 1, deadzone = 0 } = {}) {
    const r = finite(rest) ?? 0;
    const f = finite(full) ?? 1;
    const span = f - r;
    if (span === 0) return 0; // degenerate calibration — no travel
    const x = finite(raw);
    if (x === null) return 0; // missing axis → released
    let t = clamp01((x - r) / span);
    const dz = clamp01(finite(deadzone) ?? 0);
    if (dz >= 1) return 0;
    if (t <= dz) return 0;
    return (t - dz) / (1 - dz);
}

// Split a single COMBINED pedal axis into independent throttle/brake travels.
// rest sits between the two ends; pushing toward throttleEnd fills thr while brk
// stays 0 (the opposite-direction normalization clamps to 0), and vice versa.
// Reuses pedalValue so the deadzone and clamping behave identically per side.
export function splitCombined(raw, { rest = 0, throttleEnd = 1, brakeEnd = -1, deadzone = 0 } = {}) {
    return {
        thr: pedalValue(raw, { rest, full: throttleEnd, deadzone }),
        brk: pedalValue(raw, { rest, full: brakeEnd, deadzone }),
    };
}

// Read the mirrored wheel values for a pad through a profile: steering axis in
// [-1, 1] plus throttle/brake in [0, 1]. Honors the profile's pedalMode. A
// missing pad / short axes array reads neutral (steer 0, pedals released) — the
// same disconnect-safe behaviour as inputPresets.axisValues.
export function wheelValues(pad, profile = DEFAULT_WHEEL_PROFILE) {
    const p = profile || DEFAULT_WHEEL_PROFILE;
    const ax = (pad && pad.axes) || [];
    const readAxis = (i) => { const n = finite(ax[i]); return n === null ? 0 : clampAxis(n); };
    const steer = readAxis((p.steer && p.steer.axis) || 0);
    const dz = p.deadzone;
    if (p.pedalMode === 'combined') {
        const c = p.combined || {};
        const { thr, brk } = splitCombined(ax[c.axis], { ...c, deadzone: dz });
        return { steer, thr, brk };
    }
    const t = p.throttle || {};
    const b = p.brake || {};
    return {
        steer,
        thr: pedalValue(ax[t.axis], { rest: t.rest, full: t.full, deadzone: dz }),
        brk: pedalValue(ax[b.axis], { rest: b.rest, full: b.full, deadzone: dz }),
    };
}

// SEAT FIT live highlight: which mirrored wheel BUTTON roles are pressed right
// now. Buttons only (mirrors inputPresets.pressedRoles) — pedals are axes, read
// via wheelValues, and an UNASSIGNED role (index null) is simply skipped.
export const WHEEL_BUTTON_ROLES = ['gearUp', 'gearDown', 'drs', 'boost', 'overtake'];
const PRESS_THRESHOLD = 0.05; // analog buttons count as pressed past this

export function pressedWheelRoles(pad, profile = DEFAULT_WHEEL_PROFILE) {
    if (!pad || !pad.buttons) return [];
    const buttons = (profile && profile.buttons) || {};
    const roles = [];
    for (const role of WHEEL_BUTTON_ROLES) {
        const idx = buttons[role];
        if (typeof idx !== 'number') continue; // unassigned role
        const btn = pad.buttons[idx];
        if (btn && (btn.pressed || btn.value > PRESS_THRESHOLD)) roles.push(role);
    }
    return roles;
}

// Listen-to-assign diff for the SEAT FIT calibration UI: compare a previous pad
// snapshot to the current pad and report the single most salient CHANGE, so a
// role can be assigned by pressing its button or moving its axis. Called on the
// existing 250ms tick with the snapshot from the previous tick.
//   - A newly PRESSED button → { type: 'button', index }.
//   - Otherwise, the axis that moved farthest past axisThreshold →
//     { type: 'axis', index, delta } (signed delta, so calibration can tell
//     which direction was pushed).
//   - Nothing salient → null.
// Buttons win over axes: a deliberate press is unambiguous, while a pedal at
// rest can jitter. Both prev and pad are read defensively (missing → released /
// neutral) so a mid-listen disconnect cannot throw.
const BUTTON_ASSIGN_THRESHOLD = 0.5; // clear press, above pedal/trigger noise
const isPressed = (b) => !!b && (b.pressed || Number(b.value) > BUTTON_ASSIGN_THRESHOLD);

export function detectInputChange(prev, pad, { axisThreshold = 0.4 } = {}) {
    const prevBtns = (prev && prev.buttons) || [];
    const curBtns = (pad && pad.buttons) || [];
    for (let i = 0; i < curBtns.length; i++) {
        if (isPressed(curBtns[i]) && !isPressed(prevBtns[i])) {
            return { type: 'button', index: i };
        }
    }
    const prevAx = (prev && prev.axes) || [];
    const curAx = (pad && pad.axes) || [];
    let best = null;
    for (let i = 0; i < curAx.length; i++) {
        const a = finite(curAx[i]);
        const b = finite(prevAx[i]);
        if (a === null || b === null) continue;
        const delta = a - b;
        if (Math.abs(delta) > axisThreshold && (!best || Math.abs(delta) > Math.abs(best.delta))) {
            best = { type: 'axis', index: i, delta };
        }
    }
    return best;
}

// Coerce a persisted (possibly corrupt) settings blob into a valid wheel
// profile, filling every field from DEFAULT_WHEEL_PROFILE. Persisted settings
// can be partial, wrong-typed, or hostile, so every value is validated: axis
// indices become non-negative integers, calibration endpoints clamp into
// [-1, 1], the deadzone into [0, 1), pedalMode is whitelisted, and each button
// is a non-negative integer index or null (unassigned). Never throws.
const axisIndex = (v, dflt) => {
    const n = finite(v);
    return n !== null && n >= 0 ? Math.floor(n) : dflt;
};
const buttonIndex = (v) => {
    const n = finite(v);
    return n !== null && n >= 0 ? Math.floor(n) : null;
};
const cal = (v, dflt) => { const n = finite(v); return n === null ? dflt : clampAxis(n); };

export function normalizeWheelSettings(raw) {
    const r = (raw && typeof raw === 'object') ? raw : {};
    const D = DEFAULT_WHEEL_PROFILE;
    const t = (r.throttle && typeof r.throttle === 'object') ? r.throttle : {};
    const b = (r.brake && typeof r.brake === 'object') ? r.brake : {};
    const c = (r.combined && typeof r.combined === 'object') ? r.combined : {};
    const s = (r.steer && typeof r.steer === 'object') ? r.steer : {};
    const btn = (r.buttons && typeof r.buttons === 'object') ? r.buttons : {};
    const dz = finite(r.deadzone);
    return {
        steer: { axis: axisIndex(s.axis, D.steer.axis) },
        pedalMode: r.pedalMode === 'combined' ? 'combined' : 'separate',
        throttle: {
            axis: axisIndex(t.axis, D.throttle.axis),
            rest: cal(t.rest, D.throttle.rest),
            full: cal(t.full, D.throttle.full),
        },
        brake: {
            axis: axisIndex(b.axis, D.brake.axis),
            rest: cal(b.rest, D.brake.rest),
            full: cal(b.full, D.brake.full),
        },
        combined: {
            axis: axisIndex(c.axis, D.combined.axis),
            rest: cal(c.rest, D.combined.rest),
            throttleEnd: cal(c.throttleEnd, D.combined.throttleEnd),
            brakeEnd: cal(c.brakeEnd, D.combined.brakeEnd),
        },
        deadzone: dz === null ? D.deadzone : (dz < 0 ? 0 : dz >= 1 ? 0.99 : dz),
        // Derived from WHEEL_BUTTON_ROLES (single source of truth shared with
        // pressedWheelRoles) so a new/renamed role can never be silently dropped
        // from persisted settings. An explicit null is a deliberate unassign and
        // is preserved; any other garbage repairs to the default index.
        buttons: Object.fromEntries(WHEEL_BUTTON_ROLES.map((role) => [
            role,
            btn[role] === null ? null : buttonIndex(btn[role]) ?? D.buttons[role],
        ])),
    };
}
