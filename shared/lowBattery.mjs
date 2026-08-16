// Low-battery banner model (vision operator model: "Unmissable low battery" —
// lights already pulse on the car; the HUD banner is the ground-side half, and
// UX carries the entire burden because the warn-never-auto-cut safety invariant
// stands). Pure + clock-free so it unit-tests with plain numbers. ESM (.mjs):
// consumers are the renderer (hud.js derives the level from the telemetry it
// already receives — no new preload/IPC key) and vitest. The Electron main
// process never computes this; shared/settings.js carries a deliberate CJS
// mirror of normalizeLowBatterySettings for the persistence path (the
// wheelProfile.mjs precedent), kept honest by the corpus parity test in
// test/lowBatteryPersist.test.js.
//
// The thresholds are PACK volts (what the CRSF battery sensor reports and the
// BATT panel already shows), not per-cell: the viewer has no cell-count field.
// Defaults assume the W17's 2S LiPo — warn at 3.5 V/cell = 7.0 V pack, critical
// at 3.3 V/cell = 6.6 V pack — and both are configurable (⚙ + settings.json)
// so a future pack never means editing code.
//
// Display only: this module classifies a voltage for a BANNER. It commands
// nothing — the firmware's warning-only battery invariant is untouched.

export const DEFAULT_LOW_BATTERY = Object.freeze({ warnV: 7, criticalV: 6.6 });

// Hysteresis: a LiPo sags under throttle and recovers at idle, so a pack
// hovering at a threshold would flap the banner every stab of throttle. A level
// is ENTERED the instant the voltage touches its threshold (never late — this
// is a safety cue) but EXITS only after the voltage recovers this far above it.
export const LOW_BATTERY_HYSTERESIS_V = 0.15;

// Sanity band for persisted thresholds (volts). Wide on purpose — pack volts
// for any plausible future battery, not just 2S — while rejecting the classic
// unit mistakes (0, negative, millivolts). Out-of-band values repair to the
// defaults field-by-field, the settings.js house style.
export const LOW_BATTERY_MIN_V = 1;
export const LOW_BATTERY_MAX_V = 60;

// The exact banner copy, exported so the wording has one source of truth (the
// ARM_*_LABEL pattern). Plain language by requirement (operator model: the
// giftee is not a hobbyist): what happened + what to do, no volts jargon —
// the BATT panel next to it already shows the number.
export const LOW_BATTERY_LABELS = Object.freeze({
    warn: 'BATTERY LOW — finish your lap and park',
    critical: 'BATTERY CRITICAL — park the car now',
});

const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= LOW_BATTERY_MIN_V && n <= LOW_BATTERY_MAX_V ? n : null;
};

// Coerce a persisted (possibly partial, wrong-typed, or hostile) blob into a
// valid threshold pair, filling from DEFAULT_LOW_BATTERY. Never throws. The
// one cross-field rule: critical may never sit ABOVE warn (the banner would
// jump straight to CRITICAL with no warning stage), so an inverted pair is
// repaired by lowering critical to warn — the conservative direction.
export function normalizeLowBatterySettings(raw) {
    const r = (raw && typeof raw === 'object') ? raw : {};
    const warnV = num(r.warnV) ?? DEFAULT_LOW_BATTERY.warnV;
    let criticalV = num(r.criticalV) ?? DEFAULT_LOW_BATTERY.criticalV;
    if (criticalV > warnV) criticalV = warnV;
    return { warnV, criticalV };
}

// One classification step: previous level in, next level out ('ok' | 'warn' |
// 'critical'). The caller (hud.js render()) feeds it every frame and keeps the
// returned level as the next call's prevLevel — the hysteresis memory lives in
// that one variable, nowhere else.
//
//   enter:  v <= criticalV            -> 'critical'   (immediate, never late)
//           v <= warnV                -> 'warn'
//   exit:   only after recovering HYSTERESIS_V above the level's own threshold,
//           and only one level at a time (critical steps down through warn).
//
// A batteryV that is not an actual finite number returns 'ok' — no reading,
// no claim; the renderer hides the banner whenever telemetry has never been
// live anyway. Deliberately NO coercion here (unlike the thresholds, which
// come from settings.json/⚙ where strings happen): a live telemetry field is
// a number or it is nothing — Number(null) is 0, and a null reading must not
// classify as a 0 V pack.
export function lowBatteryLevel({ batteryV, prevLevel = 'ok', thresholds } = {}) {
    const t = normalizeLowBatterySettings(thresholds);
    const v = batteryV;
    if (typeof v !== 'number' || !Number.isFinite(v)) return 'ok';
    if (v <= t.criticalV) return 'critical';
    if (prevLevel === 'critical' && v < t.criticalV + LOW_BATTERY_HYSTERESIS_V) return 'critical';
    if (v <= t.warnV) return 'warn';
    if ((prevLevel === 'warn' || prevLevel === 'critical') && v < t.warnV + LOW_BATTERY_HYSTERESIS_V) return 'warn';
    return 'ok';
}
