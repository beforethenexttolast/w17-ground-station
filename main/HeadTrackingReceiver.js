// iPhone -> Windows head-tracking UDP receiver (docs/windows_bridge_contract.md
// section 3; default port 5602). LOG-ONLY, first bridge milestone.
//
// This receiver's ONLY outputs are log lines and the read-only getDiagnostics()
// snapshot. It is deliberately a dead end: it does not emit events, does not
// touch the telemetry flow, IPC, the renderer, the outbound iPhone bridge, or
// (nonexistent in this repo) any control path. Disabled/uncentered/invalid/
// stale packets -- and equally ACCEPTED packets -- produce no control output of
// any kind. Mapping head tracking to camera pan/tilt (CRSF ch9/10) is a
// separate, later, safety-gated milestone; see the contract's no-output table.
//
// Thin I/O wrapper over the pure shared/headTracking.js validator+monitor
// (repo HAL-seam style): socket, clock, and timer are injectable for tests.
// Constructed by main.js only when W17_HEADTRACK=1 (off by default).

const dgram = require('node:dgram');
const { HeadTrackingMonitor, DEFAULT_STALE_MS } = require('../shared/headTracking.js');

// Internal status tick: fast enough to announce the ~300 ms stale transition
// promptly; the human-readable rate line prints once per second.
const STATUS_TICK_MS = 100;
const RATE_LINE_EVERY_TICKS = 10;
// Cap invalid-packet warnings per rate-line window so a chatty/broken sender
// cannot flood the console (each is still counted in diagnostics).
const MAX_INVALID_LOGS_PER_WINDOW = 5;

class HeadTrackingReceiver {
    constructor({
        port = 5602,
        bindHost = '0.0.0.0',
        staleMs = DEFAULT_STALE_MS,
        clock = () => Date.now(),
        socketFactory = () => dgram.createSocket('udp4'),
        schedule = (fn, ms) => setInterval(fn, ms),
        cancel = (h) => clearInterval(h),
        log = () => {},
        // TRANSPORT METADATA sink for the setup flow's address suggestion:
        // called with the sender IP STRING of an accepted datagram, and with
        // nothing else — never packet contents, never orientation. This keeps
        // the intent data a dead end while letting main.js pre-fill the W2
        // destination field (user-confirmed). Pinned by noControlPath tests.
        noteRemoteAddr = () => {},
    } = {}) {
        this._port = port;
        this._bindHost = bindHost;
        this._clock = clock;
        this._socketFactory = socketFactory;
        this._schedule = schedule;
        this._cancel = cancel;
        this._log = log;
        this._noteRemoteAddr = noteRemoteAddr;

        this._monitor = new HeadTrackingMonitor({ staleMs });
        this._socket = null;
        this._timer = null;
        this._running = false; // explicit: a timer handle may be falsy (e.g. 0)
        this._fault = false;
        this._lastState = 'disabled';
        this._ticks = 0;
        this._invalidLogsThisWindow = 0;
    }

    start() {
        if (this._running) return;
        try {
            this._socket = this._socketFactory();
            this._socket.on('error', (err) => {
                // Bind/socket failure => fault state; keep running for logs.
                this._fault = true;
                this._log(`[headtrack] socket error: ${err.message}`);
            });
            this._socket.on('message', (buf, rinfo) => this._onMessage(buf, rinfo));
            this._socket.bind(this._port, this._bindHost);
        } catch (err) {
            this._fault = true;
            this._log(`[headtrack] failed to open socket: ${err.message}`);
            return;
        }
        this._log(
            `[headtrack] LOG-ONLY receiver listening on ${this._bindHost}:${this._port} ` +
                `(stale > ${this._monitor.diagnostics(this._clock()).staleMs} ms; no control output)`
        );
        this._lastState = 'idle';
        this._timer = this._schedule(() => this._tick(), STATUS_TICK_MS);
        this._running = true;
    }

    _onMessage(buf, rinfo) {
        const nowMs = this._clock();
        const result = this._monitor.ingest(buf, nowMs);
        if (result.accepted && rinfo) this._noteRemoteAddr(rinfo.address);
        if (!result.accepted && this._invalidLogsThisWindow < MAX_INVALID_LOGS_PER_WINDOW) {
            this._invalidLogsThisWindow += 1;
            this._log(`[headtrack] rejected packet: ${result.reason}`);
        }
        this._maybeAnnounceState(nowMs);
    }

    _tick() {
        const nowMs = this._clock();
        this._maybeAnnounceState(nowMs);
        this._ticks += 1;
        if (this._ticks % RATE_LINE_EVERY_TICKS === 0) {
            this._invalidLogsThisWindow = 0;
            const d = this._monitor.diagnostics(nowMs);
            const lv = d.lastValid;
            this._log(
                `[headtrack] state=${this.state(nowMs)} rate=${d.ratePerSec}/s ` +
                    `valid=${d.counts.valid} invalid=${d.counts.invalid} ` +
                    `age=${d.packetAgeMs === null ? '--' : `${d.packetAgeMs}ms`} ` +
                    `seq=${lv ? lv.seq : '--'} ` +
                    `yaw=${lv ? lv.yaw_deg.toFixed(2) : '--'} ` +
                    `pitch=${lv ? lv.pitch_deg.toFixed(2) : '--'} ` +
                    `roll=${lv ? lv.roll_deg.toFixed(2) : '--'} ` +
                    `enabled=${lv ? lv.tracking_enabled : '--'} centered=${lv ? lv.centered : '--'} ` +
                    `gaps=${d.seqGaps} regressions=${d.seqRegressions}`
            );
        }
    }

    _maybeAnnounceState(nowMs) {
        const state = this.state(nowMs);
        if (state !== this._lastState) {
            this._log(`[headtrack] state: ${this._lastState} -> ${state}`);
            this._lastState = state;
        }
    }

    // Full 8-state view: 'disabled'/'fault' from the receiver lifecycle, the
    // rest derived from packets by the monitor.
    state(nowMs = this._clock()) {
        if (this._fault) return 'fault';
        if (!this._running) return 'disabled';
        return this._monitor.state(nowMs);
    }

    // Read-only diagnostics snapshot -- the only data this module exposes.
    getDiagnostics(nowMs = this._clock()) {
        return { ...this._monitor.diagnostics(nowMs), state: this.state(nowMs) };
    }

    stop() {
        if (this._running) {
            this._cancel(this._timer);
            this._timer = null;
            this._running = false;
        }
        if (this._socket) {
            try {
                this._socket.close();
            } catch {
                /* already closed */
            }
            this._socket = null;
        }
        this._lastState = 'disabled';
    }
}

module.exports = { HeadTrackingReceiver };
