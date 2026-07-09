import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SessionRuntime } = require('../main/sessionRuntime.js');
const { TelemetrySource } = require('../shared/telemetry.js');

// Fake source/bridge factories so start/stop choreography is observable
// without sockets, timers, or Electron.
function harness() {
  const sources = [];
  const bridges = [];
  const runtime = new SessionRuntime({
    createTelemetrySource: (cfg) => {
      if (cfg.source === 'none') return null;
      const src = new TelemetrySource();
      src.cfg = cfg;
      src.start = vi.fn();
      src.stop = vi.fn();
      sources.push(src);
      return src;
    },
    createIphoneBridge: (cfg, { demo }) => {
      const bridge = {
        cfg,
        demo,
        start: vi.fn(),
        stop: vi.fn(),
        onTelemetry: vi.fn(),
        onCommandMirror: vi.fn(),
      };
      bridges.push(bridge);
      return bridge;
    },
  });
  return { runtime, sources, bridges };
}

const CFG = {
  none: { telemetry: { source: 'none', port: '' }, iphoneBridge: null },
  replay: { telemetry: { source: 'replay', port: '' }, iphoneBridge: null },
  replayBridge: {
    telemetry: { source: 'replay', port: '' },
    iphoneBridge: { addr: '192.168.4.2', port: 5601, rateHz: 10 },
  },
};

describe('SessionRuntime — diff-aware apply/stop choreography', () => {
  it('source "none" creates nothing and reports no telemetry source', () => {
    const { runtime, sources } = harness();
    expect(runtime.applyConfig(CFG.none)).toEqual({ telemetry: 'none', iphoneBridge: false });
    expect(sources).toHaveLength(0);
    expect(runtime.hasTelemetrySource()).toBe(false);
  });

  it('starts source + bridge and fans snapshots out to BOTH sinks', () => {
    const { runtime, sources, bridges } = harness();
    runtime.applyConfig(CFG.replayBridge);
    const sink = vi.fn();
    runtime.setSnapshotSink(sink);
    expect(sources[0].start).toHaveBeenCalledOnce();
    expect(bridges[0].start).toHaveBeenCalledOnce();
    expect(bridges[0].demo).toBe(true); // replay source tags the bridge demo

    sources[0]._emit({ speedKmh: 42 });
    expect(sink).toHaveBeenCalledWith({ speedKmh: 42 });
    expect(bridges[0].onTelemetry).toHaveBeenCalledWith({ speedKmh: 42 });
  });

  it('re-applying an identical config is a no-op (no blink on GRID re-apply)', () => {
    const { runtime, sources, bridges } = harness();
    runtime.applyConfig(CFG.replayBridge);
    runtime.applyConfig(CFG.replayBridge);
    expect(sources).toHaveLength(1);
    expect(bridges).toHaveLength(1);
    expect(sources[0].stop).not.toHaveBeenCalled();
    expect(bridges[0].stop).not.toHaveBeenCalled();
  });

  it('a changed subsystem stops the old instance before starting the new', () => {
    const { runtime, sources, bridges } = harness();
    runtime.applyConfig(CFG.replayBridge);
    runtime.applyConfig({
      ...CFG.replayBridge,
      iphoneBridge: { addr: '192.168.4.9', port: 5601, rateHz: 10 },
    });
    expect(bridges[0].stop).toHaveBeenCalledOnce();
    expect(bridges[1].start).toHaveBeenCalledOnce();
    expect(sources).toHaveLength(1); // unchanged telemetry kept running
  });

  it('removing the bridge stops it; old source unsubscribed on source change', () => {
    const { runtime, sources, bridges } = harness();
    runtime.applyConfig(CFG.replayBridge);
    runtime.applyConfig(CFG.replay);
    expect(bridges[0].stop).toHaveBeenCalledOnce();

    runtime.applyConfig({ ...CFG.replay, telemetry: { source: 'crsf-serial', port: 'COM7' } });
    expect(sources[0].stop).toHaveBeenCalledOnce();
    const sink = vi.fn();
    runtime.setSnapshotSink(sink);
    sources[0]._emit({ speedKmh: 1 }); // stale source: listener was removed
    expect(sink).not.toHaveBeenCalled();
    sources[1]._emit({ speedKmh: 2 });
    expect(sink).toHaveBeenCalledWith({ speedKmh: 2 });
  });

  it('onCommandMirror forwards outward only while a bridge exists', () => {
    const { runtime, bridges } = harness();
    runtime.onCommandMirror({ throttle: 1 }); // no bridge: silently dropped
    runtime.applyConfig(CFG.replayBridge);
    runtime.onCommandMirror({ throttle: 0.5 });
    expect(bridges[0].onCommandMirror).toHaveBeenCalledWith({ throttle: 0.5 });
  });

  it('stopAll stops everything and forgets keys (fresh apply restarts)', () => {
    const { runtime, sources, bridges } = harness();
    runtime.applyConfig(CFG.replayBridge);
    runtime.stopAll();
    expect(sources[0].stop).toHaveBeenCalledOnce();
    expect(bridges[0].stop).toHaveBeenCalledOnce();
    runtime.applyConfig(CFG.replayBridge);
    expect(sources).toHaveLength(2);
    expect(bridges).toHaveLength(2);
  });
});
