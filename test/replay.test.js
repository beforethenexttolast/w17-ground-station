import { describe, it, expect } from 'vitest';
import { ReplaySource, sampleTimeline, DEMO_TIMELINE } from '../shared/replaySource.js';
import {
  ERS_DEPLOY_PCT_PER_SEC,
  ERS_HARVEST_PCT_PER_SEC,
  ERS_BOOST_MULTIPLIER,
} from '../shared/feelConstants.js';

describe('sampleTimeline', () => {
  it('returns exact keyframe values at keyframe times', () => {
    const s = sampleTimeline(DEMO_TIMELINE, 0);
    expect(s.batteryPct).toBe(95);
    expect(s.armed).toBe(false);
  });

  it('interpolates numeric fields between keyframes', () => {
    // Halfway between t=1500 (speed 0) and t=6000 (speed 180) -> ~ mid.
    const midMs = (1500 + 6000) / 2;
    const s = sampleTimeline(DEMO_TIMELINE, midMs);
    expect(s.speedKmh).toBeGreaterThan(40);
    expect(s.speedKmh).toBeLessThan(140);
  });

  it('steps booleans from the earlier keyframe (failsafe during link loss)', () => {
    const s = sampleTimeline(DEMO_TIMELINE, 15000); // inside the 14000..16000 loss window
    expect(s.failsafe).toBe(true);
    expect(s.armed).toBe(false);
    expect(s.linkQualityPct).toBe(0);
  });

  it('steps driveMode as an enum (never interpolates to a fractional mode)', () => {
    // Between t=6000 (mode 2) and t=9000 (mode 1) it must hold 2, not 1.5.
    const s = sampleTimeline(DEMO_TIMELINE, 7500);
    expect(s.driveMode).toBe(2);
    expect(Number.isInteger(s.driveMode)).toBe(true);
  });

  it('loops (wraps modulo the timeline period)', () => {
    const period = DEMO_TIMELINE[DEMO_TIMELINE.length - 1].t;
    const a = sampleTimeline(DEMO_TIMELINE, 500);
    const b = sampleTimeline(DEMO_TIMELINE, period + 500);
    expect(b.batteryPct).toBeCloseTo(a.batteryPct, 5);
  });
});

describe('ReplaySource', () => {
  it('emits on the injected scheduler at the sampled state', () => {
    // Fake clock + manual scheduler for determinism.
    let now = 0;
    let tick = null;
    const src = new ReplaySource({
      clock: () => now,
      schedule: (fn) => {
        tick = fn;
        return 1;
      },
      cancel: () => {
        tick = null;
      },
    });
    const seen = [];
    src.onTelemetry((t) => seen.push(t));
    src.start();

    now = 0;
    tick();
    now = 6000;
    tick();

    expect(seen.length).toBe(2);
    expect(seen[1].gear).toBe(6); // t=6000 keyframe
    src.stop();
    expect(tick).toBeNull();
  });
});

describe('feel constants match the firmware ErsConfig numbers', () => {
  it('are the agreed shared values', () => {
    // Guards against drift from w17-control-fw/lib/ers/ErsSystem.hpp.
    expect(ERS_DEPLOY_PCT_PER_SEC).toBe(26);
    expect(ERS_HARVEST_PCT_PER_SEC).toBe(11);
    expect(ERS_BOOST_MULTIPLIER).toBeCloseTo(1.18, 5);
  });
});
