// HUD renderer. Two data sources, cleanly layered:
//   COMMAND side (throttle/brake/steer/DRS/boost/overtake/gear-shifts) always
//     comes from the local gamepad/keyboard -- the driver commands these, so
//     the ground already knows them with zero latency. This is a MIRROR; it
//     does not drive the car (elrs-joystick-control does).
//   CAR-SIDE TRUTH (real speed, battery, link quality, gear/mode/ers) arrives
//     as telemetry over the preload bridge and OVERRIDES the simulated values
//     when present. Link loss is DERIVED here from LQ + staleness (the car
//     does not transmit an armed/failsafe field -- shared/linkState.mjs). With
//     no telemetry source ever seen, a display-only physics model animates
//     speed/rpm/ers so the HUD is fully alive from the gamepad alone.
import { startWhep } from './whep.js';
import { linkState } from '../shared/linkState.mjs';
import { getPreset, selectGamepad, DEFAULT_PRESET, dedupeGamepads, resolveSelectedPad } from '../shared/inputPresets.mjs';
import { wheelValues, pressedWheelRoles } from '../shared/wheelProfile.mjs';
import { makeHudKeyHandlers } from '../shared/keyboardFocus.mjs';
import { initialVideoState, reduceVideoState, videoStatus } from '../shared/videoState.mjs';
import { headIntentView } from '../shared/headIntentView.mjs';
import * as uiNav from './uiNav.js';

const el = (id) => document.getElementById(id);
const revEl = el('rev'), speedEl = el('speed'), speedUnitEl = el('speedUnit'),
  gearEl = el('gear'), driveModeEl = el('driveMode'), thrEl = el('thr'), brkEl = el('brk'), steerEl = el('steer'),
  ersEl = el('ers'), ersPctEl = el('ersPct'), battVEl = el('battV'),
  drsEl = el('drs'), boostEl = el('boost'), otEl = el('ot'), camDotEl = el('camdot'),
  clockEl = el('clock'), gpEl = el('gpStatus'), linkEl = el('linkStatus'),
  w3ChipEl = el('w3Chip'), replayChipEl = el('replayChip'), headIntentChipEl = el('headIntentChip'),
  inputSrcTagEl = el('inputSrcTag'),
  gate = el('gate'),
  demoBtn = el('demoBtn'), feed = el('feed'), feedNote = el('feedNote'), feedNoteText = el('feedNoteText');

// Drive modes, indexed by the car's driveMode field (firmware ChannelDecoder:
// 0=Training, 1=Race, 2=ERS). Shown only when live telemetry supplies it.
const DRIVE_MODES = [
  { label: 'TRAINING', cls: 'm-train' },
  { label: 'RACE', cls: 'm-race' },
  { label: 'ERS', cls: 'm-ers' },
];

const REV_LIGHTS = 12;
for (let i = 0; i < REV_LIGHTS; i++) revEl.appendChild(document.createElement('i'));
const revs = [...revEl.children];

// Feel constants come from main (single source: shared/feelConstants.js).
let FEEL = { gears: 4, topSpeedKmh: 320, ersDeployPctPerSec: 26, ersHarvestPctPerSec: 11, ersBoostMultiplier: 1.18 };
let caps = [];
function computeCaps() {
  caps = [0];
  for (let g = 1; g <= FEEL.gears; g++) caps[g] = Math.round(FEEL.topSpeedKmh * Math.pow(g / FEEL.gears, 0.82));
}
computeCaps();

const S = {
  started: false, gear: 1, speed: 0, rpm: 0, ers: 100,
  throttle: 0, brake: 0, steer: 0, drs: false, boost: false, overtake: false,
  camPan: 0, camTilt: 0, // right stick -> gimbal look direction (mirror; car drives it via ch9/10)
  t0: performance.now(), connected: false,
};

// Latest telemetry (car-side truth); null fields fall back to simulation.
let telem = null;
let telemFresh = 0; // performance.now() of last telemetry packet
let telemEverLive = false; // latched: once true, staleness shows TELEMETRY LOST, never sim

