// Byte-stream CRSF frame assembler, mirroring the firmware CrsfFrameAssembler:
// find sync, read length, buffer the rest, decode, resync on any failure.
// For the serial telemetry path (if that route is chosen); the WiFi/replay
// paths deliver whole telemetry objects and don't need this.

import { SYNC_BYTE, decodeFrame, DecodeResult } from './crsf.js';

const MAX_FRAME_LEN = 64; // CRSF caps a frame at 64 bytes on the wire

export class CrsfAssembler {
  constructor() {
    this._buf = [];
    this._expected = 0; // total frame length once known
  }

  // Feed one byte. Returns a decoded frame object ({type, payload}) when a
  // complete CRC-valid frame completes, else null. Resyncs on failure.
  feedByte(b) {
    if (this._buf.length === 0) {
      if (b !== SYNC_BYTE) return null;
      this._buf.push(b);
      return null;
    }
    if (this._buf.length === 1) {
      const totalLen = 2 + b;
      if (b < 2 || totalLen > MAX_FRAME_LEN) {
        this._buf = []; // bad length: resync immediately
        return null;
      }
      this._buf.push(b);
      this._expected = totalLen;
      return null;
    }
    this._buf.push(b);
    if (this._buf.length < this._expected) return null;

    const frame = Uint8Array.from(this._buf);
    this._buf = [];
    this._expected = 0;
    const decoded = decodeFrame(frame);
    return decoded.result === DecodeResult.Ok ? decoded : null;
  }
}
