import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { linkState, TELEMETRY_FRESH_MS } from '../shared/linkState.mjs';
import { iphoneBridgeConfigFromEnv, DEFAULT_PORT } from '../main/iphoneBridgeConfig.js';

// The bridge modules are CommonJS (main-process); load via require from ESM.
const require = createRequire(import.meta.url);
const { IphoneTelemetryBridge, MIRROR_FRESH_MS } = require('../main/IphoneTelemetryBridge.js');

// Fake UDP socket recording every send, plus manual scheduler and clock, so
// cadence + staleness are deterministic (no real network, no real timers).
function harness({ addr = '10.0.0.5', port = 5601, rateHz = 10, mode } = {}) {
  const sent = [];
  const socket = {
    send: (buf, p, a) => sent.push({ json: JSON.parse(buf.toString()), port: p, addr: a }),
    close: vi.fn(),
    on: vi.fn(),
  };
  let now = 1_000_000;
  const ticks = [];
  const bridge = new IphoneTelemetryBridge({
    addr,
    port,
    rateHz,
    mode,
    linkStateFn: linkState,
    clock: () => now,
    socketFactory: () => socket,
    schedule: (fn) => { ticks.push(fn); return ticks.length - 1; },
    cancel: (h) => { ticks[h] = null; },
  });
  return {
    bridge, sent, socket,
    tick: () => ticks.forEach((f) => f && f()),
    advance: (ms) => { now += ms; },
  };
}

describe('iphoneBridgeConfigFromEnv — disabled by default (iPhone contract ports)', () => {
  it('default telemetry port is 5601 per the iPhone contract', () => {
    expect(DEFAULT_PORT).toBe(5601);
  });

  it('returns null when W17_IPHONE_BRIDGE is unset (app unchanged)', () => {
    expect(iphoneBridgeConfigFromEnv({})).toBeNull();
  });

  it('returns null when enabled but no address', () => {
    const warn = vi.fn();
    expect(iphoneBridgeConfigFromEnv({ W17_IPHONE_BRIDGE: '1' }, warn)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('resolves address + defaults 5601/10Hz when enabled', () => {
    expect(iphoneBridgeConfigFromEnv({ W17_IPHONE_BRIDGE: '1', W17_IPHONE_ADDR: '192.168.1.9' }))
      .toEqual({ addr: '192.168.1.9', port: 5601, rateHz: 10 });
  });

  it('honors port + rate overrides', () => {
    expect(iphoneBridgeConfigFromEnv({
      W17_IPHONE_BRIDGE: '1', W17_IPHONE_ADDR: '192.168.1.9',
      W17_IPHONE_PORT: '50000', W17_IPHONE_RATE_HZ: '20',
    })).toEqual({ addr: '192.168.1.9', port: 50000, rateHz: 20 });
  });
});

describe('IphoneTelemetryBridge — construction guards', () => {
  it('throws without a destination address', () => {
    expect(() => new IphoneTelemetryBridge({ linkStateFn: linkState })).toThrow(/addr/);
  });

  it('throws without a linkStateFn', () => {
    expect(() => new IphoneTelemetryBridge({ addr: '10.0.0.5' })).toThrow(/linkStateFn/);
  });

  it('sends nothing before start()', () => {
    const h = harness();
    h.tick();
    expect(h.sent).toHaveLength(0);
  });
});

describe('IphoneTelemetryBridge — sending (iPhone contract shape)', () => {
  it('sends one snake_case datagram per tick to the configured destination', () => {
    const h = harness({ addr: '10.0.0.9' });
    h.bridge.start();
    h.bridge.onTelemetry({ speedKmh: 100, batteryV: 7.7, linkQualityPct: 95, rssiDbm: -60, snrDb: 12, gear: 3, ersPct: 50, driveMode: 1 });
    h.tick();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].addr).toBe('10.0.0.9');
    expect(h.sent[0].port).toBe(5601);
    const p = h.sent[0].json;
    expect(p.protocol_version).toBe(1);
    expect(p.timestamp_ms).toBeTypeOf('number');
    expect(p.speed_kmh).toBe(100);
    expect(p.battery_v).toBe(7.7);
    expect(p.link_quality).toBe(95);
    expect(p.rssi_dbm).toBe(-60);
    expect(p.snr_db).toBe(12);
    expect(p.drive_mode).toBe('GEARBOX');
    expect(p.link_state).toBe('connected');
    // The telemetry packet has NO seq (only head-tracking packets do).
    expect(p).not.toHaveProperty('seq');
  });

  it('coalesces bursts: many onTelemetry, one packet per tick, latest wins', () => {
    const h = harness();
    h.bridge.start();
    h.bridge.onTelemetry({ speedKmh: 10, linkQualityPct: 90 });
    h.bridge.onTelemetry({ speedKmh: 20, linkQualityPct: 90 });
    h.bridge.onTelemetry({ speedKmh: 30, linkQualityPct: 90 }); // latest
    h.tick();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].json.speed_kmh).toBe(30);
  });

  it('never-live -> minimal packet (no car fields, no fake values)', () => {
    const h = harness();
    h.bridge.start();
    h.tick();
    const p = h.sent[0].json;
    expect(p).toEqual({ protocol_version: 1, timestamp_ms: p.timestamp_ms });
  });

  it('link-lost (fresh LQ=0) -> real 0 + warning; stale source -> fields omitted + stale_data_warnings', () => {
    const h = harness();
    h.bridge.start();

    h.bridge.onTelemetry({ speedKmh: 50, linkQualityPct: 88, batteryV: 7.5 });
    h.tick();
    expect(h.sent.at(-1).json.link_state).toBe('connected');

    h.bridge.onTelemetry({ speedKmh: 0, linkQualityPct: 0, batteryV: 7.2 });
    h.tick();
    let p = h.sent.at(-1).json;
    expect(p.link_quality).toBe(0);
    expect(p.warning).toBe('LINK LOST');
    expect(p.link_state).toBe('degraded');

    // Source goes silent past the freshness window: never re-send old values.
    h.advance(TELEMETRY_FRESH_MS + 50);
    h.tick();
    p = h.sent.at(-1).json;
    expect(p.stale_data_warnings).toEqual(['telemetry']);
    expect(p.link_state).toBe('disconnected');
    for (const k of ['battery_v', 'link_quality', 'speed_kmh']) {
      expect(p, `${k} must not be re-sent as fresh`).not.toHaveProperty(k);
    }
  });

  it('never emits demo-only armed/failsafe even when the source sets them', () => {
    const h = harness();
    h.bridge.start();
    h.bridge.onTelemetry({ armed: true, failsafe: true, batteryV: 8.0, linkQualityPct: 90 });
    h.tick();
    expect(h.sent.at(-1).json).not.toHaveProperty('armed');
    expect(h.sent.at(-1).json).not.toHaveProperty('failsafe');
  });

  it('tags mode: "demo" when configured (replay source)', () => {
    const h = harness({ mode: 'demo' });
    h.bridge.start();
    h.tick();
    expect(h.sent[0].json.mode).toBe('demo');
  });
});

