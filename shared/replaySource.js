// A TelemetrySource that replays a scripted timeline of Telemetry keyframes,
// interpolating numeric fields, at a fixed cadence. Doubles as the demo
// backend (a live-looking HUD with no car) and a test fixture. Uses an
// injectable clock + scheduler so it is deterministic under vitest. CommonJS.

const { TelemetrySource } = require('./telemetry.js');

// A built-in ~20s loop: spin up, a fast lap with ERS deploy/harvest, a
// battery sag, then a scripted link loss + recovery. Times are ms into loop.
// driveMode (0=Training 1=Race 2=ERS) steps like armed/failsafe -- it's an enum,
// not an interpolated quantity. Scripted so the demo cycles through all three.
const DEMO_TIMELINE = [
  { t: 0, speedKmh: 0, batteryV: 8.3, batteryPct: 95, armed: false, failsafe: false, linkQualityPct: 100, gear: 1, ersPct: 100, driveMode: 0 },
  { t: 1500, speedKmh: 0, batteryV: 8.3, batteryPct: 95, armed: true, failsafe: false, linkQualityPct: 100, gear: 1, ersPct: 100, driveMode: 1 },
  { t: 6000, speedKmh: 180, batteryV: 7.6, batteryPct: 70, armed: true, failsafe: false, linkQualityPct: 98, gear: 4, ersPct: 40, driveMode: 2 },
  { t: 9000, speedKmh: 90, batteryV: 7.9, batteryPct: 66, armed: true, failsafe: false, linkQualityPct: 96, gear: 3, ersPct: 75, driveMode: 1 },
  { t: 12000, speedKmh: 210, batteryV: 7.2, batteryPct: 55, armed: true, failsafe: false, linkQualityPct: 92, gear: 4, ersPct: 20, driveMode: 2 },
  { t: 14000, speedKmh: 0, batteryV: 7.2, batteryPct: 55, armed: false, failsafe: true, linkQualityPct: 0, gear: 4, ersPct: 20, driveMode: 2 },
  { t: 16000, speedKmh: 0, batteryV: 7.2, batteryPct: 54, armed: false, failsafe: true, linkQualityPct: 0, gear: 4, ersPct: 20, driveMode: 1 },
  { t: 17000, speedKmh: 60, batteryV: 7.4, batteryPct: 53, armed: true, failsafe: false, linkQualityPct: 90, gear: 2, ersPct: 30, driveMode: 1 },
  { t: 20000, speedKmh: 0, batteryV: 7.5, batteryPct: 52, armed: false, failsafe: false, linkQualityPct: 96, gear: 1, ersPct: 45, driveMode: 0 },
];

// Low-battery rehearsal loop (~20s): the demo timeline above deliberately
// never sags below 7.2 V, so it can NEVER show the low-battery banner
// (shared/lowBattery.mjs: warn 7.0 V / critical 6.6 V pack on the default 2S
// thresholds). This timeline is the banner's demo: a pack that sags into
// BATTERY LOW under throttle, recovers at idle but only INSIDE the 0.15 V
// hysteresis band (the banner honestly stays up), sags on into BATTERY
// CRITICAL, parks, and is then swapped for a fresh pack (7.6 V — clear of the
// exit band, banner gone). Demoable without draining a real pack; the numbers
// below are pinned against the REAL classifier in test/replay.test.js, so a
// threshold change that silently un-demos this loop fails a test instead.
const LOW_BATTERY_TIMELINE = [
  { t: 0, speedKmh: 0, batteryV: 7.9, batteryPct: 60, armed: false, failsafe: false, linkQualityPct: 100, gear: 1, ersPct: 80, driveMode: 0 },
  { t: 1500, speedKmh: 0, batteryV: 7.9, batteryPct: 60, armed: true, failsafe: false, linkQualityPct: 100, gear: 1, ersPct: 80, driveMode: 1 },
  { t: 5000, speedKmh: 160, batteryV: 6.9, batteryPct: 30, armed: true, failsafe: false, linkQualityPct: 97, gear: 4, ersPct: 45, driveMode: 1 },
  { t: 8000, speedKmh: 40, batteryV: 7.05, batteryPct: 28, armed: true, failsafe: false, linkQualityPct: 98, gear: 2, ersPct: 55, driveMode: 1 },
  { t: 12000, speedKmh: 190, batteryV: 6.5, batteryPct: 12, armed: true, failsafe: false, linkQualityPct: 95, gear: 4, ersPct: 15, driveMode: 2 },
  { t: 14500, speedKmh: 0, batteryV: 6.55, batteryPct: 10, armed: true, failsafe: false, linkQualityPct: 98, gear: 1, ersPct: 15, driveMode: 1 },
  { t: 17000, speedKmh: 0, batteryV: 6.9, batteryPct: 10, armed: false, failsafe: false, linkQualityPct: 100, gear: 1, ersPct: 15, driveMode: 0 },
  { t: 20000, speedKmh: 0, batteryV: 7.6, batteryPct: 55, armed: false, failsafe: false, linkQualityPct: 100, gear: 1, ersPct: 15, driveMode: 0 },
];

