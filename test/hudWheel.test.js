// @vitest-environment jsdom
// HUD-side wheel mirroring (Batch 7 / P5c). These drive the REAL renderer/hud.js
// against renderer/index.html under jsdom, stepping its requestAnimationFrame loop
// by hand so we can observe the command widgets (STR/THR/BRK bars + camera dot)
// after one frame. They pin the batch's contract:
//   - a wheel/both session mirrors STR/THR/BRK from the calibrated wheel;
//   - a GAMEPAD session is BIT-IDENTICAL to before (the wheel path is skipped);
//   - a wheel disconnect resolves STR/THR/BRK to neutral, never a stale deflection;
//   - pan/tilt (the camera dot) stays gamepad-sourced under every input type — a
//     wheel has no aim stick, so camera-aim semantics are untouched.
// This is DISPLAY MIRROR ONLY; test/noControlPath.test.js separately proves hud.js
// carries no control path.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const html = readFileSync('renderer/index.html', 'utf8');
const bodyHtml = html
  .match(/<body>([\s\S]*)<\/body>/)[1]
  .replace(/<script[\s\S]*?<\/script>/g, ''); // the test imports the module itself

const el = (id) => document.getElementById(id);

// A wheel-shaped pad with enough axes/buttons for both the gamepad preset (axes
// 0/2/3, buttons 6/7) and the wheel profile (its own axes) to be read.
const makePad = (id, index, { axes = [0, 0, 0, 0], buttons = [] } = {}) => ({
  id, index, connected: true, mapping: 'standard',
  axes: axes.slice(),
  buttons: Array.from({ length: 16 }, (_, i) => buttons[i] || { pressed: false, value: 0 }),
});
const setPads = (pads) => {
  Object.defineProperty(window.navigator, 'getGamepads', { configurable: true, value: () => pads });
};

// A wheel profile whose axes DO NOT overlap the gamepad preset's steer/cam axes
// (0/2/3), so an assertion can tell "value came from the wheel" apart from "value
// came from the gamepad path": steer←axis4, throttle←axis1, brake←axis5.
const WHEEL_PROFILE = {
  steer: { axis: 4 }, pedalMode: 'separate',
  throttle: { axis: 1, rest: 1, full: -1 }, // rests +1, floors −1 → travel via ordering
  brake: { axis: 5, rest: 1, full: -1 },
  combined: { axis: 1, rest: 0, throttleEnd: 1, brakeEnd: -1 },
  deadzone: 0, buttons: { gearUp: 5, gearDown: 4, drs: 3, boost: 1, overtake: 2 },
};

let rafCb = null;
async function loadHud() {
  vi.resetModules();
  document.body.innerHTML = bodyHtml;
  rafCb = null;
  // Capture the HUD's rAF callback instead of running a 60 fps loop, so a test can
  // step exactly one frame after arranging inputs. hud.js registers it at import.
  window.requestAnimationFrame = (cb) => { rafCb = cb; return 1; };
  const hud = await import('../renderer/hud.js');
  return hud;
}
// Run one HUD frame at timestamp `ts`; the frame re-registers rafCb for the next.
function stepFrame(ts) {
  const cb = rafCb;
  cb(ts);
}

beforeEach(() => {
  vi.restoreAllMocks();
  delete window.groundStation; // no preload → hud.init() returns early (bench path)
});
afterEach(() => {
  vi.clearAllTimers();
});

