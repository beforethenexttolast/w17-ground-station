import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import {
  validateHeadTrackingPacket,
  HeadTrackingMonitor,
  DEFAULT_STALE_MS,
  MAX_PACKET_BYTES,
} from '../shared/headTracking.js';
import { headTrackingConfigFromEnv, DEFAULT_PORT } from '../main/headTrackingConfig.js';

const require = createRequire(import.meta.url);
const { HeadTrackingReceiver } = require('../main/HeadTrackingReceiver.js');

// A valid packet exactly as iPhone_rc/scripts/send_fake_head_tracking.py emits.
const VALID = {
  protocol_version: 1,
  seq: 7,
  timestamp_ms: 1783184400000,
  yaw_deg: -12.5,
  pitch_deg: 6.8,
  roll_deg: 1.2,
  tracking_enabled: true,
  centered: true,
};
const buf = (obj) => Buffer.from(JSON.stringify(obj));

describe('validateHeadTrackingPacket — acceptance (iPhone contract §3)', () => {
  it('accepts the reference-sender packet shape', () => {
    const r = validateHeadTrackingPacket(buf(VALID));
    expect(r.ok).toBe(true);
    expect(r.packet.seq).toBe(7);
    expect(r.packet.yaw_deg).toBe(-12.5);
    expect(r.packet.tracking_enabled).toBe(true);
    expect(r.packet.centered).toBe(true);
  });

  it('missing protocol_version is treated as version 1 (bench phase rule)', () => {
    const { protocol_version, ...noVersion } = VALID;
    const r = validateHeadTrackingPacket(buf(noVersion));
    expect(r.ok).toBe(true);
    expect(r.packet.protocol_version).toBe(1);
  });

  it('accepts optional timeout_ms in range 1..5000 (app default 250)', () => {
    const r = validateHeadTrackingPacket(buf({ ...VALID, timeout_ms: 250 }));
    expect(r.ok).toBe(true);
    expect(r.packet.timeout_ms).toBe(250);
  });

  it('missing optional centered/calibrated/timeout_ms normalize to null', () => {
    const { centered, ...noCentered } = VALID;
    const r = validateHeadTrackingPacket(buf(noCentered));
    expect(r.ok).toBe(true);
    expect(r.packet.centered).toBeNull();
    expect(r.packet.calibrated).toBeNull();
    expect(r.packet.timeout_ms).toBeNull();
  });
});

describe('validateHeadTrackingPacket — rejection (contract "Malformed Packet Rejection")', () => {
  const reject = (raw, reason) => {
    const r = validateHeadTrackingPacket(raw);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(reason);
  };

  it('malformed JSON (the fake sender --malformed payload)', () => {
    reject(Buffer.from('{"seq": 1, "timestamp_ms": 123, bad json'), 'malformed-json');
  });

  it('non-object JSON', () => {
    reject(buf([1, 2, 3]), 'not-object');
    reject(buf(42), 'not-object');
    reject(Buffer.from('null'), 'not-object');
  });

  it('unsupported protocol_version', () => {
    reject(buf({ ...VALID, protocol_version: 2 }), 'bad-version');
  });

  it('missing or invalid required fields', () => {
    const { seq, ...noSeq } = VALID;
    reject(buf(noSeq), 'bad-seq');
    const { timestamp_ms, ...noTs } = VALID;
    reject(buf(noTs), 'bad-timestamp');
    const { yaw_deg, ...noYaw } = VALID;
    reject(buf(noYaw), 'bad-angles');
    const { tracking_enabled, ...noTrack } = VALID;
    reject(buf(noTrack), 'bad-tracking-enabled');
  });

  it('seq/timestamp must be non-negative integers; booleans are not ints', () => {
    reject(buf({ ...VALID, seq: -1 }), 'bad-seq');
    reject(buf({ ...VALID, seq: 1.5 }), 'bad-seq');
    reject(buf({ ...VALID, seq: true }), 'bad-seq');
    reject(buf({ ...VALID, timestamp_ms: -5 }), 'bad-timestamp');
    reject(buf({ ...VALID, timestamp_ms: 1.2 }), 'bad-timestamp');
  });

  it('angles: non-numeric or non-finite rejected', () => {
    reject(buf({ ...VALID, yaw_deg: '12' }), 'bad-angles');
    // JSON cannot carry NaN/Infinity; the object path guards direct injection.
    reject({ ...VALID, pitch_deg: NaN }, 'bad-angles');
    reject({ ...VALID, roll_deg: Infinity }, 'bad-angles');
  });

  it('angles outside schema range rejected (yaw ±360, pitch/roll ±180)', () => {
    reject(buf({ ...VALID, yaw_deg: 361 }), 'out-of-range');
    reject(buf({ ...VALID, pitch_deg: -180.5 }), 'out-of-range');
    reject(buf({ ...VALID, roll_deg: 181 }), 'out-of-range');
  });

  it('tracking_enabled / centered / calibrated must be booleans', () => {
    reject(buf({ ...VALID, tracking_enabled: 1 }), 'bad-tracking-enabled');
    reject(buf({ ...VALID, centered: 'yes' }), 'bad-centered');
    reject(buf({ ...VALID, calibrated: 0 }), 'bad-calibrated');
  });

  it('timeout_ms out of 1..5000 or non-integer rejected', () => {
    reject(buf({ ...VALID, timeout_ms: 0 }), 'bad-timeout');
    reject(buf({ ...VALID, timeout_ms: 5001 }), 'bad-timeout');
    reject(buf({ ...VALID, timeout_ms: 2.5 }), 'bad-timeout');
  });

  it('oversized datagram rejected before parsing', () => {
    const big = Buffer.alloc(MAX_PACKET_BYTES + 1, 0x20);
    reject(big, 'oversized');
  });
});