const keys = {};
const prev = { up: false, down: false, drs: false };
let demo = false;

// Keyboard mirror, scoped by shared/keyboardFocus.mjs: typing in a setup or
// settings field is never recorded or prevented (spaces/arrows belong to the
// field), while driving keys keep working from any non-editable focus.
const hudKeys = makeHudKeyHandlers(keys);
addEventListener('keydown', hudKeys.keydown);
addEventListener('keyup', hudKeys.keyup);
addEventListener('gamepadconnected', refreshPad);
addEventListener('gamepaddisconnected', refreshPad);
// HUD preview (the floating gate button) bypasses the setup flow entirely:
// instant HUD on simulated inputs/physics. Unrelated to `npm run demo`,
// which feeds the replay TELEMETRY source. (Internal names stay `demo*`.)
demoBtn.addEventListener('click', () => {
  demo = !demo;
  demoBtn.classList.toggle('on', demo);
  demoBtn.textContent = demo ? '■ Preview running' : '▶ HUD preview · simulated';
  if (demo) start();
});
// Batch 9 (triage #4): while the opaque gate covers the page the preview button
// is invisible (z-index 9 under the gate's 10) yet still in the Tab/pad focus
// order — focus would land on, and confirm would click, a control the user
// cannot see. Hide it (class-based, so uiNav's navigable() filter sees it too)
// until the gate is dismissed; setupFlow re-hides it when CHANGE SETUP brings
// the gate back.
const demoWrap = document.querySelector('.demoToggle');
demoWrap.classList.add('hidden');

// Controller selection: persisted device id + layout preset (SEAT FIT step).
// Defaults reproduce the original behavior: first pad, DualShock layout.
let activePreset = getPreset(DEFAULT_PRESET);
let preferredPadId = '';
export function setControllerChoice({ id = '', preset = DEFAULT_PRESET } = {}) {
  preferredPadId = id;
  activePreset = getPreset(preset);
  refreshPad();
}
function pad() { const ps = navigator.getGamepads ? navigator.getGamepads() : []; return selectGamepad(ps, preferredPadId); }

// Session wheel source (Batch 7 / P5c). The SEAT FIT input type is a per-session
// choice that ALWAYS boots GAMEPAD (never persisted, decision #2), so these
// default to the gamepad path and setupFlow.js sets them once at START via
// setInputSource(). When the type is wheel/both, the HUD mirrors the calibrated
// wheel for STR/THR/BRK and the gear/DRS/boost/overtake pills (Batch 8a.1 rider c)
// from the wheel's own assigned buttons — but pan/tilt stays gamepad-sourced (a
// wheel has no aim stick), so camera-aim semantics are untouched and a GAMEPAD
// session is bit-identical to before (the override block is skipped entirely).
// DISPLAY MIRROR ONLY: wheelValues just reads navigator.getGamepads(); nothing
// here reaches a control output (driving stays with elrs-joystick-control).
let inputType = 'gamepad';   // 'gamepad' | 'wheel' | 'both'
let wheelProfile = null;     // normalized profile passed from SEAT FIT; null in GAMEPAD
let wheelPadKey = '';        // session key (slot+id) of the wheel device; '' = first slot
export function setInputSource({ type = 'gamepad', profile = null, wheelKey = '' } = {}) {
  inputType = (type === 'wheel' || type === 'both') ? type : 'gamepad';
  wheelProfile = profile;
  wheelPadKey = wheelKey || '';
  renderInputSrc();
}
// INPUT source tag above the THR/BRK/STR bars (Batch 8a): a truthful label for
// which device feeds those bars this session. WHEEL/BOTH read the wheel for
// STR/THR/BRK (teal wheel tag); GAMEPAD reads the pad (muted). Display only.
function renderInputSrc() {
  if (!inputSrcTagEl) return;
  const wheel = inputType === 'wheel' || inputType === 'both';
  inputSrcTagEl.textContent = `INPUT · ${wheel ? 'WHEEL' : 'GAMEPAD'}`;
  inputSrcTagEl.className = `srctag${wheel ? ' wheel' : ''}`;
}
renderInputSrc();
// The pad the wheel mirror reads. START happens in the same session (no restart),
// so the session key from SEAT FIT still resolves the same slot; a wheel that
// disconnects after START resolves to null → wheelValues reads neutral, never a
// stale deflection (task §5).
function wheelPad() {
  const ps = dedupeGamepads(navigator.getGamepads ? navigator.getGamepads() : []);
  return resolveSelectedPad(ps, { chosenKey: wheelPadKey });
}
function refreshPad() {
  const p = pad();
  S.connected = !!p;
  gpEl.textContent = p ? 'Controller ready' : 'No controller';
  gpEl.classList.toggle('on', !!p);
}
function start() {
  if (S.started) return;
  S.started = true; S.t0 = performance.now();
  gate.classList.add('hidden');
  demoWrap.classList.remove('hidden'); // gate gone — the preview toggle is visible/reachable again
}
setInterval(refreshPad, 600); refreshPad();