describe('HUD wheel mirroring (Batch 7 / P5c)', () => {
  it('WHEEL session mirrors STR/THR/BRK from the wheel; pan/tilt stays gamepad-sourced', async () => {
    const hud = await loadHud();
    // axis0 (gamepad steer) and buttons 6/7 (gamepad brake/throttle) are set to
    // DECOY values; if the wheel path works they are overridden. axis2/axis3 are
    // the gamepad camera axes and must survive (pan/tilt is never wheel-sourced).
    const buttons = [];
    buttons[7] = { pressed: true, value: 0.9 };  // gamepad throttle decoy
    buttons[6] = { pressed: true, value: 0.9 };  // gamepad brake decoy
    // axes: [gp-steer, wheel-thr, gp-pan, gp-tilt, wheel-steer, wheel-brk]
    setPads([makePad('G29 Racing Wheel', 0, { axes: [-0.5, -1, 0.6, -0.4, 0.8, 1], buttons })]);
    hud.setInputSource({ type: 'wheel', profile: WHEEL_PROFILE, wheelKey: '' });
    hud.startRide();
    stepFrame(1000);

    // STR/THR/BRK come from the wheel (its own axes), NOT the gamepad decoys.
    expect(el('steer').style.left).toBe(`${50 + 0.8 * 42}%`); // wheel steer axis4
    expect(el('thr').style.width).toBe('100%');               // wheel throttle floored → 1.0
    expect(el('brk').style.width).toBe('0%');                 // wheel brake at rest → 0
    // Pan/tilt (camera dot) is still the gamepad right stick — untouched by the wheel.
    expect(el('camdot').style.left).toBe(`${50 + 0.6 * 40}%`); // gamepad camPan axis2
    expect(el('camdot').style.top).toBe(`${50 + -0.4 * 40}%`); // gamepad camTilt axis3
  });

  it('GAMEPAD session (default, no wheel) mirrors the gamepad EXACTLY — bit-identical to before', async () => {
    const hud = await loadHud();
    const buttons = [];
    buttons[7] = { pressed: true, value: 0.7 };  // preset throttleBtn
    buttons[6] = { pressed: true, value: 0.2 };  // preset brakeBtn
    setPads([makePad('DualShock 4', 0, { axes: [-0.3, 0, 0.5, -0.25], buttons })]);
    // No setInputSource call — the default is GAMEPAD.
    hud.startRide();
    stepFrame(1000);

    expect(el('steer').style.left).toBe(`${50 + -0.3 * 42}%`); // gamepad steer axis0
    expect(el('thr').style.width).toBe('70%');                 // gamepad throttle button 7
    expect(el('brk').style.width).toBe('20%');                 // gamepad brake button 6
    expect(el('camdot').style.left).toBe(`${50 + 0.5 * 40}%`); // gamepad camPan axis2
    expect(el('camdot').style.top).toBe(`${50 + -0.25 * 40}%`); // gamepad camTilt axis3
  });

  it('an explicit GAMEPAD setInputSource is also bit-identical (never touches the wheel path)', async () => {
    const hud = await loadHud();
    const buttons = [];
    buttons[7] = { pressed: true, value: 1 };
    setPads([makePad('DualShock 4', 0, { axes: [0.25, 0, 0, 0], buttons })]);
    hud.setInputSource({ type: 'gamepad', profile: WHEEL_PROFILE, wheelKey: '' }); // profile ignored
    hud.startRide();
    stepFrame(1000);
    expect(el('steer').style.left).toBe(`${50 + 0.25 * 42}%`);
    expect(el('thr').style.width).toBe('100%');
  });

  it('a wheel disconnect returns STR/THR/BRK to neutral — never a stale deflection (task §5)', async () => {
    const hud = await loadHud();
    setPads([makePad('G29 Racing Wheel', 0, { axes: [0, -1, 0, 0, 0.8, 1] })]);
    hud.setInputSource({ type: 'wheel', profile: WHEEL_PROFILE, wheelKey: '' });
    hud.startRide();
    stepFrame(1000);
    // Deflected first: steer right, throttle floored.
    expect(el('steer').style.left).toBe(`${50 + 0.8 * 42}%`);
    expect(el('thr').style.width).toBe('100%');
    // Unplug the wheel — the next frame must read neutral, not the last deflection.
    setPads([]);
    stepFrame(1016);
    expect(el('steer').style.left).toBe('50%'); // centred
    expect(el('thr').style.width).toBe('0%');   // released
    expect(el('brk').style.width).toBe('0%');
  });

  it('BOTH session also mirrors the wheel for STR/THR/BRK while pan/tilt stays gamepad', async () => {
    const hud = await loadHud();
    // Two devices: a DualShock (gamepad, slot 0) and a wheel (slot 1). The gamepad
    // drives pan/tilt; the wheel (selected by its session key) drives STR/THR/BRK.
    const gp = makePad('DualShock 4', 0, { axes: [-0.5, 0, 0.7, -0.3] });
    const wheel = makePad('G29 Racing Wheel', 1, { axes: [0, -1, 0, 0, -0.6, 1] });
    setPads([gp, wheel]);
    // The wheel's session key = "#1␟<id>"; resolveSelectedPad matches it.
    const wheelKey = `#1␟${wheel.id}`;
    hud.setInputSource({ type: 'both', profile: WHEEL_PROFILE, wheelKey });
    hud.startRide();
    stepFrame(1000);
    expect(el('steer').style.left).toBe(`${50 + -0.6 * 42}%`); // wheel (slot 1) steer axis4
    expect(el('thr').style.width).toBe('100%');                // wheel throttle floored
    expect(el('camdot').style.left).toBe(`${50 + 0.7 * 40}%`); // gamepad (slot 0) camPan
  });
});

