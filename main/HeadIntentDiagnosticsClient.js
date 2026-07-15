// SUBSCRIBER-ONLY consumer of the mapper's read-only head-intent diagnostics
// stream (WatchHeadIntentDiagnostics; CB8 slice 3B). Runs in the Electron MAIN
// process only. Its ONLY outputs are:
//   * a one-way main -> renderer push (the injected `broadcast`), carrying the
//     mapper's authoritative snapshot + a connection-state label for display, and
//   * log lines.
// It is DISPLAY-ONLY by construction:
//   * It NEVER writes to the mapper. The only things it does to the gRPC call
//     are `.on(...)` (read the server stream) and `.cancel()` (stop listening).
//     There is no setter, no ack, no config, no arm/disarm — nothing flows back.
//   * It does NOT recompute freshness or reinterpret receive_age_ms, and it does
//     NOT run a second head-intent state machine. The mapper is authoritative;
//     this module forwards the mapper's fields verbatim to the renderer.
//   * It binds NO socket (it is a gRPC client, not the 5602 receiver). Under
//     topology (a) the mapper owns UDP 5602; this consumer only reads gRPC.
//
// Thin wrapper style (repo HAL-seam convention): the gRPC transport is injected
// as `connect` (a zero-arg function returning a server-streaming call with
// `.on(event, cb)` + `.cancel()`), so reconnect/backoff/state-mapping unit-test
// with a fake call and no real grpc / no live mapper. main/headIntentGrpcConnect.js
// supplies the real @grpc/grpc-js call; main.js is the only construction site.

// Stable gRPC status codes (grpc.status). Kept as literals so this core needs no
// @grpc/grpc-js dependency and stays fully unit-testable.
const GRPC_CANCELLED = 1;
const GRPC_RESOURCE_EXHAUSTED = 8;
const GRPC_UNAVAILABLE = 14;

// Bounded exponential backoff for reconnect. A mapper restart, a disabled
// ingest, the 4-stream cap, or a slow network must never wedge the app or the
// launcher — we just keep retrying on a capped schedule.
const DEFAULT_BACKOFF = Object.freeze({ baseMs: 500, factorMax: 10_000 });

// Connection-state labels pushed to the renderer for display. These describe the
// TRANSPORT to the mapper; the head-intent STATE itself rides in `diagnostics`.
const CONN = Object.freeze({
    connecting: 'connecting',   // opening / waiting for the first snapshot
    live: 'live',               // receiving snapshots
    unavailable: 'unavailable', // mapper down or ingest disabled (gRPC UNAVAILABLE)
    exhausted: 'exhausted',     // mapper's 4-stream cap reached (RESOURCE_EXHAUSTED)
    error: 'stream-error',      // any other stream drop
    stopped: 'stopped',         // consumer intentionally off
});

class HeadIntentDiagnosticsClient {
    constructor({
        connect,
        broadcast = () => {},
        clock = () => Date.now(),
        schedule = (fn, ms) => setTimeout(fn, ms),
        cancel = (h) => clearTimeout(h),
        log = () => {},
        backoff = DEFAULT_BACKOFF,
    } = {}) {
        if (typeof connect !== 'function') {
            throw new TypeError('HeadIntentDiagnosticsClient requires a connect() function');
        }
        this._connect = connect;
        this._broadcast = broadcast;
        this._clock = clock;
        this._schedule = schedule;
        this._cancel = cancel;
        this._log = log;
        this._backoff = backoff;

        this._running = false;
        this._call = null;           // the current server-streaming call, or null
        this._reconnectTimer = null; // at most one pending reconnect
        this._attempt = 0;           // consecutive failed opens; reset on first data
        this._settled = false;       // guards error+end from double-scheduling one cycle
        this._conn = CONN.stopped;
    }

    start() {
        if (this._running) return;
        this._running = true;
        this._attempt = 0;
        this._open();
    }

    _open() {
        this._settled = false;
        this._setConn(CONN.connecting);
        let call;
        try {
            call = this._connect();
        } catch (err) {
            // A synchronous connect failure is just another dropped attempt.
            this._log(`[headintent] connect failed: ${err && err.message ? err.message : err}`);
            this._onClosed(CONN.unavailable);
            return;
        }
        this._call = call;
        // The ONLY interactions with the call are reads (.on) and .cancel().
        call.on('data', (msg) => this._onData(msg));
        call.on('error', (err) => this._onError(err));
        call.on('end', () => this._onEnd());
    }

    _onData(msg) {
        this._attempt = 0; // healthy stream; reset backoff
        // Forward the mapper's authoritative snapshot verbatim (display-only).
        this._setConn(CONN.live, msg || null);
    }

    _onError(err) {
        if (this._settled) return;
        this._settled = true;
        const code = err && typeof err.code === 'number' ? err.code : null;
        // Our own cancel() during stop() surfaces as CANCELLED — not a fault.
        if (!this._running || code === GRPC_CANCELLED) {
            return;
        }
        let conn = CONN.error;
        if (code === GRPC_UNAVAILABLE) conn = CONN.unavailable;
        else if (code === GRPC_RESOURCE_EXHAUSTED) conn = CONN.exhausted;
        const detail = err && err.details ? err.details : (err && err.message) || '';
        this._log(`[headintent] stream error (${conn}${code === null ? '' : `, code ${code}`}): ${detail}`);
        this._onClosed(conn);
    }

    _onEnd() {
        if (this._settled) return;
        this._settled = true;
        if (!this._running) return;
        // A clean server-side close (e.g. mapper shutting the stream): reconnect.
        this._log('[headintent] stream ended by mapper; reconnecting');
        this._onClosed(CONN.error);
    }

    // Common close path: drop the call, surface the state, schedule one reconnect.
    _onClosed(conn) {
        this._call = null;
        this._setConn(conn);
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
        if (this._reconnectTimer !== null) {
            this._cancel(this._reconnectTimer);
            this._reconnectTimer = null;
        }
    }

    // Push the current connection state (+ optional diagnostics) to the renderer.
    // One-way: this is the only data this module emits, and it emits nothing to
    // the mapper. `diagnostics` is the raw mapper snapshot or null.
    _setConn(conn, diagnostics = null) {
        this._conn = conn;
        this._broadcast({ connection: conn, diagnostics, at: this._clock() });
    }

    connectionState() {
        return this._conn;
    }

    stop() {
        if (!this._running && !this._call && this._reconnectTimer === null) return;
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
        this._setConn(CONN.stopped);
    }
}

module.exports = { HeadIntentDiagnosticsClient, CONN, DEFAULT_BACKOFF };