describe('IphoneTelemetryBridge — read-only command mirror', () => {
  it('mirror fields ride along and are pure display values', () => {
    const h = harness();
    h.bridge.start();
    h.bridge.onCommandMirror({ throttle: 0.4, brake: 0, steering: -0.2, camPan: 0.5, camTilt: -0.5, videoPlaying: true });
    h.tick();
    const p = h.sent.at(-1).json;
    expect(p.throttle).toBe(0.4);
    expect(p.steering).toBe(-0.2);
    expect(p.camera_yaw_deg).toBe(45);
    expect(p.camera_pitch_deg).toBe(45);
    expect(p.head_tracking_mode).toBe('DS4');
    expect(p.video_lock).toBe(true);
  });

  it('a stale mirror (renderer silent) is omitted, not frozen', () => {
    const h = harness();
    h.bridge.start();
    h.bridge.onCommandMirror({ throttle: 0.4, brake: 0, steering: 0 });
    h.tick();
    expect(h.sent.at(-1).json).toHaveProperty('throttle');

    h.advance(MIRROR_FRESH_MS + 50);
    h.tick();
    const p = h.sent.at(-1).json;
    for (const k of ['throttle', 'brake', 'steering', 'head_tracking_mode', 'video_lock']) {
      expect(p, `${k} must be omitted when the mirror is stale`).not.toHaveProperty(k);
    }
  });

  it('the bridge has no receive path: onCommandMirror/onTelemetry are the only inputs', () => {
    // Structural: the bridge exposes no message/packet handler an iPhone could
    // reach — its public surface is construction, feeds, start, stop.
    const h = harness();
    const publicApi = Object.getOwnPropertyNames(Object.getPrototypeOf(h.bridge))
      .filter((n) => n !== 'constructor' && !n.startsWith('_'));
    expect(publicApi.sort()).toEqual(['onCommandMirror', 'onTelemetry', 'start', 'stop']);
  });
});

describe('IphoneTelemetryBridge — lifecycle', () => {
  it('stop() cancels the timer, closes the socket, sends nothing further', () => {
    const h = harness();
    h.bridge.start();
    h.bridge.onTelemetry({ linkQualityPct: 90 });
    h.tick();
    const count = h.sent.length;
    h.bridge.stop();
    expect(h.socket.close).toHaveBeenCalled();
    h.tick();
    expect(h.sent).toHaveLength(count);
  });
});
