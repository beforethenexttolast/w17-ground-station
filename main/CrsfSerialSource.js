// TelemetrySource that reads a CRSF serial stream (the FT232/TX-module port,
// or a com0com virtual port) and emits battery + link-quality telemetry.
//
// serialport is a native module; it's required only here, in the main
// process. The parsing (assembler + mapper) is the pure, unit-tested
// shared/ code -- this file is just the thin I/O wrapper + reconnect, so the
// hardware-touching surface stays minimal (mirrors the repo's HAL-seam style).
//
// See docs/TELEMETRY.md for how the data reaches this port (the FT232 port is
// held exclusively by elrs-joystick-control -- use its telemetry forward, or
// a com0com/hub4com splitter, and point W17_TELEMETRY_PORT at the reader end).

const { TelemetrySource } = require('../shared/telemetry.js');
const { CrsfAssembler } = require('../shared/crsfAssembler.js');
const { frameToTelemetry } = require('../shared/crsfTelemetry.js');

class CrsfSerialSource extends TelemetrySource {
  // path: COM port (e.g. 'COM5' / '/dev/tty.usbserial-*'); baud: 420000 CRSF.
  constructor({ path, baud = 420000, log = () => {} } = {}) {
    super();
    this._path = path;
    this._baud = baud;
    this._log = log;
    this._asm = new CrsfAssembler();
    this._port = null;
    this._reopenTimer = null;
    this._stopped = false;
  }

  start() {
    this._open();
  }

  stop() {
    this._stopped = true;
    if (this._reopenTimer) clearTimeout(this._reopenTimer);
    if (this._port && this._port.isOpen) this._port.close(() => {});
    this._port = null;
  }

  _scheduleReopen() {
    if (this._stopped || this._reopenTimer) return;
    this._reopenTimer = setTimeout(() => {
      this._reopenTimer = null;
      this._open();
    }, 2000);
  }

  _open() {
    if (this._stopped) return;
    let SerialPort;
    try {
      // Lazy require so the app still runs (HUD gamepad-only) if the native
      // module isn't rebuilt/installed on this machine.
      ({ SerialPort } = require('serialport'));
    } catch (err) {
      this._log(`[telem] serialport unavailable (${err.message}); telemetry disabled`);
      return;
    }
    try {
      this._port = new SerialPort({ path: this._path, baudRate: this._baud });
    } catch (err) {
      this._log(`[telem] open ${this._path} failed (${err.message}); retrying`);
      this._scheduleReopen();
      return;
    }
    this._port.on('open', () => this._log(`[telem] CRSF serial open: ${this._path}`));
    this._port.on('error', (err) => {
      this._log(`[telem] serial error (${err.message})`);
      this._scheduleReopen();
    });
    this._port.on('close', () => this._scheduleReopen());
    this._port.on('data', (buf) => this._onBytes(buf));
  }

  _onBytes(buf) {
    for (const b of buf) {
      const frame = this._asm.feedByte(b);
      if (frame) {
        const t = frameToTelemetry(frame);
        if (t) this._emit(t);
      }
    }
  }
}

module.exports = { CrsfSerialSource };
