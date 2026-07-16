import { describe, it, expect } from 'vitest';
import {
  PRESETS, DEFAULT_PRESET, getPreset, selectGamepad, detectPresetFromId, pressedRoles,
  dedupeGamepads, transportLabel, TRANSPORT_UNKNOWN, axisValues, inputSourceView,
  gamepadKey, resolveSelectedPad,
} from '../shared/inputPresets.mjs';

// The HUD's original hardcoded gamepad layout — the dualshock preset must
// stay bit-identical to it (regression pin for readInputs behavior).
const LEGACY_MAP = {
  steerAxis: 0, throttleBtn: 7, brakeBtn: 6, gearUpBtn: 5, gearDownBtn: 4,
  drsBtn: 3, boostBtn: 1, overtakeBtn: 2, camPanAxis: 2, camTiltAxis: 3,
};

describe('input presets', () => {
  it('default preset is dualshock and equals the legacy hardcoded map', () => {
    expect(DEFAULT_PRESET).toBe('dualshock');
    expect(PRESETS.dualshock.map).toEqual(LEGACY_MAP);
  });

  it('every preset defines the full action set (map + button names)', () => {
    const actions = Object.keys(LEGACY_MAP);
    const names = ['throttle', 'brake', 'gearUp', 'gearDown', 'drs', 'boost', 'overtake'];
    for (const [key, preset] of Object.entries(PRESETS)) {
      expect(preset.label, key).toBeTruthy();
      for (const a of actions) expect(preset.map[a], `${key}.map.${a}`).toBeTypeOf('number');
      for (const n of names) expect(preset.buttonNames[n], `${key}.buttonNames.${n}`).toBeTruthy();
    }
  });

  it('the generic preset uses short B<n> labels (display-only rename; index-preserving)', () => {
    // Decision #5: "BTN 7" → "B7" etc. The digit still names the Chromium
    // standard-mapping button index, so the labels stay index-preserving while
    // the MAP is untouched (verified above against LEGACY_MAP).
    expect(PRESETS.generic.buttonNames).toEqual({
      throttle: 'B7', brake: 'B6', gearUp: 'B5', gearDown: 'B4',
      drs: 'B3', boost: 'B1', overtake: 'B2',
    });
  });

  it('generic labels stay short (≤3 chars) — geometry guard for the pad-preview pills/captions', () => {
    // The redesigned padPreview crams name + role into 88px pills and centres
    // the BOOST caption at x256 so it clears the right-stick well; a long generic
    // label would break that. Pin the length so a future rename cannot regress it.
    for (const [role, name] of Object.entries(PRESETS.generic.buttonNames)) {
      expect(name.length, `generic ${role} label "${name}"`).toBeLessThanOrEqual(3);
    }
  });

  it('getPreset falls back to dualshock on unknown names', () => {
    expect(getPreset('warp')).toBe(PRESETS.dualshock);
    expect(getPreset('xbox')).toBe(PRESETS.xbox);
    expect(getPreset(undefined)).toBe(PRESETS.dualshock);
  });
});

describe('selectGamepad', () => {
  const padA = { id: 'DualSense Wireless Controller', index: 0 };
  const padB = { id: 'Xbox 360 Controller', index: 1 };

  it('exact id match wins regardless of order', () => {
    expect(selectGamepad([padA, padB], 'Xbox 360 Controller')).toBe(padB);
  });

  it('unknown preferred id falls back to the first connected pad', () => {
    expect(selectGamepad([null, padB], 'Gone Controller')).toBe(padB);
  });

  it('no preference: first connected pad (original behavior); none: null', () => {
    expect(selectGamepad([null, padA, padB], '')).toBe(padA);
    expect(selectGamepad([null, null], '')).toBeNull();
    expect(selectGamepad(undefined, '')).toBeNull();
  });
});

describe('pressedRoles — SEAT FIT live highlight (display only)', () => {
  // Fake Gamepad: 17 buttons, all released, plus deflected axes to prove
  // axes can never produce a role.
  const fakePad = (pressedByIndex = {}) => ({
    id: 'fake',
    axes: [1, 1, 1, 1], // fully deflected — must not matter
    buttons: Array.from({ length: 17 }, (_, i) => {
      const p = pressedByIndex[i];
      return typeof p === 'number' ? { pressed: false, value: p } : { pressed: !!p, value: p ? 1 : 0 };
    }),
  });

  it('maps pressed buttons to roles through the chosen preset map', () => {
    // dualshock/legacy indices: throttle 7, brake 6, gearUp 5, gearDown 4,
    // drs 3, boost 1, overtake 2.
    expect(pressedRoles(fakePad({ 7: true, 4: true }), 'dualshock'))
      .toEqual(['throttle', 'gearDown']);
    expect(pressedRoles(fakePad({}), 'dualshock')).toEqual([]);
  });

  it('analog triggers count via the value threshold, digital via pressed', () => {
    expect(pressedRoles(fakePad({ 6: 0.5 }), 'dualshock')).toEqual(['brake']); // value only
    expect(pressedRoles(fakePad({ 6: 0.03 }), 'dualshock')).toEqual([]); // below threshold
  });

  it('everything pressed yields exactly the seven button roles — axes and camera can never appear', () => {
    const all = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [i, true]));
    const roles = pressedRoles(fakePad(all), 'dualshock');
    expect([...roles].sort()).toEqual(
      ['boost', 'brake', 'drs', 'gearDown', 'gearUp', 'overtake', 'throttle'],
    );
  });

  it('no pad / padless call clears to an empty set (disconnect behavior)', () => {
    expect(pressedRoles(null, 'dualshock')).toEqual([]);
    expect(pressedRoles(undefined, 'xbox')).toEqual([]);
    expect(pressedRoles({ id: 'x' }, 'dualshock')).toEqual([]); // no buttons array
  });
});