// --- Hooks for the setup flow (renderer/setupFlow.js drives the gate). ---
// startRide: dismiss the gate and go live (called after lights-out).
export function startRide() { start(); }
// W3 LOG-ONLY chip: shows the diagnostic listener EXISTS (the w3 boolean from
// config/applySession). Existence only — receiver data has no path here.
export function setW3Chip(active) { w3ChipEl.classList.toggle('hidden', !active); }
// Replay chip (audit C2/Q4): shown whenever the EFFECTIVE telemetry source is
// replay/synthetic, so a screenshot can never be mistaken for live car data.
// Driven by the effective source only — independent of the SIMULATED WIFI tag
// (a different subsystem) and of the W3 log-only chip (a different concern).
export function setReplayChip(active) { replayChipEl.classList.toggle('hidden', !active); }
// Mapper head-intent diagnostics chip (CB8 slice 3B): render the mapper's
// read-only authoritative snapshot pushed one-way from main. DISPLAY-ONLY — the
// pure view (shared/headIntentView.mjs) only maps the mapper's fields to chip
// text; nothing here recomputes freshness/state, and there is no path back to
// the mapper. The chip always reads "· NO CONTROL".
export function renderHeadIntent(snapshot) {
  if (!headIntentChipEl) return;
  const view = headIntentView(snapshot);
  headIntentChipEl.className = `hichip${view.visible ? '' : ' hidden'} hi-${view.tone}`;
  headIntentChipEl.textContent = view.visible ? view.chip : '';
  headIntentChipEl.title = view.visible ? (view.detail || '') : '';
}
// hudStatus: the GRID checklist's local probes — read-only display state.
// `videoPlaying` is the confident-green derivation of the video-state model
// (audit C1): true ONLY while frames are actually flowing.
export function hudStatus() {
  const video = videoStatus(videoState);
  return {
    videoPlaying: video.live,
    video,
    controllerConnected: !!pad(),
    telemetryState: telemetryState(),
  };
}

