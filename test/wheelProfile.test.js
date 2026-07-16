import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_WHEEL_PROFILE, pedalValue, splitCombined, wheelValues,
  pressedWheelRoles, detectInputChange, normalizeWheelSettings,
  MAX_DEADZONE, WHEEL_BUTTON_ROLES, WHEEL_BUTTON_LABELS,
} from '../shared/wheelProfile.mjs';

// A wheel-shaped fake pad: axes plus optional buttons. Pedals are AXES here (the
// whole reason this module exists), so `axes` carries steering + pedal travel.
const pad = (axes = [], pressedByIndex = {}) => ({
  id: 'fake-wheel',
  axes,
  buttons: Array.from({ length: 12 }, (_, i) => {
    const p = pressedByIndex[i];
    return typeof p === 'number' ? { pressed: false, value: p } : { pressed: !!p, value: p ? 1 : 0 };
  }),
});

describe('DEFAULT_WHEEL_PROFILE', () => {
  it('is the documented shape and frozen (shared default cannot be mutated)', () => {
    expect(DEFAULT_WHEEL_PROFILE.steer.axis).toBe(0);
    expect(DEFAULT_WHEEL_PROFILE.pedalMode).toBe('separate');
    expect(DEFAULT_WHEEL_PROFILE.deadzone).toBe(0.05);
    expect(Object.keys(DEFAULT_WHEEL_PROFILE.buttons).sort())
      .toEqual(['boost', 'drs', 'gearDown', 'gearUp', 'overtake']);
    expect(Object.isFrozen(DEFAULT_WHEEL_PROFILE)).toBe(true);
    expect(Object.isFrozen(DEFAULT_WHEEL_PROFILE.throttle)).toBe(true);
    expect(() => { DEFAULT_WHEEL_PROFILE.deadzone = 1; }).toThrow();
  });
});

describe('pedalValue — rest/full calibration, inversion implicit in ordering', () => {
  const noDz = { deadzone: 0 };

  it('rest +1 → full -1 (classic "rests high, floors low"): full travel maps 1→0, -1→1', () => {
    expect(pedalValue(1, { rest: 1, full: -1, ...noDz })).toBe(0); // released
    expect(pedalValue(-1, { rest: 1, full: -1, ...noDz })).toBe(1); // floored
    expect(pedalValue(0, { rest: 1, full: -1, ...noDz })).toBeCloseTo(0.5, 6); // half
  });

  it('rest -1 → full +1 (opposite ordering) inverts the mapping: -1→0, +1→1', () => {
    expect(pedalValue(-1, { rest: -1, full: 1, ...noDz })).toBe(0);
    expect(pedalValue(1, { rest: -1, full: 1, ...noDz })).toBe(1);
    expect(pedalValue(0, { rest: -1, full: 1, ...noDz })).toBeCloseTo(0.5, 6);
  });

  it('rest 0 → full +1 (a centre-resting pedal)', () => {
    expect(pedalValue(0, { rest: 0, full: 1, ...noDz })).toBe(0);
    expect(pedalValue(1, { rest: 0, full: 1, ...noDz })).toBe(1);
    expect(pedalValue(0.25, { rest: 0, full: 1, ...noDz })).toBeCloseTo(0.25, 6);
  });

  it('clamps beyond the calibrated endpoints into [0, 1]', () => {
    expect(pedalValue(2, { rest: 0, full: 1, ...noDz })).toBe(1); // past full
    expect(pedalValue(-1, { rest: 0, full: 1, ...noDz })).toBe(0); // past rest (wrong side)
  });

  it('deadzone near rest reads 0 and rescales continuously to reach 1 at full', () => {
    // rest 0 → full 1, dz 0.1: values within 0.1 of rest are 0; the rest rescale
    // so full still hits exactly 1 and there is no jump at the zone edge.
    expect(pedalValue(0.05, { rest: 0, full: 1, deadzone: 0.1 })).toBe(0);
    expect(pedalValue(0.1, { rest: 0, full: 1, deadzone: 0.1 })).toBe(0);
    expect(pedalValue(1, { rest: 0, full: 1, deadzone: 0.1 })).toBe(1);
    expect(pedalValue(0.55, { rest: 0, full: 1, deadzone: 0.1 })).toBeCloseTo(0.5, 6);
  });

  it('missing / non-finite raw reads released (0), never NaN', () => {
    expect(pedalValue(undefined, { rest: 1, full: -1 })).toBe(0);
    expect(pedalValue(NaN, { rest: 1, full: -1 })).toBe(0);
    expect(pedalValue(undefined)).toBe(0); // no raw, default calibration → released
  });

  it('degenerate calibration (rest === full) yields 0, never a divide-by-zero', () => {
    expect(pedalValue(0.5, { rest: 1, full: 1 })).toBe(0);
    expect(pedalValue(0.5, { rest: 0, full: 0 })).toBe(0);
  });
});

