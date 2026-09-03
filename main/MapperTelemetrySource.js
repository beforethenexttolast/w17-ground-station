// TelemetrySource over the mapper's READ-ONLY telemetry stream (owner decision
// OD-4). MAIN-process only.
//
// WHY: on the gift kit no screen could tell Lola the battery is low. The
// shipped telemetry source is 'none'; 'crsf-serial' needs the FT232 port the
// drive program holds exclusively while it drives the car. The mapper already
// decodes those frames and publishes them on a server stream, so this reads
// them from there and feeds the EXISTING snapshot path — the HUD's BATT field,
// the low-battery banner, and the send-only phone bridge all light up with no
// new plumbing beyond this file.
//
// It is READ-ONLY BY CONSTRUCTION, the same way HeadIntentDiagnosticsClient is:
//   * The transport is INJECTED as `connect` (a zero-arg function returning a
//     server-streaming call with .on(event, cb) + .cancel()), so this file
//     names no RPC at all and unit-tests with a fake call and no live mapper.
//     main/mapperTelemetryGrpcConnect.js supplies the real one and binds
//     exactly getTelemetryStream.
//   * The ONLY things done to the call are `.on(...)` (read) and `.cancel()`
//     (stop listening). There is no setter, no ack, no config — nothing flows
//     back to the mapper, which is what makes a stream subscription a viewer
//     consumer rather than "sending the mapper something".
//   * It binds no socket and opens no port.
//
// MERGE, don't replace. The car's truths arrive in separate messages (battery,
// GPS-speed, flight-mode) and the renderer replaces its telemetry object
// wholesale on each push, so a running merged snapshot is kept here and the
// merge is emitted — exactly what main/CrsfSerialSource.js does for the serial
// path, for exactly the same reason.

const { TelemetrySource } = require('../shared/telemetry.js');
const { mapperFrameToTelemetry } = require('../shared/mapperTelemetry.js');

// Stable gRPC status codes (grpc.status), kept as literals so this file needs
// no grpc dependency and stays fully unit-testable.
const GRPC_CANCELLED = 1;
const GRPC_UNAVAILABLE = 14;

// Bounded exponential backoff. The mapper is not running before race day
// presses the button, and it may restart; a dead stream must never wedge the
// app or spin, it just keeps retrying on a capped schedule.
const DEFAULT_BACKOFF = Object.freeze({ baseMs: 500, factorMax: 10_000 });

class MapperTelemetrySource extends TelemetrySource {
    constructor({
        connect,
        log = () => {},
        schedule = (fn, ms) => setTimeout(fn, ms),
        cancelTimer = (h) => clearTimeout(h),
        backoff = DEFAULT_BACKOFF,
    } = {}) {
        super();
        if (typeof connect !== 'function') {
            throw new TypeError('MapperTelemetrySource requires a connect() function');
        }
        this._connect = connect;
        this._log = log;
        this._schedule = schedule;
        this._cancelTimer = cancelTimer;
        this._backoff = backoff;

        this._running = false;
        this._call = null;
        this._reconnectTimer = null;
        this._attempt = 0;
        this._settled = false;
        this._telem = {}; // running merged snapshot (see header)
    }

    start() {
        if (this._running) return;
        this._running = true;
        this._attempt = 0;
        this._open();
    }

    _open() {
        this._settled = false;
        let call;
        try {
            call = this._connect();
        } catch (err) {
            this._log(`[telem] mapper stream connect failed: ${err && err.message ? err.message : err}`);
            this._onClosed();
            return;
        }
        this._call = call;
        // Reads only.
        call.on('data', (msg) => this._onData(msg));
        call.on('error', (err) => this._onError(err));
        call.on('end', () => this._onEnd());
    }

    _onData(msg) {
        this._attempt = 0; // healthy stream; reset backoff
        let partial;
        try {
            partial = mapperFrameToTelemetry(msg);
        } catch (err) {
            // A malformed message must never take the app down or kill the
            // stream: skip it and keep listening.
            this._log(`[telem] unreadable mapper telemetry message (ignored): ${err && err.message ? err.message : err}`);
            return;
        }
        if (!partial) return; // a payload this viewer does not map
        this._telem = { ...this._telem, ...partial };
        this._emit(this._telem);
    }

    _onError(err) {
        if (this._settled) return;
        this._settled = true;
        const code = err && typeof err.code === 'number' ? err.code : null;
        // Our own cancel() during stop() surfaces as CANCELLED — not a fault.
        if (!this._running || code === GRPC_CANCELLED) return;
        // UNAVAILABLE is the ordinary "the drive program is not up yet" case and
        // is not worth a log line every 10 s; anything else is.
        if (code !== GRPC_UNAVAILABLE) {
            const detail = (err && err.details) || (err && err.message) || '';
            this._log(`[telem] mapper telemetry stream error${code === null ? '' : ` (code ${code})`}: ${detail}`);
        }
        this._onClosed();
    }

    _onEnd() {
        if (this._settled) return;
        this._settled = true;
        if (!this._running) return;
        this._onClosed();
    }

    _onClosed() {
        this._call = null;
        if (!this._running) return;
        this._attempt += 1;
        const delay = Math.min(
            this._backoff.factorMax,
            this._backoff.baseMs * 2 ** (this._attempt - 1),
        );
        this._clearReconnect();
        this._reconnectTimer = this._schedule(() => {
            this._reconnectTimer = null;
            if (this._running) this._open();
        }, delay);
    }

    _clearReconnect() {
        if (this._reconnectTimer !== null && this._reconnectTimer !== undefined) {
            this._cancelTimer(this._reconnectTimer);
            this._reconnectTimer = null;
        }
    }

    stop() {
        this._running = false;
        this._clearReconnect();
        if (this._call) {
            try {
                this._call.cancel();
            } catch {
                /* already closed */
            }
            this._call = null;
        }
        // A fresh session must not inherit the last one's readings.
        this._telem = {};
    }
}

module.exports = { MapperTelemetrySource, DEFAULT_BACKOFF };
