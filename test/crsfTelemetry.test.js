import { describe, it, expect } from 'vitest';
import { computeCrc8, SYNC_BYTE, FRAME_TYPE_BATTERY, FRAME_TYPE_LINK_STATISTICS } from '../shared/crsf.js';
import { CrsfAssembler } from '../shared/crsfAssembler.js';
import { frameToTelemetry } from '../shared/crsfTelemetry.js';

// Build a CRSF frame like the firmware CrsfFrameBuilder does.
function buildFrame(type, payload) {
  const length = payload.length + 2;
  const frame = [SYNC_BYTE, length, type, ...payload, 0];
  frame[frame.length - 1] = computeCrc8(frame, 2, length - 1);
  return Uint8Array.from(frame);
}

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

  it('returns null for unmapped types (HUD keeps simulating)', () => {
    expect(frameToTelemetry({ type: 0x16, payload: [] })).toBeNull();
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