// Wheel button pills (Batch 8a.1 rider c). In a wheel/both session the gear/DRS/
// boost/overtake HUD pills light from the wheel's OWN assigned buttons (via
// pressedWheelRoles), matching what the SEAT FIT mirror already showed — and the
// gamepad/keyboard button path is SKIPPED that session so the two can't double-
// count a press. A GAMEPAD session still lights the pills from the preset, exactly
// as before. Display-only (test/noControlPath.test.js proves no control path).
describe('HUD wheel button pills (Batch 8a.1 rider c)', () => {
  const pillState = () => ({
    gear: el('gear').textContent,
    drs: el('drs').classList.contains('on'),
    boost: el('boost').classList.contains('on'),
    ot: el('ot').classList.contains('on'),
  });
  // Button indices are DISTINCT from the DualShock preset's (drs3/boost1/ot2/
  // gearUp5/gearDown4), so a lit pill can only have come from the WHEEL profile,
  // never the gamepad button path reading the same pad through preset indices.
  const BTN_PROFILE = {
    ...WHEEL_PROFILE,
    buttons: { gearUp: 8, gearDown: 9, drs: 10, boost: 11, overtake: 12 },
  };
  const press = (...idx) => { const b = []; for (const i of idx) b[i] = { pressed: true, value: 1 }; return b; };

  it('WHEEL session: wheel-assigned gear/DRS/boost/overtake buttons light the pills', async () => {
    const hud = await loadHud();
    // Press the wheel's gearUp(8), drs(10), boost(11), overtake(12).
    setPads([makePad('G29 Racing Wheel', 0, { axes: [0, 0, 0, 0, 0, 0], buttons: press(8, 10, 11, 12) })]);
    hud.setInputSource({ type: 'wheel', profile: BTN_PROFILE, wheelKey: '' });
    hud.startRide();
    stepFrame(1000);
    expect(pillState()).toEqual({ gear: '2', drs: true, boost: true, ot: true });
  });

  it('WHEEL session: the gamepad button path is skipped — preset buttons alone light nothing', async () => {
    const hud = await loadHud();
    // Press ONLY the DualShock preset buttons (drs3/boost1/ot2/gearUp5) and NONE of
    // the wheel's (8–12). If the gamepad button block still ran, these would light
    // the pills; because a wheel session skips it and the wheel buttons are idle,
    // every pill stays off and the gear never leaves 1 (shown as 'N' at rest).
    setPads([makePad('G29 Racing Wheel', 0, { axes: [0, 0, 0, 0, 0, 0], buttons: press(1, 2, 3, 5) })]);
    hud.setInputSource({ type: 'wheel', profile: BTN_PROFILE, wheelKey: '' });
    hud.startRide();
    stepFrame(1000);
    const s = pillState();
    // gear never left 1 (no wheel gearUp; the gamepad gearUp5 is skipped). At rest
    // gear 1 renders 'N', or '1' once the sim rolls past 1 km/h — both mean "unshifted".
    expect(['N', '1']).toContain(s.gear);
    expect(s.drs).toBe(false);
    expect(s.boost).toBe(false);
    expect(s.ot).toBe(false);
  });

  it('BOTH session: the slot-selected wheel lights the pills', async () => {
    const hud = await loadHud();
    const gp = makePad('DualShock 4', 0, { axes: [0, 0, 0, 0] });
    const wheel = makePad('G29 Racing Wheel', 1, { axes: [0, 0, 0, 0, 0, 0], buttons: press(8, 10, 11) });
    setPads([gp, wheel]);
    hud.setInputSource({ type: 'both', profile: BTN_PROFILE, wheelKey: `#1␟${wheel.id}` });
    hud.startRide();
    stepFrame(1000);
    const s = pillState();
    expect(s.gear).toBe('2'); // wheel gearUp(8)
    expect(s.drs).toBe(true); // wheel drs(10)
    expect(s.boost).toBe(true); // wheel boost(11)
    expect(s.ot).toBe(false); // wheel overtake(12) not pressed
  });

  it('GAMEPAD session (default): the preset buttons still light the pills — bit-identical', async () => {
    const hud = await loadHud();
    // DualShock with drs(3), boost(1), overtake(2), gearUp(5) pressed — the preset
    // path lights them exactly as before; no setInputSource (default GAMEPAD).
    setPads([makePad('DualShock 4', 0, { axes: [0, 0, 0, 0], buttons: press(1, 2, 3, 5) })]);
    hud.startRide();
    stepFrame(1000);
    expect(pillState()).toEqual({ gear: '2', drs: true, boost: true, ot: true });
  });
});

