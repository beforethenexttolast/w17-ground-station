import { describe, it, expect } from 'vitest';
import { linkState, TELEMETRY_FRESH_MS } from '../shared/linkState.mjs';
import { sampleTimeline, DEMO_TIMELINE } from '../shared/replaySource.js';

// The HUD's three-state telemetry display (audit R01, option A): link loss is
// derived from LQ + staleness, never from a car-transmitted failsafe field.

describe('linkState', () => {
  it('never-live source -> sim (regardless of clock)', () => {
    expect(linkState({ nowMs: 0, lastTelemetryMs: 0, everLive: false })).toBe('sim');
    expect(
      linkState({ nowMs: 99999, lastTelemetryMs: 0, everLive: false, linkQualityPct: 0 })
    ).toBe('sim');
  });

  it('live, healthy telemetry -> live', () => {
    expect(
      linkState({ nowMs: 1500, lastTelemetryMs: 1400, everLive: true, linkQualityPct: 98 })
    ).toBe('live');
  });

  it('live with uplink LQ = 0 -> link-lost (the real-path trigger)', () => {
    expect(
      linkState({ nowMs: 1500, lastTelemetryMs: 1400, everLive: true, linkQualityPct: 0, failsafe: false })
    ).toBe('link-lost');
  });

  it('failsafe still triggers link-lost (demo/replay compatibility)', () => {
    expect(
      linkState({ nowMs: 1500, lastTelemetryMs: 1400, everLive: true, linkQualityPct: 90, failsafe: true })
    ).toBe('link-lost');
  });

  it('previously-live then stale -> telemetry-lost, and it is sticky (never reverts to sim)', () => {
    const base = { lastTelemetryMs: 1000, everLive: true, linkQualityPct: 98 };
    expect(linkState({ ...base, nowMs: 1000 + TELEMETRY_FRESH_MS })).toBe('telemetry-lost');
    // Minutes later it must still say telemetry-lost, not fall back to sim.
    expect(linkState({ ...base, nowMs: 1000 + 300000 })).toBe('telemetry-lost');
  });

  it('freshness boundary: one ms inside the window is still live', () => {
    expect(
      linkState({ nowMs: 1000 + TELEMETRY_FRESH_MS - 1, lastTelemetryMs: 1000, everLive: true, linkQualityPct: 50 })
    ).toBe('live');
  });

  it('missing LQ (e.g. only battery frames so far) is NOT link-lost', () => {
    expect(
      linkState({ nowMs: 1500, lastTelemetryMs: 1400, everLive: true, linkQualityPct: undefined })
    ).toBe('live');
  });
});

describe('demo timeline drives LINK LOST through the real LQ trigger', () => {
  it('the scripted link-loss window (t=14..16s) emits linkQualityPct 0', () => {
    const s = sampleTimeline(DEMO_TIMELINE, 15000);
    expect(s.linkQualityPct).toBe(0);
    // Even with the demo's failsafe flag stripped, LQ=0 alone must show
    // LINK LOST -- proving the trigger the real car path will exercise.
    expect(
      linkState({ nowMs: 100, lastTelemetryMs: 50, everLive: true, linkQualityPct: s.linkQualityPct, failsafe: false })
    ).toBe('link-lost');
  });

  it('outside the loss window the demo reads live', () => {
    const s = sampleTimeline(DEMO_TIMELINE, 7000);
    expect(s.linkQualityPct).toBeGreaterThan(0);
    expect(
      linkState({ nowMs: 100, lastTelemetryMs: 50, everLive: true, linkQualityPct: s.linkQualityPct, failsafe: s.failsafe })
    ).toBe('live');
  });
});