describe('HeadTrackingMonitor — diagnostic states (contract state table)', () => {
  it('idle until the first valid packet; invalid packets alone -> invalid', () => {
    const m = new HeadTrackingMonitor();
    expect(m.state(0)).toBe('idle');
    m.ingest(Buffer.from('garbage'), 10);
    expect(m.state(10)).toBe('invalid');
  });

  it('fresh + enabled + centered -> active_log_only', () => {
    const m = new HeadTrackingMonitor();
    const r = m.ingest(buf(VALID), 1000);
    expect(r.accepted).toBe(true);
    expect(m.state(1000)).toBe('active_log_only');
  });

  it('tracking_enabled=false -> inactive (logged, never processed as control)', () => {
    const m = new HeadTrackingMonitor();
    m.ingest(buf({ ...VALID, tracking_enabled: false }), 1000);
    expect(m.state(1000)).toBe('inactive');
  });

  it('uncentered -> not_centered (also when centered is absent)', () => {
    const m = new HeadTrackingMonitor();
    m.ingest(buf({ ...VALID, centered: false }), 1000);
    expect(m.state(1000)).toBe('not_centered');
    const { centered, ...noCentered } = VALID;
    m.ingest(buf(noCentered), 1001);
    expect(m.state(1001)).toBe('not_centered');
  });

  it('calibrated=false -> not_centered (conservative gating on the optional field)', () => {
    const m = new HeadTrackingMonitor();
    m.ingest(buf({ ...VALID, calibrated: false }), 1000);
    expect(m.state(1000)).toBe('not_centered');
  });

  it(`stale after > ${DEFAULT_STALE_MS} ms of silence (receive-time authority)`, () => {
    const m = new HeadTrackingMonitor();
    m.ingest(buf(VALID), 1000);
    expect(m.state(1000 + DEFAULT_STALE_MS)).toBe('active_log_only'); // boundary: not yet stale
    expect(m.state(1000 + DEFAULT_STALE_MS + 1)).toBe('stale');
  });

  it('invalid packets never replace the last valid state', () => {
    const m = new HeadTrackingMonitor();
    m.ingest(buf(VALID), 1000);
    m.ingest(Buffer.from('junk'), 1050);
    m.ingest(buf({ ...VALID, seq: true }), 1060);
    expect(m.state(1100)).toBe('active_log_only'); // still fresh + valid
    const d = m.diagnostics(1100);
    expect(d.lastValid.seq).toBe(7); // preserved
    expect(d.counts.invalid).toBe(2);
    expect(d.invalidByReason['malformed-json']).toBe(1);
    expect(d.invalidByReason['bad-seq']).toBe(1);
  });

  it('sequence diagnostics: gaps, regressions, repeats are counted, not fatal', () => {
    const m = new HeadTrackingMonitor();
    m.ingest(buf({ ...VALID, seq: 1 }), 0);
    m.ingest(buf({ ...VALID, seq: 2 }), 10);   // consecutive: fine
    m.ingest(buf({ ...VALID, seq: 5 }), 20);   // gap
    m.ingest(buf({ ...VALID, seq: 5 }), 30);   // repeat
    m.ingest(buf({ ...VALID, seq: 1 }), 40);   // regression (app restart)
    const d = m.diagnostics(50);
    expect(d.seqGaps).toBe(1);
    expect(d.seqRepeats).toBe(1);
    expect(d.seqRegressions).toBe(1);
    expect(d.counts.valid).toBe(5); // all still accepted for logging
    expect(m.state(50)).toBe('active_log_only');
  });

  it('diagnostics expose packet age, sender clock delta, and ~1s rate', () => {
    const m = new HeadTrackingMonitor();
    m.ingest(buf({ ...VALID, timestamp_ms: 900 }), 1000);
    m.ingest(buf({ ...VALID, seq: 8, timestamp_ms: 950 }), 1050);
    const d = m.diagnostics(1100);
    expect(d.packetAgeMs).toBe(50);
    expect(d.senderClockDeltaMs).toBe(100); // rx 1050 - sender 950
    expect(d.ratePerSec).toBe(2);
    expect(d.lastValid.timeout_ms).toBeNull();
  });
});

