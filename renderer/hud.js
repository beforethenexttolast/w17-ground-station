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
import { getPreset, selectGamepad, DEFAULT_PRESET } from '../shared/inputPresets.mjs';

const el = (id) => document.getElementById(id);
const revEl = el('rev'), speedEl = el('speed'), speedUnitEl = el('speedUnit'),
  gearEl = el('gear'), driveModeEl = el('driveMode'), thrEl = el('thr'), brkEl = el('brk'), steerEl = el('steer'),
  ersEl = el('ers'), ersPctEl = el('ersPct'), battVEl = el('battV'),
  drsEl = el('drs'), boostEl = el('boost'), otEl = el('ot'), camDotEl = el('camdot'),
  clockEl = el('clock'), gpEl = el('gpStatus'), linkEl = el('linkStatus'),
  gate = el('gate'), gateStatus = el('gateStatus'), startBtn = el('startBtn'),
  demoBtn = el('demoBtn'), feed = el('feed'), feedNote = el('feedNote');

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

addEventListener('keydown', (e) => {
  keys[e.key.toLowerCase()] = true;
  if (e.key === 'Enter') start();
  if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(e.key.toLowerCase())) e.preventDefault();
});
addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });
addEventListener('gamepadconnected', refreshPad);
addEventListener('gamepaddisconnected', refreshPad);
startBtn.addEventListener('click', start);
demoBtn.addEventListener('click', () => {
  demo = !demo;
  demoBtn.classList.toggle('on', demo);
  demoBtn.textContent = demo ? '■ Demo running' : '▶ Demo mode';
  if (demo) start();
});

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
function refreshPad() {
  const p = pad();
  S.connected = !!p;
  gpEl.textContent = p ? 'Controller ready' : 'No controller';
  gpEl.classList.toggle('on', !!p);
  if (!S.started) {
    gateStatus.textContent = p ? 'Controller connected' : 'No controller — use keyboard or Demo';
    gateStatus.className = 'status ' + (p ? 'ok' : 'no');
  }
}
function start() { if (S.started) return; S.started = true; S.t0 = performance.now(); gate.classList.add('hidden'); }
setInterval(refreshPad, 600); refreshPad();

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
function shift(dir) { S.gear = clamp(S.gear + dir, 1, FEEL.gears); }

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
  const p = pad();
  if (p) {
    const ax = p.axes, b = p.buttons;
    const m = activePreset.map; // layout preset (SEAT FIT); dualshock = legacy indices
    S.steer = clamp(ax[m.steerAxis] || 0, -1, 1);
    S.throttle = b[m.throttleBtn] ? b[m.throttleBtn].value : 0;
    S.brake = b[m.brakeBtn] ? b[m.brakeBtn].value : 0;
    const up = !!(b[m.gearUpBtn] && b[m.gearUpBtn].pressed), down = !!(b[m.gearDownBtn] && b[m.gearDownBtn].pressed);
    if (up && !prev.up) shift(1);
    if (down && !prev.down) shift(-1);
    prev.up = up; prev.down = down;
    const drsBtn = !!(b[m.drsBtn] && b[m.drsBtn].pressed);
    if (drsBtn && !prev.drs) S.drs = !S.drs;
    prev.drs = drsBtn;
    S.boost = !!(b[m.boostBtn] && b[m.boostBtn].pressed);
    S.overtake = !!(b[m.overtakeBtn] && b[m.overtakeBtn].pressed);
    // Right stick -> camera gimbal (mirror; the car aims it via ch9/ch10).
    S.camPan = clamp(ax[m.camPanAxis] || 0, -1, 1);
    S.camTilt = clamp(ax[m.camTiltAxis] || 0, -1, 1);
  } else {
    S.steer = clamp((keys.arrowright ? 1 : 0) - (keys.arrowleft ? 1 : 0), -1, 1);
    S.throttle = keys.arrowup ? 1 : 0;
    S.brake = keys.arrowdown ? 1 : 0;
    const up = !!keys.e, down = !!keys.q;
    if (up && !prev.up) shift(1);
    if (down && !prev.down) shift(-1);
    prev.up = up; prev.down = down;
    if (keys.d && !prev.drs) S.drs = !S.drs;
    prev.drs = !!keys.d;
    S.boost = !!keys.b;
    S.overtake = !!keys.o;
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
let videoPlaying = false;
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
    videoPlaying,           // whether the WHEP <video> is currently playing
  });
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (S.started || demo) { readInputs(); updateSim(dt); }
  render();
  sendCommandMirror(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// --- Wire up the bridge: config (WHEP url + feel constants) + telemetry. ---
async function init() {
  if (!window.groundStation) return; // opened outside Electron (bench preview)
  const cfg = await window.groundStation.getConfig();
  if (cfg.feel) { FEEL = { ...FEEL, ...cfg.feel }; computeCaps(); S.ers = 100; }

  // Apply the persisted controller choice (SEAT FIT step); defaults keep the
  // original first-pad + DualShock-layout behavior.
  if (window.groundStation.getSettings) {
    const { settings } = await window.groundStation.getSettings();
    if (settings && settings.controller) setControllerChoice(settings.controller);
  }

  window.groundStation.onTelemetry((t) => { telem = t; telemFresh = performance.now(); telemEverLive = true; });

  if (cfg.whepUrl) {
    startWhep(feed, cfg.whepUrl, {
      log: (m) => {
        console.log(m);
      },
    });
    feed.addEventListener('playing', () => { feedNote.classList.add('hidden'); videoPlaying = true; });
    feed.addEventListener('emptied', () => { feedNote.classList.remove('hidden'); videoPlaying = false; });
  }
}
init();
