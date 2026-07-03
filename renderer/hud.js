// HUD renderer. Two data sources, cleanly layered:
//   COMMAND side (throttle/brake/steer/DRS/boost/overtake/gear-shifts) always
//     comes from the local gamepad/keyboard -- the driver commands these, so
//     the ground already knows them with zero latency. This is a MIRROR; it
//     does not drive the car (elrs-joystick-control does).
//   CAR-SIDE TRUTH (real speed, battery, armed, failsafe, link quality, and
//     optionally gear/ers) arrives as telemetry over the preload bridge and
//     OVERRIDES the simulated values when present. With no telemetry source,
//     a display-only physics model animates speed/rpm/ers so the HUD is fully
//     alive from the gamepad alone.
import { startWhep } from './whep.js';

const el = (id) => document.getElementById(id);
const revEl = el('rev'), speedEl = el('speed'), speedUnitEl = el('speedUnit'),
  gearEl = el('gear'), thrEl = el('thr'), brkEl = el('brk'), steerEl = el('steer'),
  ersEl = el('ers'), ersPctEl = el('ersPct'), battVEl = el('battV'),
  drsEl = el('drs'), boostEl = el('boost'), otEl = el('ot'),
  clockEl = el('clock'), gpEl = el('gpStatus'), linkEl = el('linkStatus'),
  gate = el('gate'), gateStatus = el('gateStatus'), startBtn = el('startBtn'),
  demoBtn = el('demoBtn'), feed = el('feed'), feedNote = el('feedNote');

const REV_LIGHTS = 12;
for (let i = 0; i < REV_LIGHTS; i++) revEl.appendChild(document.createElement('i'));
const revs = [...revEl.children];

// Feel constants come from main (single source: shared/feelConstants.js).
let FEEL = { gears: 8, topSpeedKmh: 320, ersDeployPctPerSec: 26, ersHarvestPctPerSec: 11, ersBoostMultiplier: 1.18 };
let caps = [];
function computeCaps() {
  caps = [0];
  for (let g = 1; g <= FEEL.gears; g++) caps[g] = Math.round(FEEL.topSpeedKmh * Math.pow(g / FEEL.gears, 0.82));
}
computeCaps();

const S = {
  started: false, gear: 1, speed: 0, rpm: 0, ers: 100,
  throttle: 0, brake: 0, steer: 0, drs: false, boost: false, overtake: false,
  t0: performance.now(), connected: false,
};

// Latest telemetry (car-side truth); null fields fall back to simulation.
let telem = null;
let telemFresh = 0; // performance.now() of last telemetry packet

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

function pad() { const ps = navigator.getGamepads ? navigator.getGamepads() : []; return [...ps].find((p) => p) || null; }
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
}

function readInputs() {
  if (demo) { readDemo(); return; }
  const p = pad();
  if (p) {
    const ax = p.axes, b = p.buttons;
    S.steer = clamp(ax[0] || 0, -1, 1);
    S.throttle = b[7] ? b[7].value : 0;
    S.brake = b[6] ? b[6].value : 0;
    const up = !!(b[5] && b[5].pressed), down = !!(b[4] && b[4].pressed);
    if (up && !prev.up) shift(1);
    if (down && !prev.down) shift(-1);
    prev.up = up; prev.down = down;
    const drsBtn = !!(b[3] && b[3].pressed);
    if (drsBtn && !prev.drs) S.drs = !S.drs;
    prev.drs = drsBtn;
    S.boost = !!(b[1] && b[1].pressed);
    S.overtake = !!(b[2] && b[2].pressed);
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

function telemetryLive() { return telem && performance.now() - telemFresh < 1000; }

function render() {
  const live = telemetryLive();

  // Speed: real when telemetry present, else simulated.
  const showSpeed = live && typeof telem.speedKmh === 'number' ? telem.speedKmh : S.speed;
  speedEl.textContent = Math.round(showSpeed);
  speedUnitEl.textContent = live && typeof telem.speedKmh === 'number' ? 'km/h' : 'km/h · sim';

  // Gear: telemetry gear if given, else the locally-tracked gear.
  const showGear = live && typeof telem.gear === 'number' ? telem.gear : S.gear;
  gearEl.textContent = showSpeed < 1 && showGear === 1 ? 'N' : showGear;
  const shifting = S.rpm > 0.96 && S.gear < FEEL.gears && !live;
  gearEl.classList.toggle('shift', shifting);

  const lit = Math.round(S.rpm * REV_LIGHTS), third = REV_LIGHTS / 3;
  revs.forEach((r, i) => { r.className = ''; if (i < lit) r.classList.add(i < third ? 'g' : i < third * 2 ? 'r' : 'v'); });
  revEl.classList.toggle('redline', S.rpm > 0.985 && S.gear < FEEL.gears);

  // Command widgets: always the local mirror.
  thrEl.style.width = (S.throttle * 100).toFixed(0) + '%';
  brkEl.style.width = (S.brake * 100).toFixed(0) + '%';
  steerEl.style.left = 50 + S.steer * 42 + '%';
  drsEl.classList.toggle('on', S.drs);
  boostEl.classList.toggle('on', S.boost && S.ers > 0);
  otEl.classList.toggle('on', S.overtake && S.ers > 0);

  // ERS: telemetry ersPct if given, else simulated.
  const showErs = live && typeof telem.ersPct === 'number' ? telem.ersPct : S.ers;
  ersEl.style.width = showErs.toFixed(0) + '%';
  ersPctEl.textContent = Math.round(showErs);
  ersEl.classList.toggle('deploy', (S.boost || S.overtake) && showErs > 0 && !live);
  ersEl.classList.toggle('low', showErs < 20);

  // Battery + link: only meaningful from telemetry.
  battVEl.textContent = live && typeof telem.batteryV === 'number' ? telem.batteryV.toFixed(1) : '--';

  if (live) {
    if (telem.failsafe) { linkEl.textContent = 'LINK LOST'; linkEl.className = 'link lost'; }
    else { linkEl.textContent = `LQ ${Math.round(telem.linkQualityPct ?? 0)}%`; linkEl.className = 'link live'; }
  } else {
    linkEl.textContent = 'Telemetry: sim'; linkEl.className = 'link';
  }

  if (S.started) {
    const ms = performance.now() - S.t0;
    const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60, d = Math.floor(ms / 100) % 10;
    clockEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${d}`;
  }
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (S.started || demo) { readInputs(); updateSim(dt); }
  render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// --- Wire up the bridge: config (WHEP url + feel constants) + telemetry. ---
async function init() {
  if (!window.groundStation) return; // opened outside Electron (bench preview)
  const cfg = await window.groundStation.getConfig();
  if (cfg.feel) { FEEL = { ...FEEL, ...cfg.feel }; computeCaps(); S.ers = 100; }

  window.groundStation.onTelemetry((t) => { telem = t; telemFresh = performance.now(); });

  if (cfg.whepUrl) {
    startWhep(feed, cfg.whepUrl, {
      log: (m) => {
        console.log(m);
      },
    });
    feed.addEventListener('playing', () => feedNote.classList.add('hidden'));
    feed.addEventListener('emptied', () => feedNote.classList.remove('hidden'));
  }
}
init();