// --- Video state model (audit C1): ONE authority for GRID VIDEO LOCK, the HUD
// overlay wording, and the outbound W2 `video_lock`. Fed by the <video> media
// events and the WHEP client's transport signals; see shared/videoState.mjs.
let videoState = initialVideoState();
function applyVideoEvent(type) {
  const next = reduceVideoState(videoState, type);
  if (next === videoState) return; // idempotent: no phase change, no re-render
  videoState = next;
  renderVideo();
}
function renderVideo() {
  const s = videoStatus(videoState);
  if (feedNoteText) feedNoteText.textContent = s.label;
  if (feedNote) {
    for (const t of ['idle', 'wait', 'warn', 'error', 'live']) {
      feedNote.classList.toggle(`v-${t}`, s.tone === t);
    }
    // Hide the overlay note only when confidently live (video is visible);
    // otherwise show the honest status over whatever frame is on screen — a
    // frozen frame is never hidden, it is labelled (STREAM STALLED / …).
    feedNote.classList.toggle('hidden', s.live);
  }
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
function shift(dir) { S.gear = clamp(S.gear + dir, 1, FEEL.gears); }

// Single source of the pill button semantics (Batch 8a.1): edge-triggered
// gear shift + DRS toggle, level boost/overtake. Fed five pre-resolved booleans
// so the gamepad, keyboard, and wheel paths differ ONLY in how they READ a press
// (preset map / keys / pressedWheelRoles), not in what a press MEANS — a change
// to the semantics (e.g. DRS toggle→momentary) now lives in one place instead of
// three. Exactly one source calls this per tick (the gamepad/keyboard button
// blocks are gated off in a wheel session), so `prev` is written once per tick.
function applyButtons({ up, down, drs, boost, overtake }) {
  if (up && !prev.up) shift(1);
  if (down && !prev.down) shift(-1);
  prev.up = up; prev.down = down;
  if (drs && !prev.drs) S.drs = !S.drs;
  prev.drs = drs;
  S.boost = boost;
  S.overtake = overtake;
}

const demoState = { t: 0 };
function readDemo() {
  demoState.t += 1 / 60;
  S.throttle = lerp(S.throttle, S.rpm > 0.96 && S.gear < FEEL.gears ? 0.2 : 0.9, 0.04);
  S.brake = 0; S.steer = Math.sin(demoState.t * 0.7) * 0.6;
  if (S.rpm > 0.97 && S.gear < FEEL.gears) shift(1);
  if (S.gear === FEEL.gears && S.rpm > 0.9) { S.throttle = 0; S.brake = 0.7; }
  if (S.speed < 8 && S.gear > 1) S.gear = 1;
  S.drs = Math.floor(demoState.t / 6) % 2 === 1 && S.gear >= 5;
  S.boost = Math.floor(demoState.t / 9) % 3 === 0 && S.ers > 15 && S.gear >= 4;
  S.overtake = false;
  // Gentle camera drift so the reticle is alive in demo mode.
  S.camPan = Math.sin(demoState.t * 0.5) * 0.7;
  S.camTilt = Math.sin(demoState.t * 0.31) * 0.4;
}

function readInputs() {
  if (demo) { readDemo(); return; }
  // In a wheel/both session the wheel owns STR/THR/BRK and the gear/DRS/boost/
  // overtake pills (the override block below); the gamepad/keyboard BUTTON blocks
  // are skipped this session so the two sources can't double-count a press. A
  // GAMEPAD session leaves wheelSession false, so every branch here runs exactly
  // as before — bit-identical.
  const wheelSession = inputType === 'wheel' || inputType === 'both';
  const p = pad();
  if (p) {
    const ax = p.axes, b = p.buttons;
    const m = activePreset.map; // layout preset (SEAT FIT); dualshock = legacy indices
    S.steer = clamp(ax[m.steerAxis] || 0, -1, 1);
    S.throttle = b[m.throttleBtn] ? b[m.throttleBtn].value : 0;
    S.brake = b[m.brakeBtn] ? b[m.brakeBtn].value : 0;
    if (!wheelSession) {
      applyButtons({
        up: !!(b[m.gearUpBtn] && b[m.gearUpBtn].pressed),
        down: !!(b[m.gearDownBtn] && b[m.gearDownBtn].pressed),
        drs: !!(b[m.drsBtn] && b[m.drsBtn].pressed),
        boost: !!(b[m.boostBtn] && b[m.boostBtn].pressed),
        overtake: !!(b[m.overtakeBtn] && b[m.overtakeBtn].pressed),
      });
    }
    // Right stick -> camera gimbal (mirror; the car aims it via ch9/ch10).
    S.camPan = clamp(ax[m.camPanAxis] || 0, -1, 1);
    S.camTilt = clamp(ax[m.camTiltAxis] || 0, -1, 1);
  } else {
    S.steer = clamp((keys.arrowright ? 1 : 0) - (keys.arrowleft ? 1 : 0), -1, 1);
    S.throttle = keys.arrowup ? 1 : 0;
    S.brake = keys.arrowdown ? 1 : 0;
    if (!wheelSession) {
      applyButtons({
        up: !!keys.e, down: !!keys.q, drs: !!keys.d, boost: !!keys.b, overtake: !!keys.o,
      });
    }
  }
  // Wheel override (Batch 7 + Batch 8a.1): in a wheel/both session the calibrated
  // wheel supplies STR/THR/BRK (Batch 7) AND lights the gear/DRS/boost/overtake
  // pills from its OWN assigned buttons (Batch 8a.1 rider c), so a pure-wheel
  // session drives the HUD pills the same way it drives the SEAT FIT mirror. The
  // gamepad/keyboard button block above was skipped this session, so the wheel is
  // the sole button source — same edge-triggered gear/DRS and level boost/overtake
  // logic, just fed from pressedWheelRoles instead of the preset map. Camera pan/
  // tilt stays gamepad-sourced (a wheel has no aim stick — camera-aim semantics
  // untouched). GAMEPAD sessions skip this whole block (bit-identical). A missing
  // wheel pad reads neutral / released, never a stale deflection.
  if (wheelSession) {
    const wp = wheelPad();
    const { steer, thr, brk } = wheelValues(wp, wheelProfile);
    S.steer = steer;
    S.throttle = thr;
    S.brake = brk;
    const roles = pressedWheelRoles(wp, wheelProfile);
    applyButtons({
      up: roles.includes('gearUp'),
      down: roles.includes('gearDown'),
      drs: roles.includes('drs'),
      boost: roles.includes('boost'),
      overtake: roles.includes('overtake'),
    });
  }
}

// Display-only physics for the sim fallback (NOT the firmware model -- see
// docs; only the ERS rates/boost are shared constants).
function updateSim(dt) {
  const boosting = (S.boost || S.overtake) && S.ers > 0;
  const ceil = caps[S.gear] * (boosting ? FEEL.ersBoostMultiplier : 1);
  const target = S.throttle * ceil;
  if (S.brake > 0.05) S.speed = Math.max(0, S.speed - (220 + S.brake * 420) * dt);
  else S.speed = lerp(S.speed, target, clamp((target > S.speed ? 1.6 : 1.1) * dt, 0, 1));
  S.speed = clamp(S.speed, 0, FEEL.topSpeedKmh * FEEL.ersBoostMultiplier);
  const lo = caps[S.gear - 1], hi = caps[S.gear];
  S.rpm = clamp((S.speed - lo) / Math.max(1, hi - lo), 0, 1);
  if (boosting) S.ers = Math.max(0, S.ers - FEEL.ersDeployPctPerSec * dt);
  else if (S.brake > 0.1 || S.throttle < 0.1) S.ers = Math.min(100, S.ers + FEEL.ersHarvestPctPerSec * dt);
}

// Three-state telemetry display (audit R01/F2): 'sim' only while NO source has
// ever been live; after that, staleness shows TELEMETRY LOST holding the last
// real values dimmed -- never a silent fall-back to simulated numbers.
function telemetryState() {
  return linkState({
    nowMs: performance.now(),
    lastTelemetryMs: telemFresh,
    everLive: telemEverLive,
    linkQualityPct: telem ? telem.linkQualityPct : undefined,
    failsafe: telem ? telem.failsafe : undefined,
  });
}

function render() {
  const state = telemetryState();
  // In every non-sim state the panels show real values -- `telem` still holds
  // the last merged snapshot when the stream stalls ('telemetry-lost').
  const useTelem = state !== 'sim';
  const stale = state === 'telemetry-lost';

  // Speed: real when telemetry present, else simulated.
  const showSpeed = useTelem && typeof telem.speedKmh === 'number' ? telem.speedKmh : S.speed;
  speedEl.textContent = Math.round(showSpeed);
  speedUnitEl.textContent = useTelem && typeof telem.speedKmh === 'number'
    ? (stale ? 'km/h · stale' : 'km/h') : 'km/h · sim';
  speedEl.classList.toggle('stale', stale);

  // Gear: telemetry gear if given, else the locally-tracked gear.
  const showGear = useTelem && typeof telem.gear === 'number' ? telem.gear : S.gear;
  gearEl.textContent = showSpeed < 1 && showGear === 1 ? 'N' : showGear;
  const shifting = S.rpm > 0.96 && S.gear < FEEL.gears && state === 'sim';
  gearEl.classList.toggle('shift', shifting);
  gearEl.classList.toggle('stale', stale);

  // Drive mode: car-authoritative only (the HUD has no local mode state -- the
  // mode is chosen upstream in elrs-joystick-control). Blank unless telemetry.
  const mode = useTelem && typeof telem.driveMode === 'number' ? DRIVE_MODES[telem.driveMode] : null;
  driveModeEl.textContent = mode ? mode.label : '';
  driveModeEl.className = (mode ? `drivemode ${mode.cls}` : 'drivemode') + (stale ? ' stale' : '');

  const lit = Math.round(S.rpm * REV_LIGHTS), third = REV_LIGHTS / 3;
  revs.forEach((r, i) => { r.className = ''; if (i < lit) r.classList.add(i < third ? 'g' : i < third * 2 ? 'r' : 'v'); });
  revEl.classList.toggle('redline', S.rpm > 0.985 && S.gear < FEEL.gears);

  // Command widgets: always the local mirror.
  thrEl.style.width = (S.throttle * 100).toFixed(0) + '%';
  brkEl.style.width = (S.brake * 100).toFixed(0) + '%';
  steerEl.style.left = 50 + S.steer * 42 + '%';
  // Camera reticle: pan = X, tilt = Y (stick up = look up = dot up).
  camDotEl.style.left = 50 + S.camPan * 40 + '%';
  camDotEl.style.top = 50 + S.camTilt * 40 + '%';
  drsEl.classList.toggle('on', S.drs);
  boostEl.classList.toggle('on', S.boost && S.ers > 0);
  otEl.classList.toggle('on', S.overtake && S.ers > 0);

  // ERS: telemetry ersPct if given, else simulated.
  const showErs = useTelem && typeof telem.ersPct === 'number' ? telem.ersPct : S.ers;
  ersEl.style.width = showErs.toFixed(0) + '%';
  ersPctEl.textContent = Math.round(showErs);
  ersEl.classList.toggle('deploy', (S.boost || S.overtake) && showErs > 0 && state === 'sim');
  ersEl.classList.toggle('low', showErs < 20);
  ersEl.classList.toggle('stale', stale);
  ersPctEl.classList.toggle('stale', stale);

  // Battery + link: only meaningful from telemetry.
  battVEl.textContent = useTelem && typeof telem.batteryV === 'number' ? telem.batteryV.toFixed(1) : '--';
  battVEl.classList.toggle('stale', stale);

  if (state === 'link-lost') {
    linkEl.textContent = 'LINK LOST'; linkEl.className = 'link lost';
  } else if (state === 'telemetry-lost') {
    linkEl.textContent = 'TELEMETRY LOST'; linkEl.className = 'link lost';
  } else if (state === 'live') {
    linkEl.textContent = `LQ ${Math.round(telem.linkQualityPct ?? 0)}%`; linkEl.className = 'link live';
  } else {
    linkEl.textContent = 'Telemetry: sim'; linkEl.className = 'link';
  }

  if (S.started) {
    const ms = performance.now() - S.t0;
    const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60, d = Math.floor(ms / 100) % 10;
    clockEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${d}`;
  }
}

// Read-only command/camera mirror for the outbound iPhone telemetry bridge:
// the same display values the HUD draws, sent one-way to main at ~20 Hz.
// Display only — this never drives the car (elrs-joystick-control does), and
// there is no return path from the iPhone into these values.
let lastMirrorSentMs = 0;
const MIRROR_SEND_PERIOD_MS = 50; // ~20 Hz, comfortably above the bridge's 10 Hz
function sendCommandMirror(now) {
  if (!window.groundStation || !window.groundStation.sendCommandMirror) return;
  if (now - lastMirrorSentMs < MIRROR_SEND_PERIOD_MS) return;
  lastMirrorSentMs = now;
  window.groundStation.sendCommandMirror({
    throttle: S.throttle,   // 0..1
    brake: S.brake,         // 0..1
    steering: S.steer,      // -1..1
    camPan: S.camPan,       // -1..1 (right stick X)
    camTilt: S.camTilt,     // -1..1 (right stick Y; up = negative)
    // video_lock is confidently green ONLY while frames flow (audit C1): a
    // stalled/reconnecting stream reports false, never a stale true.
    videoPlaying: videoStatus(videoState).live,
  });
}

let last = performance.now();
let uiNavPollErrored = false; // one console line, not one per frame (triage #9)
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (S.started || demo) { readInputs(); updateSim(dt); }
  render();
  sendCommandMirror(now);
  // Batch 9: drive controller UI-navigation on this existing per-frame poll tick
  // (setup flow AND live HUD). Display/focus only — a no-op until setupFlow.js
  // configures it, and never a control path (see renderer/uiNav.js). Guarded
  // (triage #9): confirm runs a click handler synchronously inside this frame
  // callback, and an exception here would otherwise end the rAF chain and
  // freeze the HUD for good — a mouse click throwing the same way only loses
  // its own event task. Log the first failure, keep the loop alive.
  try { uiNav.pollOnce(); } catch (err) {
    if (!uiNavPollErrored) { uiNavPollErrored = true; console.error('[uiNav] pollOnce failed:', err); }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// --- Wire up the bridge: config (WHEP url + feel constants) + telemetry. ---
// Each IPC fetch is guarded separately (audit N1): a failed config load falls
// back to the built-in feel constants and skips WHEP (the WAITING FOR VIDEO
// note stays up), a failed settings load keeps the default controller — the
// HUD keeps running either way instead of dying on an unhandled rejection.
async function init() {
  if (!window.groundStation) return; // opened outside Electron (bench preview)
  let cfg = null;
  try {
    cfg = await window.groundStation.getConfig();
  } catch (err) {
    console.error('[hud] config load failed:', err && err.message ? err.message : err);
  }
  if (cfg) {
    if (cfg.feel) { FEEL = { ...FEEL, ...cfg.feel }; computeCaps(); S.ers = 100; }
    setW3Chip(!!cfg.w3Active);
    // Replay chip reflects the EFFECTIVE telemetry source (post env-override):
    // `npm run demo` / W17_TELEMETRY_SOURCE=replay / the persisted setting all
    // resolve here. Runtime switches update it via setupFlow after applySession.
    setReplayChip(cfg.telemetrySource === 'replay');
  }

  // Video-state listeners on the WHEP <video> — attached unconditionally
  // (harmless with no stream) so the state model tracks buffering/stalled/error
  // even when the pipeline is not configured. The transport signals come from
  // the WHEP client's onStatus below.
  for (const ev of ['playing', 'waiting', 'stalled', 'emptied', 'ended', 'error']) {
    feed.addEventListener(ev, () => applyVideoEvent(ev));
  }
  renderVideo();

  // Apply the persisted controller choice (SEAT FIT step); defaults keep the
  // original first-pad + DualShock-layout behavior.
  if (window.groundStation.getSettings) {
    try {
      const { settings } = await window.groundStation.getSettings();
      if (settings && settings.controller) setControllerChoice(settings.controller);
    } catch (err) {
      console.error('[hud] settings load failed:', err && err.message ? err.message : err);
    }
  }

  window.groundStation.onTelemetry((t) => { telem = t; telemFresh = performance.now(); telemEverLive = true; });

  // Mapper head-intent diagnostics: one-way subscription, display-only. Absent
  // when the consumer is off (chip stays hidden). Never sends to the mapper.
  if (window.groundStation.onHeadIntentDiagnostics) {
    window.groundStation.onHeadIntentDiagnostics((snapshot) => renderHeadIntent(snapshot));
  }

  if (cfg && cfg.whepUrl) {
    startWhep(feed, cfg.whepUrl, {
      log: (m) => {
        console.log(m);
      },
      // Transport lifecycle -> the same video-state model (audit C1): a WebRTC
      // drop leaves the <video> frozen without a media event, so this is what
      // clears the confident-green lock immediately.
      onStatus: (status) => applyVideoEvent(status),
    });
  }
}
init();