describe('splitCombined — one axis into independent throttle/brake', () => {
  const c = { rest: 0, throttleEnd: 1, brakeEnd: -1, deadzone: 0 };

  it('rest gives both 0; throttle side fills thr and leaves brk 0; brake side vice versa', () => {
    expect(splitCombined(0, c)).toEqual({ thr: 0, brk: 0 });
    expect(splitCombined(1, c)).toEqual({ thr: 1, brk: 0 });
    expect(splitCombined(-1, c)).toEqual({ thr: 0, brk: 1 });
  });

  it('partial deflection scales the active side only', () => {
    const half = splitCombined(0.5, c);
    expect(half.thr).toBeCloseTo(0.5, 6);
    expect(half.brk).toBe(0);
    const brk = splitCombined(-0.25, c);
    expect(brk.thr).toBe(0);
    expect(brk.brk).toBeCloseTo(0.25, 6);
  });
});

describe('wheelValues — mirrored wheel readings (display only)', () => {
  it('separate mode: steer axis + independent throttle/brake pedal axes', () => {
    const profile = {
      steer: { axis: 0 }, pedalMode: 'separate',
      throttle: { axis: 1, rest: 1, full: -1 },
      brake: { axis: 2, rest: 1, full: -1 },
      deadzone: 0,
    };
    // steer -0.5; throttle floored (-1 → 1); brake released (+1 → 0)
    expect(wheelValues(pad([-0.5, -1, 1]), profile)).toEqual({ steer: -0.5, thr: 1, brk: 0 });
  });

  it('combined mode: a single pedal axis splits into throttle/brake', () => {
    const profile = {
      steer: { axis: 0 }, pedalMode: 'combined',
      combined: { axis: 1, rest: 0, throttleEnd: 1, brakeEnd: -1 },
      deadzone: 0,
    };
    expect(wheelValues(pad([0.2, 0.75]), profile)).toEqual({ steer: 0.2, thr: 0.75, brk: 0 });
    expect(wheelValues(pad([0.2, -0.75]), profile)).toEqual({ steer: 0.2, thr: 0, brk: 0.75 });
  });

  it('clamps steering into [-1, 1]', () => {
    const profile = { steer: { axis: 0 }, pedalMode: 'separate', throttle: {}, brake: {}, deadzone: 0 };
    expect(wheelValues(pad([-3]), profile).steer).toBe(-1);
    expect(wheelValues(pad([3]), profile).steer).toBe(1);
  });

  it('a missing pad / short axes array reads NEUTRAL (steer 0, pedals released)', () => {
    // The whole point of disconnect-safety: no stale deflection, pedals released.
    expect(wheelValues(null, DEFAULT_WHEEL_PROFILE)).toEqual({ steer: 0, thr: 0, brk: 0 });
    expect(wheelValues(undefined)).toEqual({ steer: 0, thr: 0, brk: 0 });
    expect(wheelValues(pad([]), DEFAULT_WHEEL_PROFILE)).toEqual({ steer: 0, thr: 0, brk: 0 });
  });

  it('uses DEFAULT_WHEEL_PROFILE when none is passed', () => {
    // default throttle rest +1 → an all-zero axes array means pedals half-pressed
    // is NOT asserted here; we only prove the call resolves and returns the shape.
    const v = wheelValues(pad([0.4]));
    expect(v).toHaveProperty('steer', 0.4);
    expect(v).toHaveProperty('thr');
    expect(v).toHaveProperty('brk');
  });
});

describe('pressedWheelRoles — SEAT FIT live highlight (buttons only)', () => {
  const profile = { buttons: { gearUp: 5, gearDown: 4, drs: 3, boost: 1, overtake: 2 } };

  it('maps pressed buttons to roles through the profile', () => {
    expect(pressedWheelRoles(pad([], { 5: true, 3: true }), profile).sort())
      .toEqual(['drs', 'gearUp']);
    expect(pressedWheelRoles(pad([], {}), profile)).toEqual([]);
  });

  it('analog buttons count via the value threshold', () => {
    expect(pressedWheelRoles(pad([], { 1: 0.5 }), profile)).toEqual(['boost']);
    expect(pressedWheelRoles(pad([], { 1: 0.03 }), profile)).toEqual([]);
  });

  it('an UNASSIGNED role (index null) is skipped, never throws', () => {
    const p = { buttons: { gearUp: 5, gearDown: null, drs: null, boost: null, overtake: null } };
    expect(pressedWheelRoles(pad([], { 5: true }), p)).toEqual(['gearUp']);
  });

  it('no pad / no buttons clears to empty (disconnect behaviour)', () => {
    expect(pressedWheelRoles(null, profile)).toEqual([]);
    expect(pressedWheelRoles({ id: 'x' }, profile)).toEqual([]);
  });

  it('deflected axes can never produce a button role', () => {
    expect(pressedWheelRoles(pad([1, 1, 1, 1], {}), profile)).toEqual([]);
  });
});