describe('headTrackingConfigFromEnv — disabled by default', () => {
  it('returns null unless W17_HEADTRACK=1 (no socket, app unchanged)', () => {
    expect(headTrackingConfigFromEnv({})).toBeNull();
    expect(headTrackingConfigFromEnv({ W17_HEADTRACK: '0' })).toBeNull();
  });

  it('default port is 5602 per the iPhone contract', () => {
    expect(DEFAULT_PORT).toBe(5602);
    expect(headTrackingConfigFromEnv({ W17_HEADTRACK: '1' }))
      .toEqual({ port: 5602, bindHost: '0.0.0.0', staleMs: 300 });
  });

  it('honors overrides and clamps stale-ms to 1..5000', () => {
    expect(headTrackingConfigFromEnv({
      W17_HEADTRACK: '1', W17_HEADTRACK_PORT: '6000', W17_HEADTRACK_BIND: '127.0.0.1', W17_HEADTRACK_STALE_MS: '9999',
    })).toEqual({ port: 6000, bindHost: '127.0.0.1', staleMs: 5000 });
  });
});

describe('HeadTrackingReceiver — log-only lifecycle', () => {
  function harness({ staleMs = 300 } = {}) {
    let now = 1_000_000;
    const logs = [];
    let messageHandler = null;
    const socket = {
      on: (ev, fn) => { if (ev === 'message') messageHandler = fn; },
      bind: vi.fn(),
      close: vi.fn(),
    };
    const ticks = [];
    const rx = new HeadTrackingReceiver({
      port: 5602,
      staleMs,
      clock: () => now,
      socketFactory: () => socket,
      schedule: (fn) => { ticks.push(fn); return ticks.length - 1; },
      cancel: (h) => { ticks[h] = null; },
      log: (m) => logs.push(m),
    });
    return {
      rx, logs, socket,
      packet: (obj) => messageHandler(buf(obj), { address: '10.0.0.7', port: 5602 }),
      rawPacket: (b) => messageHandler(b, { address: '10.0.0.7', port: 5602 }),
      tick: () => ticks.forEach((f) => f && f()),
      advance: (ms) => { now += ms; },
    };
  }

  it('disabled before start; binds and goes idle on start', () => {
    const h = harness();
    expect(h.rx.state()).toBe('disabled');
    h.rx.start();
    expect(h.socket.bind).toHaveBeenCalledWith(5602, '0.0.0.0');
    expect(h.rx.state()).toBe('idle');
    expect(h.logs.some((l) => l.includes('LOG-ONLY'))).toBe(true);
  });

  it('valid packet -> active_log_only; state transition is logged', () => {
    const h = harness();
    h.rx.start();
    h.packet(VALID);
    expect(h.rx.state()).toBe('active_log_only');
    expect(h.logs.some((l) => l.includes('idle -> active_log_only'))).toBe(true);
  });

  it('silence past staleMs -> stale announced by the status tick', () => {
    const h = harness();
    h.rx.start();
    h.packet(VALID);
    h.advance(301);
    h.tick();
    expect(h.rx.state()).toBe('stale');
    expect(h.logs.some((l) => l.includes('active_log_only -> stale'))).toBe(true);
  });

  it('invalid packets are logged with reason and flood-capped', () => {
    const h = harness();
    h.rx.start();
    for (let i = 0; i < 20; i++) h.rawPacket(Buffer.from('garbage'));
    const rejects = h.logs.filter((l) => l.includes('rejected packet: malformed-json'));
    expect(rejects.length).toBeGreaterThan(0);
    expect(rejects.length).toBeLessThanOrEqual(5); // MAX_INVALID_LOGS_PER_WINDOW
    expect(h.rx.getDiagnostics().counts.invalid).toBe(20); // all still counted
  });

  it('stop() closes the socket and returns to disabled', () => {
    const h = harness();
    h.rx.start();
    h.rx.stop();
    expect(h.socket.close).toHaveBeenCalled();
    expect(h.rx.state()).toBe('disabled');
  });

  it('LOG-ONLY GUARD: public surface is start/stop/state/getDiagnostics — no emitter, no control hooks', () => {
    const h = harness();
    const publicApi = Object.getOwnPropertyNames(Object.getPrototypeOf(h.rx))
      .filter((n) => n !== 'constructor' && !n.startsWith('_'));
    expect(publicApi.sort()).toEqual(['getDiagnostics', 'start', 'state', 'stop']);
  });

  it('LOG-ONLY GUARD: accepted packets produce logs + diagnostics and NOTHING else', () => {
    const h = harness();
    h.rx.start();
    const logCountBefore = h.logs.length;
    h.packet(VALID);                       // accepted, enabled, centered
    h.packet({ ...VALID, seq: 8, yaw_deg: 45 }); // full head deflection
    // Only observable effects: log lines and the read-only snapshot.
    expect(h.logs.length).toBeGreaterThanOrEqual(logCountBefore);
    const d = h.rx.getDiagnostics();
    expect(d.counts.valid).toBe(2);
    expect(d.state).toBe('active_log_only'); // "log only" is in the state NAME
  });
});