// HUD status stack + INPUT source tag (Batch 8a / flow chrome). The scattered
// chips consolidate into one right-aligned .statusstack under the session clock
// (ids/logic unchanged, only placement); an INPUT · GAMEPAD/WHEEL tag above the
// THR/BRK/STR bars labels the session source (fed by Batch 7's setInputSource);
// the right-stick reticle carries a violet STICK INPUT · PAD tag. Display only.
describe('HUD status stack + input source tag (Batch 8a / flow chrome)', () => {
  it('the INPUT tag defaults to GAMEPAD (muted) and never says GAMEPAD/WHEEL wrong', async () => {
    await loadHud();
    expect(el('inputSrcTag').textContent).toBe('INPUT · GAMEPAD');
    expect(el('inputSrcTag').className).toBe('srctag'); // muted default, no wheel accent
  });

  it('a WHEEL session tags INPUT · WHEEL with the teal wheel accent', async () => {
    const hud = await loadHud();
    hud.setInputSource({ type: 'wheel', profile: WHEEL_PROFILE, wheelKey: '' });
    expect(el('inputSrcTag').textContent).toBe('INPUT · WHEEL');
    expect(el('inputSrcTag').className).toContain('wheel');
  });

  it('a BOTH session tags INPUT · WHEEL (STR/THR/BRK are wheel-fed); GAMEPAD reverts to muted GAMEPAD', async () => {
    const hud = await loadHud();
    hud.setInputSource({ type: 'both', profile: WHEEL_PROFILE, wheelKey: '' });
    expect(el('inputSrcTag').textContent).toBe('INPUT · WHEEL');
    expect(el('inputSrcTag').className).toContain('wheel');
    hud.setInputSource({ type: 'gamepad' });
    expect(el('inputSrcTag').textContent).toBe('INPUT · GAMEPAD');
    expect(el('inputSrcTag').className).toBe('srctag');
  });

  it('the link/gamepad/W3/replay/head-intent chips all live in the one .statusstack', async () => {
    await loadHud();
    const stack = document.querySelector('.statusstack');
    expect(stack).toBeTruthy();
    for (const id of ['linkStatus', 'gpStatus', 'w3Chip', 'replayChip', 'headIntentChip']) {
      expect(el(id).closest('.statusstack')).toBe(stack);
    }
    // The clock panel keeps only the clock + live indicator (no chips).
    expect(el('clock').closest('.statusstack')).toBeNull();
  });

  it('the right-stick reticle carries the violet STICK INPUT · PAD tag (observed-input vocabulary)', async () => {
    await loadHud();
    const tag = el('camdot').closest('.campanel').querySelector('.srctag.pad');
    expect(tag).toBeTruthy();
    expect(tag.textContent).toBe('STICK INPUT · PAD');
  });
});