describe('detectInputChange — listen-to-assign diff (250ms tick)', () => {
  it('reports a newly PRESSED button', () => {
    const prev = pad([0, 0], {});
    const cur = pad([0, 0], { 4: true });
    expect(detectInputChange(prev, cur)).toEqual({ type: 'button', index: 4 });
  });

  it('reports the axis that moved farthest past the threshold, with a signed delta', () => {
    const prev = pad([0, 1, 0]);
    const cur = pad([0.1, -0.9, 0]); // axis 0 moved 0.1 (below), axis 1 moved -1.9
    const change = detectInputChange(prev, cur, { axisThreshold: 0.4 });
    expect(change.type).toBe('axis');
    expect(change.index).toBe(1);
    expect(change.delta).toBeCloseTo(-1.9, 6);
  });

  it('no salient change → null (jitter below threshold, no fresh press)', () => {
    const prev = pad([0, 0.5], { 4: true });
    const cur = pad([0.1, 0.6], { 4: true }); // small axis drift, button already held
    expect(detectInputChange(prev, cur, { axisThreshold: 0.4 })).toBeNull();
  });

  it('a button already held on the previous tick is NOT a new press', () => {
    const prev = pad([], { 3: true });
    const cur = pad([], { 3: true });
    expect(detectInputChange(prev, cur)).toBeNull();
  });

  it('a button wins over a simultaneous axis move (deliberate press is unambiguous)', () => {
    const prev = pad([0], {});
    const cur = pad([1], { 2: true });
    expect(detectInputChange(prev, cur, { axisThreshold: 0.4 })).toEqual({ type: 'button', index: 2 });
  });

  it('reads a missing prev/pad defensively (mid-listen disconnect never throws)', () => {
    expect(detectInputChange(null, null)).toBeNull();
    expect(detectInputChange(undefined, pad([0.9]), { axisThreshold: 0.4 })).toBeNull(); // no prev axis to diff
  });
});

describe('normalizeWheelSettings — corrupt/partial persisted settings', () => {
  it('garbage input returns a full valid profile matching the default shape', () => {
    for (const junk of [null, undefined, 42, 'nope', [], { pedalMode: 'chaos' }]) {
      const n = normalizeWheelSettings(junk);
      expect(n.steer.axis).toBe(0);
      expect(n.pedalMode).toBe('separate'); // whitelist rejects unknown modes
      expect(n.deadzone).toBe(DEFAULT_WHEEL_PROFILE.deadzone);
      expect(Object.keys(n.buttons).sort())
        .toEqual(['boost', 'drs', 'gearDown', 'gearUp', 'overtake']);
    }
  });

  it('clamps calibration endpoints into [-1, 1] and coerces bad axis indices', () => {
    const n = normalizeWheelSettings({
      steer: { axis: -3 },
      throttle: { axis: 'x', rest: 9, full: -9 },
      brake: { axis: 2.7, rest: 1, full: -1 },
    });
    expect(n.steer.axis).toBe(DEFAULT_WHEEL_PROFILE.steer.axis); // negative → default
    expect(n.throttle.axis).toBe(DEFAULT_WHEEL_PROFILE.throttle.axis); // NaN → default
    expect(n.throttle.rest).toBe(1); // clamped from 9
    expect(n.throttle.full).toBe(-1); // clamped from -9
    expect(n.brake.axis).toBe(2); // floored from 2.7
  });

  it('deadzone is clamped into [0, MAX_DEADZONE] — the same bound the SEAT FIT slider enforces (rider a)', () => {
    expect(normalizeWheelSettings({ deadzone: -1 }).deadzone).toBe(0);
    // Above the cap repairs to MAX_DEADZONE (not a near-1 value the slider could
    // never display / round-trip): the slider and the model agree on one bound.
    expect(normalizeWheelSettings({ deadzone: 5 }).deadzone).toBe(MAX_DEADZONE);
    expect(normalizeWheelSettings({ deadzone: MAX_DEADZONE }).deadzone).toBe(MAX_DEADZONE); // the cap itself is admitted
    expect(normalizeWheelSettings({ deadzone: 0.2 }).deadzone).toBe(0.2);
    expect(normalizeWheelSettings({ deadzone: 'x' }).deadzone).toBe(DEFAULT_WHEEL_PROFILE.deadzone);
  });

  it("accepts a valid 'combined' pedalMode and preserves valid combined calibration", () => {
    const n = normalizeWheelSettings({
      pedalMode: 'combined',
      combined: { axis: 3, rest: 0, throttleEnd: 1, brakeEnd: -1 },
    });
    expect(n.pedalMode).toBe('combined');
    expect(n.combined).toEqual({ axis: 3, rest: 0, throttleEnd: 1, brakeEnd: -1 });
  });

  it('preserves an explicit null button (deliberate unassignment) but repairs garbage to a default', () => {
    const n = normalizeWheelSettings({
      buttons: { gearUp: null, gearDown: 'bad', drs: 7, boost: -2, overtake: 2 },
    });
    expect(n.buttons.gearUp).toBeNull(); // deliberate unassign kept
    expect(n.buttons.gearDown).toBe(DEFAULT_WHEEL_PROFILE.buttons.gearDown); // garbage → default
    expect(n.buttons.drs).toBe(7); // valid index kept
    expect(n.buttons.boost).toBe(DEFAULT_WHEEL_PROFILE.buttons.boost); // negative → default
    expect(n.buttons.overtake).toBe(2);
  });

  it('a normalized profile is a valid input to wheelValues (round-trip is safe)', () => {
    const n = normalizeWheelSettings({ garbage: true });
    expect(() => wheelValues(pad([0, 0, 0]), n)).not.toThrow();
    const v = wheelValues(pad([0.3, 0, 0]), n);
    expect(v.steer).toBe(0.3);
  });
});

