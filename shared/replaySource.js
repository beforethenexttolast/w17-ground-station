// A TelemetrySource that replays a scripted timeline of Telemetry keyframes,
// interpolating numeric fields, at a fixed cadence. Doubles as the demo
// backend (a live-looking HUD with no car) and a test fixture. Uses an
// injectable clock + scheduler so it is deterministic under vitest.

import { TelemetrySource } from './telemetry.js';

// A built-in ~20s loop: spin up, a fast lap with ERS deploy/harvest, a
// battery sag, then a scripted link loss + recovery. Times are ms into loop.
export const DEMO_TIMELINE = [
  { t: 0, speedKmh: 0, batteryV: 8.3, batteryPct: 95, armed: false, failsafe: false, linkQualityPct: 100, gear: 1, ersPct: 100 },
  { t: 1500, speedKmh: 0, batteryV: 8.3, batteryPct: 95, armed: true, failsafe: false, linkQualityPct: 100, gear: 1, ersPct: 100 },
  { t: 6000, speedKmh: 180, batteryV: 7.6, batteryPct: 70, armed: true, failsafe: false, linkQualityPct: 98, gear: 6, ersPct: 40 },
  { t: 9000, speedKmh: 90, batteryV: 7.9, batteryPct: 66, armed: true, failsafe: false, linkQualityPct: 96, gear: 3, ersPct: 75 },
  { t: 12000, speedKmh: 210, batteryV: 7.2, batteryPct: 55, armed: true, failsafe: false, linkQualityPct: 92, gear: 7, ersPct: 20 },
  // Link loss: LQ collapses, failsafe asserts, speed unknown.
  { t: 14000, speedKmh: 0, batteryV: 7.2, batteryPct: 55, armed: false, failsafe: true, linkQualityPct: 0, gear: 7, ersPct: 20 },
  { t: 16000, speedKmh: 0, batteryV: 7.2, batteryPct: 54, armed: false, failsafe: true, linkQualityPct: 0, gear: 7, ersPct: 20 },
  // Recovery.
  { t: 17000, speedKmh: 60, batteryV: 7.4, batteryPct: 53, armed: true, failsafe: false, linkQualityPct: 90, gear: 2, ersPct: 30 },
  { t: 20000, speedKmh: 0, batteryV: 7.5, batteryPct: 52, armed: false, failsafe: false, linkQualityPct: 96, gear: 1, ersPct: 45 },
];

const NUMERIC_FIELDS = ['speedKmh', 'batteryV', 'batteryPct', 'linkQualityPct', 'gear', 'ersPct'];

function lerp(a, b, f) {
  return a + (b - a) * f;
}

// Sample the timeline (looping) at time `ms`. Numeric fields interpolate;
// booleans step from the earlier keyframe.
export function sampleTimeline(timeline, ms) {
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
  return out;
}

export class ReplaySource extends TelemetrySource {
  // clock() -> ms; schedule(fn, ms) -> handle; cancel(handle). Defaults use
  // wall-clock + timers; tests inject a fake clock/scheduler.
  constructor({
    timeline = DEMO_TIMELINE,
    intervalMs = 50, // 20 Hz
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
