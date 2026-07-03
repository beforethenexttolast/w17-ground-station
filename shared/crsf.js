// CRSF wire-format decode, ported FAITHFULLY from the firmware
// (w17-control-fw/lib/crsf). This is the one piece of genuine shared-truth
// logic between the repos: the byte layouts and CRC must match exactly, or a
// JS decode of bytes the firmware produced would silently disagree. The
// firmware's golden vectors are reused as tests.
//
// CommonJS: required by the Electron main process (CJS) and by vitest.

const SYNC_BYTE = 0xc8;
const FRAME_TYPE_RC_CHANNELS_PACKED = 0x16;
const FRAME_TYPE_LINK_STATISTICS = 0x14;
const FRAME_TYPE_BATTERY = 0x08;
const CRC8_POLY = 0xd5;

const LINK_STATISTICS_PAYLOAD_LEN = 10;
const BATTERY_PAYLOAD_LEN = 8;

// CRC-8/DVB-S2, poly 0xD5, MSB-first, init 0 -- the exact loop from
// CrsfParser::computeCrc8. Catalog check value for "123456789" is 0xBC.
function computeCrc8(bytes, start = 0, len = bytes.length - start) {
  let crc = 0;
  for (let i = 0; i < len; i++) {
    crc ^= bytes[start + i];
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x80 ? ((crc << 1) ^ CRC8_POLY) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

// int8 from a byte (SNR fields are signed on the wire).
function toInt8(b) {
  return b > 127 ? b - 256 : b;
}

// Decodes a LINK_STATISTICS payload (10 bytes). Same field order as the
// firmware CrsfLinkStatistics struct. uplinkLinkQuality (offset 2) is the
// failsafe-relevant field: ELRS forces it to 0 on link loss.
function decodeLinkStatistics(payload) {
  if (payload.length < LINK_STATISTICS_PAYLOAD_LEN) {
    throw new Error('link statistics payload too short');
  }
  return {
    uplinkRssiAnt1: payload[0],
    uplinkRssiAnt2: payload[1],
    uplinkLinkQuality: payload[2],
    uplinkSnr: toInt8(payload[3]),
    activeAntenna: payload[4],
    rfMode: payload[5],
    uplinkTxPower: payload[6],
    downlinkRssi: payload[7],
    downlinkLinkQuality: payload[8],
    downlinkSnr: toInt8(payload[9]),
  };
}

// Decodes the standard CRSF battery-sensor payload (8 bytes):
//   voltage  uint16 BE, decivolts (0.1 V)
//   current  uint16 BE, deciamps (0.1 A)
//   capacity uint24 BE, mAh used
//   percent  uint8, remaining %
function decodeBattery(payload) {
  if (payload.length < BATTERY_PAYLOAD_LEN) {
    throw new Error('battery payload too short');
  }
  return {
    voltageV: ((payload[0] << 8) | payload[1]) / 10,
    currentA: ((payload[2] << 8) | payload[3]) / 10,
    capacityMah: (payload[4] << 16) | (payload[5] << 8) | payload[6],
    remainingPct: payload[7],
  };
}

// Result codes mirror the firmware DecodeResult.
const DecodeResult = {
  Ok: 'Ok',
  BadSync: 'BadSync',
  BadLength: 'BadLength',
  CrcMismatch: 'CrcMismatch',
};

// Decodes one complete CRSF frame buffer: [sync][length][type][payload...][crc].
// `length` counts type+payload+crc. CRC is over [type + payload]. Returns
// { result, type, payload } — payload is the bytes between type and crc.
function decodeFrame(frame) {
  if (frame.length < 4) return { result: DecodeResult.BadLength };
  if (frame[0] !== SYNC_BYTE) return { result: DecodeResult.BadSync };
  const length = frame[1];
  if (length < 2 || frame.length !== 2 + length) {
    return { result: DecodeResult.BadLength };
  }
  const type = frame[2];
  const payload = frame.slice(3, 2 + length - 1);
  const receivedCrc = frame[2 + length - 1];
  const computed = computeCrc8(frame, 2, length - 1);
  if (computed !== receivedCrc) return { result: DecodeResult.CrcMismatch };
  return { result: DecodeResult.Ok, type, payload };
}

module.exports = {
  SYNC_BYTE,
  FRAME_TYPE_RC_CHANNELS_PACKED,
  FRAME_TYPE_LINK_STATISTICS,
  FRAME_TYPE_BATTERY,
  CRC8_POLY,
  LINK_STATISTICS_PAYLOAD_LEN,
  BATTERY_PAYLOAD_LEN,
  computeCrc8,
  decodeLinkStatistics,
  decodeBattery,
  DecodeResult,
  decodeFrame,
};