// The shared constants that keep the model, the SEAT FIT panel, and the wheel viz
// from drifting (Batch 7 riders a + b).
describe('shared wheel constants', () => {
  it('MAX_DEADZONE is a sane single-source bound and the default sits within it', () => {
    expect(MAX_DEADZONE).toBe(0.5);
    expect(DEFAULT_WHEEL_PROFILE.deadzone).toBeLessThanOrEqual(MAX_DEADZONE);
  });

  it('WHEEL_BUTTON_LABELS labels exactly the button roles — frozen, one per role (rider b)', () => {
    expect(Object.keys(WHEEL_BUTTON_LABELS).sort()).toEqual([...WHEEL_BUTTON_ROLES].sort());
    for (const role of WHEEL_BUTTON_ROLES) {
      expect(typeof WHEEL_BUTTON_LABELS[role], `${role} has a label`).toBe('string');
      expect(WHEEL_BUTTON_LABELS[role].length, `${role} label non-empty`).toBeGreaterThan(0);
    }
    // Literal glyphs, never HTML entities — both consumers assign them straight
    // into the DOM (innerHTML/textContent), so an entity would render as raw text.
    expect(WHEEL_BUTTON_LABELS.gearUp).toBe('GEAR ▲');
    expect(WHEEL_BUTTON_LABELS.gearDown).toBe('GEAR ▼');
    expect(Object.values(WHEEL_BUTTON_LABELS).join('')).not.toContain('&#');
    expect(Object.isFrozen(WHEEL_BUTTON_LABELS)).toBe(true);
  });
});

// The no-control-path directory sweep (test/noControlPath.test.js) auto-discovers
// every runtime .mjs under shared/. This mirrors its per-file scan so THIS batch
// proves the new module carries none of the forbidden control vocabulary — a
// fast local guard alongside the repo-wide sweep.
describe('wheelProfile.mjs is sweep-clean (no control-path vocabulary)', () => {
  it('the source carries no serial / RcChannels / head-tracking / dgram tokens', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../shared/wheelProfile.mjs', import.meta.url)),
      'utf8',
    );
    for (const forbidden of [
      'serialport', 'SerialPort', 'CrsfFrameBuilder', 'buildRcChannels',
      'encodeRcChannels', 'RcChannels', 'setPosition', 'setThrottle', 'ledc',
      'headTracking', 'HeadTracking', 'dgram',
    ]) {
      expect(src, `wheelProfile.mjs must not reference ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('the file is discovered under shared/ as a runtime .mjs (sweep will scan it)', () => {
    const sharedDir = fileURLToPath(new URL('../shared', import.meta.url));
    const mjs = readdirSync(sharedDir).filter((f) => extname(f) === '.mjs');
    expect(mjs).toContain('wheelProfile.mjs');
    // sanity: the sweep's REPO_ROOT/shared join resolves to a real dir
    expect(join(sharedDir, 'wheelProfile.mjs')).toContain('wheelProfile.mjs');
  });
});