describe('axisValues — mirrored analog axes (display only)', () => {
  const pad = (axes) => ({ id: 'p', axes, buttons: [] });

  it('reads steer/camPan/camTilt through the preset map (legacy indices 0/2/3)', () => {
    // axes: [steerX, ?, camPanX, camTiltY]
    expect(axisValues(pad([-0.5, 0.9, 0.25, -0.75]), 'dualshock'))
      .toEqual({ steer: -0.5, camPan: 0.25, camTilt: -0.75 });
  });

  it('clamps every axis into [-1, 1]', () => {
    expect(axisValues(pad([-3, 0, 2, -9]), 'xbox'))
      .toEqual({ steer: -1, camPan: 1, camTilt: -1 });
  });

  it('a missing pad / short axes array reads neutral 0 (disconnect returns to centre)', () => {
    expect(axisValues(null, 'dualshock')).toEqual({ steer: 0, camPan: 0, camTilt: 0 });
    expect(axisValues(pad([]), 'dualshock')).toEqual({ steer: 0, camPan: 0, camTilt: 0 });
    expect(axisValues(pad([0.3]), 'dualshock')).toEqual({ steer: 0.3, camPan: 0, camTilt: 0 });
  });

  it('non-finite axis values (NaN/undefined) read as neutral, never NaN', () => {
    expect(axisValues(pad([NaN, 0, undefined, 0.4]), 'dualshock'))
      .toEqual({ steer: 0, camPan: 0, camTilt: 0.4 });
  });

  it('reads simultaneous pan AND tilt independently (both axes live at once)', () => {
    // Right stick pushed diagonally: pan and tilt are read from separate axes and
    // neither clobbers the other, while the left stick (steer) is untouched.
    expect(axisValues(pad([0, 0, 0.6, -0.9]), 'dualshock'))
      .toEqual({ steer: 0, camPan: 0.6, camTilt: -0.9 });
    expect(axisValues(pad([0.2, 0, -0.4, 0.7]), 'xbox'))
      .toEqual({ steer: 0.2, camPan: -0.4, camTilt: 0.7 });
  });
});

// Session-stable controller identity (task §3). Two IDENTICAL controllers share a
// Gamepad.id, so `id` alone cannot tell them apart or pick exactly one; the slot
// index disambiguates them WITHIN a session. These pure functions carry that
// logic; the DOM behaviour is pinned in test/setupFlowDom.test.js.
describe('gamepadKey — session-stable device identity', () => {
  it('two identical controllers in different slots get DIFFERENT keys', () => {
    const a = { id: 'DualShock 4', index: 0 };
    const b = { id: 'DualShock 4', index: 1 };
    expect(gamepadKey(a)).not.toBe(gamepadKey(b));
  });

  it('the SAME slot + id gives the SAME key (a duplicate reference collapses)', () => {
    expect(gamepadKey({ id: 'DualShock 4', index: 0 }))
      .toBe(gamepadKey({ id: 'DualShock 4', index: 0 }));
  });

  it('a null/absent pad has an empty key', () => {
    expect(gamepadKey(null)).toBe('');
    expect(gamepadKey(undefined)).toBe('');
  });
});

