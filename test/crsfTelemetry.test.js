import { describe, it, expect } from 'vitest';
import {
  computeCrc8,
  SYNC_BYTE,
  FRAME_TYPE_BATTERY,
  FRAME_TYPE_LINK_STATISTICS,
  FRAME_TYPE_GPS,
  FRAME_TYPE_FLIGHT_MODE,
} from '../shared/crsf.js';
import { CrsfAssembler } from '../shared/crsfAssembler.js';
import { frameToTelemetry } from '../shared/crsfTelemetry.js';
import golden from './fixtures/crsf_golden.json';

// Build a CRSF frame like the firmware CrsfFrameBuilder does.
function buildFrame(type, payload) {
  const length = payload.length + 2;
  const frame = [SYNC_BYTE, length, type, ...payload, 0];
  frame[frame.length - 1] = computeCrc8(frame, 2, length - 1);
  return Uint8Array.from(frame);
}

const hexToBytes = (s) => Uint8Array.from(s.trim().split(/\s+/).map((h) => parseInt(h, 16)));

// The exact battery frame the firmware emits for 7.9V, 72% (matches the
// control repo's test_build_battery_frame_bytes golden vector).
function batteryFrame(deciVolt, pct) {
  return buildFrame(FRAME_TYPE_BATTERY, [
    (deciVolt >> 8) & 0xff, deciVolt & 0xff, // voltage BE
    0, 0, // current
    0, 0, 0, // capacity u24
    pct,
  ]);
}

describe('frameToTelemetry', () => {
  it('maps a battery frame to batteryV/batteryPct', () => {
    const t = frameToTelemetry({ type: FRAME_TYPE_BATTERY, payload: batteryFrame(79, 72).slice(3, 11) });
    expect(t.batteryV).toBeCloseTo(7.9, 5);
    expect(t.batteryPct).toBe(72);
  });

  it('maps a link statistics frame to linkQualityPct', () => {
    const payload = [70, 65, 88, 0, 1, 4, 3, 80, 99, 0]; // uplinkLQ at offset 2 = 88
    const t = frameToTelemetry({ type: FRAME_TYPE_LINK_STATISTICS, payload });
    expect(t.linkQualityPct).toBe(88);
  });

  it('maps a GPS frame to real speedKmh (groundspeed / 10)', () => {
    // groundspeed field (payload offset 8-9) = 361 = 36.1 km/h; altitude baseline 1000.
    const payload = [0, 0, 0, 0, 0, 0, 0, 0, 0x01, 0x69, 0, 0, 0x03, 0xe8, 0];
    const t = frameToTelemetry({ type: FRAME_TYPE_GPS, payload });
    expect(t.speedKmh).toBeCloseTo(36.1, 5);
  });

  it('maps a flightmode status string to gear/driveMode/ersPct', () => {
    const payload = [...'G3 M2 E55'].map((c) => c.charCodeAt(0)).concat(0);
    const t = frameToTelemetry({ type: FRAME_TYPE_FLIGHT_MODE, payload });
    expect(t).toEqual({ gear: 3, driveMode: 2, ersPct: 55 });
  });

  it('returns null for unmapped types (HUD keeps simulating)', () => {
    expect(frameToTelemetry({ type: 0x2b, payload: [] })).toBeNull();
    expect(frameToTelemetry(null)).toBeNull();
  });
});

describe('end-to-end: assembler + mapper (the CrsfSerialSource pipeline)', () => {
  it('parses a battery frame fed byte-by-byte from a mixed stream', () => {
    const battery = batteryFrame(83, 95); // 8.3V, 95%
    const asm = new CrsfAssembler();
    let telem = null;
    // Prepend non-sync noise to prove the assembler ignores it, then the frame.
    for (const b of [0x00, 0xff, 0x11]) asm.feedByte(b);
    for (const b of battery) {
      const frame = asm.feedByte(b);
      if (frame) telem = frameToTelemetry(frame);
    }
    expect(telem).not.toBeNull();
    expect(telem.batteryV).toBeCloseTo(8.3, 5);
    expect(telem.batteryPct).toBe(95);
  });
});

// The shared golden fixture, fed byte-by-byte through the real assembler +
// mapper (the CrsfSerialSource path), proving the firmware's exact on-wire
// bytes map to the expected HUD telemetry (audit R07).
describe('golden fixture -> frameToTelemetry (end to end)', () => {
  const feed = (hex) => {
    const asm = new CrsfAssembler();
    let frame = null;
    for (const b of hexToBytes(hex)) frame = asm.feedByte(b) ?? frame;
    return frame;
  };

  it('battery -> batteryV/batteryPct', () => {
    const t = frameToTelemetry(feed(golden.battery.frame));
    expect(t.batteryV).toBeCloseTo(golden.battery.expect.voltageV, 5);
    expect(t.batteryPct).toBe(golden.battery.expect.remainingPct);
  });

  it('gps -> speedKmh', () => {
    const t = frameToTelemetry(feed(golden.gps.frame));
    expect(t.speedKmh).toBeCloseTo(golden.gps.expect.speedKmh, 5);
  });

  it('flightmode -> gear/driveMode/ersPct', () => {
    const t = frameToTelemetry(feed(golden.flightmode.frame));
    expect(t).toEqual(golden.flightmode.expect);
  });

  it('link statistics -> linkQualityPct', () => {
    const t = frameToTelemetry(feed(golden.linkStatistics.frame));
    expect(t.linkQualityPct).toBe(golden.linkStatistics.expect.uplinkLinkQuality);
  });
});