// Named timelines a replay session can be started on. The name is a dev/demo
// knob (env W17_REPLAY_TIMELINE via `npm run demo:low-battery`), never
// persisted settings — see main/appWiring.js telemetrySourceFor.
const TIMELINES = Object.freeze({
  demo: DEMO_TIMELINE,
  'low-battery': LOW_BATTERY_TIMELINE,
});

// Absent or unknown names fall back to the standard demo loop: a typo'd env
// var must degrade to the familiar demo, never to a dead HUD.
function timelineFor(name) {
  return TIMELINES[name] || DEMO_TIMELINE;
}

const NUMERIC_FIELDS = ['speedKmh', 'batteryV', 'batteryPct', 'linkQualityPct', 'gear', 'ersPct'];

function lerp(a, b, f) {
  return a + (b - a) * f;
}

// Sample the timeline (looping) at time `ms`. Numeric fields interpolate;
// booleans step from the earlier keyframe.
function sampleTimeline(timeline, ms) {
  const period = timeline[timeline.length - 1].t;
  const t = period > 0 ? ms % period : 0;
  let lo = timeline[0];
  let hi = timeline[timeline.length - 1];
  for (let i = 0; i < timeline.length - 1; i++) {
    if (t >= timeline[i].t && t < timeline[i + 1].t) {
      lo = timeline[i];
      hi = timeline[i + 1];
      break;
    }
  }
  const span = hi.t - lo.t;
  const f = span > 0 ? (t - lo.t) / span : 0;
  const out = {};
  for (const k of NUMERIC_FIELDS) {
    if (typeof lo[k] === 'number' && typeof hi[k] === 'number') {
      out[k] = k === 'gear' ? Math.round(lerp(lo[k], hi[k], f)) : lerp(lo[k], hi[k], f);
    }
  }
  out.armed = lo.armed;
  out.failsafe = lo.failsafe;
  if (typeof lo.driveMode === 'number') out.driveMode = lo.driveMode; // stepped enum
  return out;
}

class ReplaySource extends TelemetrySource {
  constructor({
    timeline = DEMO_TIMELINE,
    intervalMs = 50,
    clock = () => Date.now(),
    schedule = (fn, ms) => setInterval(fn, ms),
    cancel = (h) => clearInterval(h),
  } = {}) {
    super();
    this._timeline = timeline;
    this._intervalMs = intervalMs;
    this._clock = clock;
    this._schedule = schedule;
    this._cancel = cancel;
    this._t0 = null;
    this._handle = null;
  }

  start() {
    if (this._handle) return;
    this._t0 = this._clock();
    this._handle = this._schedule(() => {
      const elapsed = this._clock() - this._t0;
      this._emit(sampleTimeline(this._timeline, elapsed));
    }, this._intervalMs);
  }

  stop() {
    if (this._handle) {
      this._cancel(this._handle);
      this._handle = null;
    }
  }
}

module.exports = { ReplaySource, sampleTimeline, DEMO_TIMELINE, LOW_BATTERY_TIMELINE, TIMELINES, timelineFor };
