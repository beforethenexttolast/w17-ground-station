import { describe, it, expect } from 'vitest';
import {
  PRESETS, DEFAULT_PRESET, getPreset, selectGamepad, detectPresetFromId, pressedRoles,
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