describe('resolveSelectedPad — session-stable selection (no fabricated switches)', () => {
  const A = { id: 'DualShock 4', index: 0 };
  const B = { id: 'DualShock 4', index: 1 }; // IDENTICAL model, different slot
  const X = { id: 'Xbox 360 Controller', index: 2 };

  it('no explicit choice → follows the first connected slot (auto default)', () => {
    expect(resolveSelectedPad([A, B], { chosenKey: '' })).toBe(A);
    expect(resolveSelectedPad([A, B], {})).toBe(A);
  });

  it('selects EXACTLY the chosen device by session key — the SECOND of two identical pads', () => {
    expect(resolveSelectedPad([A, B], { chosenKey: gamepadKey(B) })).toBe(B);
    expect(resolveSelectedPad([A, B], { chosenKey: gamepadKey(A) })).toBe(A);
  });

  it('disconnecting ONLY the selected device invalidates it — and never switches to its identical peer', () => {
    // B was selected; B is unplugged, its identical twin A remains.
    expect(resolveSelectedPad([A], { chosenKey: gamepadKey(B) })).toBeNull();
  });

  it('reconnect at the SAME slot re-matches the selection', () => {
    expect(resolveSelectedPad([A, B], { chosenKey: gamepadKey(B) })).toBe(B);
  });

  it('reconnect at a DIFFERENT slot is honest: the old session key no longer matches (missing, re-pick)', () => {
    // B (slot 1) was selected, then the OS brought it back as slot 3.
    const bReslotted = { id: 'DualShock 4', index: 3 };
    expect(resolveSelectedPad([A, bReslotted], { chosenKey: gamepadKey(B) })).toBeNull();
  });

  it('a duplicate reference to the same slot collapses (via dedupeGamepads) to one selectable device', () => {
    const deduped = dedupeGamepads([A, A, { id: 'DualShock 4', index: 0 }]);
    expect(deduped).toEqual([A]);
    expect(resolveSelectedPad(deduped, { chosenKey: gamepadKey(A) })).toBe(A);
  });

  it('a distinct controller stays independently selectable alongside the identical pair', () => {
    expect(resolveSelectedPad([A, B, X], { chosenKey: gamepadKey(X) })).toBe(X);
  });

  it('no pads at all → null (nothing selected, mirror goes neutral)', () => {
    expect(resolveSelectedPad([], { chosenKey: gamepadKey(A) })).toBeNull();
    expect(resolveSelectedPad(undefined, {})).toBeNull();
  });
});

describe('dedupeGamepads — one row per device (SEAT FIT)', () => {
  it('keeps two DISTINCT devices even when their id is identical (two identical pads)', () => {
    const a = { id: 'DualShock 4', index: 0 };
    const b = { id: 'DualShock 4', index: 1 };
    expect(dedupeGamepads([a, b])).toEqual([a, b]);
  });

  it('collapses a doubled reference to the SAME slot (duplicate suppression)', () => {
    const a = { id: 'DualShock 4', index: 0 };
    expect(dedupeGamepads([a, a, { id: 'DualShock 4', index: 0 }])).toEqual([a]);
  });

  it('drops null slots (Gamepad API pads out with nulls)', () => {
    const a = { id: 'x', index: 2 };
    expect(dedupeGamepads([null, a, null])).toEqual([a]);
    expect(dedupeGamepads([])).toEqual([]);
    expect(dedupeGamepads(undefined)).toEqual([]);
  });
});

describe('transportLabel — never guesses USB vs Bluetooth', () => {
  it('is always UNKNOWN (the Gamepad API exposes no reliable transport)', () => {
    expect(transportLabel({ id: 'DualShock 4 Wireless Controller' })).toBe(TRANSPORT_UNKNOWN);
    expect(transportLabel({ id: 'anything' })).toBe('UNKNOWN');
    expect(transportLabel(null)).toBe('UNKNOWN');
  });
});

describe('inputSourceView — SEAT FIT input-source badge', () => {
  it('a present pad is a LIVE controller', () => {
    expect(inputSourceView({ pad: { id: 'x' } })).toMatchObject({ source: 'live', live: true });
  });
  it('the demo/preview path is explicitly SIMULATED (never shown as live)', () => {
    expect(inputSourceView({ pad: { id: 'x' }, demo: true })).toMatchObject({ source: 'simulated', live: false });
    expect(inputSourceView({ demo: true })).toMatchObject({ source: 'simulated', live: false });
  });
  it('no pad falls back to keyboard, and is NOT marked live (no live axis beside NO CONTROLLER)', () => {
    const v = inputSourceView({ pad: null });
    expect(v).toMatchObject({ source: 'none', live: false });
    expect(v.label).toContain('KEYBOARD');
  });
});

describe('detectPresetFromId — informational layout suggestion', () => {
  it('recognizes Sony pads (name or vendor id 054c)', () => {
    for (const id of [
      'DualSense Wireless Controller',
      'DUALSHOCK 4 Wireless Controller',
      'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)',
    ]) expect(detectPresetFromId(id), id).toBe('dualshock');
  });

  it('recognizes Xbox pads (name, XInput, or vendor id 045e)', () => {
    for (const id of [
      'Xbox 360 Controller (XInput STANDARD GAMEPAD)',
      'Microsoft Controller (STANDARD GAMEPAD Vendor: 045e Product: 02ea)',
    ]) expect(detectPresetFromId(id), id).toBe('xbox');
  });

  it('unknown or empty ids return null so the caller keeps the current choice', () => {
    expect(detectPresetFromId('Generic USB Joystick (Vendor: 0079)')).toBeNull();
    expect(detectPresetFromId('')).toBeNull();
    expect(detectPresetFromId(undefined)).toBeNull();
  });
});
