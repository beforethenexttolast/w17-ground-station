import { describe, it, expect } from 'vitest';
import {
  computeCrc8,
  decodeFrame,
  decodeLinkStatistics,
  decodeBattery,
  DecodeResult,
  SYNC_BYTE,
  FRAME_TYPE_LINK_STATISTICS,
  FRAME_TYPE_BATTERY,
} from '../shared/crsf.js';
import { CrsfAssembler } from '../shared/crsfAssembler.js';

// Build a CRSF frame the same way the firmware CrsfFrameBuilder does.
function buildFrame(type, payload) {
  const length = payload.length + 2; // type + payload + crc
  const frame = [SYNC_BYTE, length, type, ...payload, 0];
  frame[frame.length - 1] = computeCrc8(frame, 2, length - 1); // over type+payload
  return Uint8Array.from(frame);
}

describe('computeCrc8', () => {
  it('matches the CRC-8/DVB-S2 catalog check value (firmware test vector)', () => {
    const input = [...'123456789'].map((c) => c.charCodeAt(0));
    expect(computeCrc8(input)).toBe(0xbc);
  });
});

describe('decodeFrame', () => {
  it('round-trips a link statistics frame', () => {
    const payload = [75, 108, 87, 0xf6, 1, 4, 3, 80, 99, 0x05];
    const frame = buildFrame(FRAME_TYPE_LINK_STATISTICS, payload);
    const decoded = decodeFrame(frame);
    expect(decoded.result).toBe(DecodeResult.Ok);
    expect(decoded.type).toBe(FRAME_TYPE_LINK_STATISTICS);
    const stats = decodeLinkStatistics(decoded.payload);
    expect(stats.uplinkLinkQuality).toBe(87);
    expect(stats.uplinkSnr).toBe(-10); // 0xF6 signed
    expect(stats.downlinkSnr).toBe(5);
  });

  it('rejects a bad sync byte', () => {
    const frame = buildFrame(FRAME_TYPE_BATTERY, [0, 0, 0, 0, 0, 0, 0, 0]);
    frame[0] = 0x00;
    expect(decodeFrame(frame).result).toBe(DecodeResult.BadSync);
  });

  it('rejects a corrupted CRC', () => {
    const frame = buildFrame(FRAME_TYPE_BATTERY, [0, 0, 0, 0, 0, 0, 0, 0]);
    frame[frame.length - 1] ^= 0xff;
    expect(decodeFrame(frame).result).toBe(DecodeResult.CrcMismatch);
  });

  it('rejects a length/buffer mismatch', () => {
    const frame = buildFrame(FRAME_TYPE_BATTERY, [0, 0, 0, 0, 0, 0, 0, 0]);
    expect(decodeFrame(frame.slice(0, frame.length - 1)).result).toBe(DecodeResult.BadLength);
  });
});

describe('decodeBattery', () => {
  it('decodes voltage/current/capacity/percent (BE)', () => {
    // 7.9V = 79 decivolts = 0x004F; 2.0A = 20 = 0x0014; 1234 mAh = 0x0004D2; 55%
    const payload = [0x00, 0x4f, 0x00, 0x14, 0x00, 0x04, 0xd2, 55];
    const b = decodeBattery(payload);
    expect(b.voltageV).toBeCloseTo(7.9, 5);
    expect(b.currentA).toBeCloseTo(2.0, 5);
    expect(b.capacityMah).toBe(1234);
    expect(b.remainingPct).toBe(55);
  });
});

describe('CrsfAssembler', () => {
  it('assembles a frame fed byte-by-byte', () => {
    const payload = [75, 108, 0, 0, 1, 4, 3, 80, 99, 0];
    const frame = buildFrame(FRAME_TYPE_LINK_STATISTICS, payload);
    const asm = new CrsfAssembler();
    let out = null;
    for (const b of frame) out = asm.feedByte(b) ?? out;
    expect(out).not.toBeNull();
    expect(out.type).toBe(FRAME_TYPE_LINK_STATISTICS);
    expect(decodeLinkStatistics(out.payload).uplinkLinkQuality).toBe(0);
  });

  it('ignores noise and resyncs after a corrupt frame', () => {
    const good = buildFrame(FRAME_TYPE_BATTERY, [0x00, 0x4f, 0, 0, 0, 0, 0, 60]);
    const corrupt = Uint8Array.from(good);
    corrupt[corrupt.length - 1] ^= 0xff;
    const asm = new CrsfAssembler();
    for (const b of [0x00, 0xff, 0x11]) expect(asm.feedByte(b)).toBeNull(); // noise
    for (const b of corrupt) asm.feedByte(b); // corrupt frame: no emit
    let out = null;
    for (const b of good) out = asm.feedByte(b) ?? out;
    expect(out).not.toBeNull();
    expect(decodeBattery(out.payload).remainingPct).toBe(60);
  });
});
