// SUBSCRIBER-ONLY consumer of the mapper's read-only RF link-state stream
// (review SYN-2). MAIN-process only.
//
// WHY: race day starting the drive program is not the same event as the car
// being drivable. The mapper can be running with its transmitter port closed —
// no CRSF frame ever leaves the PC — and the card said "running" regardless, so
// the one thing the giftee is told about the drive program could be false at
// exactly the moment it matters. This client reads the mapper's OWN answer to
// "am I transmitting?" and hands it to the orchestrator.
//
// Read-only by construction, the same way MapperTelemetrySource and
// HeadIntentDiagnosticsClient are: the transport is INJECTED as `connect`, the
// only things done to the call are `.on(...)` and `.cancel()`, and it binds no
// socket. main/mapperLinkGrpcConnect.js supplies the real transport and binds
// exactly getLinkStream.
//
// It reports THREE states, not two, because "not up" and "we do not know" are
// different things to tell an operator: `up` is true / false / null (no answer
// yet, or the stream is down). The orchestrator treats null as not-yet-up while
// it waits, and says so rather than blaming the radio.

const { linkIsUp } = require('../shared/mapperTelemetry.js');

const GRPC_CANCELLED = 1;
const GRPC_UNAVAILABLE = 14;

const DEFAULT_BACKOFF = Object.freeze({ baseMs: 500, factorMax: 5_000 });

class MapperLinkStateClient {
    constructor({
        connect,
        log = () => {},
        schedule = (fn, ms) => setTimeout(fn, ms),
        cancelTimer = (h) => clearTimeout(h),
        backoff = DEFAULT_BACKOFF,
    } = {}) {
        if (typeof connect !== 'function') {
            throw new TypeError('MapperLinkStateClient requires a connect() function');
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
        this._up = null;        // true | false | null (unknown)
        this._state = null;     // the mapper's last LinkState, verbatim
        this._listeners = new Set();
    }

    onChange(listener) {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    // { up, supervisorState, portState } — display/decision truth only. `up` is
    // null until the mapper has answered.
    snapshot() {
        return {
            up: this._up,
            supervisorState: this._state ? this._state.supervisor_state : null,
            portState: this._state ? this._state.port_state : null,
        };
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
            this._log(`[link] mapper link stream connect failed: ${err && err.message ? err.message : err}`);
            this._onClosed();
            return;
        }
        this._call = call;
        call.on('data', (msg) => this._onData(msg));
        call.on('error', (err) => this._onError(err));
        call.on('end', () => this._onEnd());
    }

    _onData(msg) {
        this._attempt = 0;
        this._state = msg || null;
        const next = linkIsUp(msg);
        if (next === this._up) return; // no change, no noise
        this._up = next;
        this._emit();
    }

    _onError(err) {
        if (this._settled) return;
        this._settled = true;
        const code = err && typeof err.code === 'number' ? err.code : null;
        if (!this._running || code === GRPC_CANCELLED) return;
        if (code !== GRPC_UNAVAILABLE) {
            const detail = (err && err.details) || (err && err.message) || '';
            this._log(`[link] mapper link stream error${code === null ? '' : ` (code ${code})`}: ${detail}`);
        }
        this._onClosed();
    }

    _onEnd() {
        if (this._settled) return;
        this._settled = true;
        if (!this._running) return;
        this._onClosed();
    }

    // The stream is gone, so the last answer is stale: report UNKNOWN rather
    // than keeping the previous claim. A dropped stream is not evidence that
    // the link went down, and it is certainly not evidence that it is still up.
    _onClosed() {
        this._call = null;
        this._state = null;
        if (this._up !== null) {
            this._up = null;
            this._emit();
        }
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

    _emit() {
        const snap = this.snapshot();
        for (const listener of this._listeners) {
            try {
                listener(snap);
            } catch (err) {
                this._log(`[link] state listener failed: ${err && err.message ? err.message : err}`);
            }
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
        this._state = null;
        if (this._up !== null) {
            this._up = null;
            this._emit();
        }
    }
}

module.exports = { MapperLinkStateClient, DEFAULT_BACKOFF };
