// Windows -> iPhone telemetry sender (docs/windows_bridge_contract.md — the
// Windows copy of the iPhone app's canonical bridge contract; default port 5601).
//
// A SECOND consumer of the existing telemetry flow: main.js feeds it each merged
// car snapshot via onTelemetry(t) alongside the renderer push, and the renderer
// feeds it the READ-ONLY command/camera mirror via onCommandMirror(m) (display
// values only — throttle/brake/steering/camera as shown on the HUD). Neither
// feed disturbs the HUD, and nothing flows back: this bridge is SEND-ONLY. The
// iPhone head-tracking receiver (port 5602) is a separate, later, log-only batch.
//
// Staleness honesty (contract "Nullable And Unknown Values"): car fields and
// mirror fields each carry their own freshness. When the car source goes stale
// the packet omits car fields and flags `stale_data_warnings: ["telemetry"]`;
// when the mirror goes stale (renderer gone quiet) its fields are omitted. Old
// values are never re-sent as fresh — the iPhone judges fresh/stale/lost from
// its own receive time.
//
// Thin I/O only (mirrors CrsfSerialSource's HAL-seam style): socket, clock, and
// link-state function are injectable so logic tests run with fakes and no real
// network. Disabled by default; main.js constructs this only when
// W17_IPHONE_BRIDGE=1 and W17_IPHONE_ADDR is set. CommonJS.

const dgram = require('node:dgram');
const { buildTelemetrySnapshot } = require('../shared/telemetrySnapshot.js');

// Mirror packets arrive from the renderer at ~20 Hz; silence longer than this
// means the window is gone/hung — omit the mirror rather than freeze it.
const MIRROR_FRESH_MS = 1000;

class IphoneTelemetryBridge {
    constructor({
        addr,
        port = 5601,
        rateHz = 10,
        linkStateFn,
        mode, // optional 'demo' | 'udp' diagnostic tag for the packet
        clock = () => Date.now(),
        // Injectable for tests: return an object with send(buf, port, addr) and close().
        socketFactory = () => dgram.createSocket('udp4'),
        schedule = (fn, ms) => setInterval(fn, ms),
        cancel = (h) => clearInterval(h),
        log = () => {},
    } = {}) {
        if (!addr) throw new Error('IphoneTelemetryBridge requires a destination addr');
        if (typeof linkStateFn !== 'function') {
            throw new Error('IphoneTelemetryBridge requires a linkStateFn');
        }
        this._addr = addr;
        this._port = port;
        this._periodMs = Math.max(1, Math.round(1000 / rateHz));
        this._linkStateFn = linkStateFn;
        this._mode = mode;
        this._clock = clock;
        this._socketFactory = socketFactory;
        this._schedule = schedule;
        this._cancel = cancel;
        this._log = log;

        // Latest merged car snapshot + arrival bookkeeping (inputs to the
        // link-state derivation, mirroring the renderer's telemFresh/everLive).
        this._latest = null;
        this._lastTelemetryMs = 0;
        this._everLive = false;

        // Latest read-only command/camera mirror from the renderer.
        this._mirror = null;
        this._lastMirrorMs = 0;

        this._socket = null;
        this._timer = null;
    }

    // Fed by main.js on every telemetry emit (second consumer; the renderer
    // push is untouched). Records value + arrival time for staleness.
    onTelemetry(t) {
        this._latest = t;
        this._lastTelemetryMs = this._clock();
        this._everLive = true;
    }

    // Fed from the renderer over IPC: display-only gamepad/camera mirror.
    // Read-only by construction — the bridge only serializes it outward.
    onCommandMirror(m) {
        this._mirror = m;
        this._lastMirrorMs = this._clock();
    }

    start() {
        if (this._timer) return;
        this._socket = this._socketFactory();
        if (this._socket && typeof this._socket.on === 'function') {
            // A UDP send to an unreachable host can surface an async error; log
            // and keep running (fire-and-forget — one bad datagram is fine).
            this._socket.on('error', (err) => this._log(`[iphone] socket error: ${err.message}`));
        }
        this._log(`[iphone] telemetry bridge -> ${this._addr}:${this._port} @ ${Math.round(1000 / this._periodMs)}Hz`);
        this._timer = this._schedule(() => this._tick(), this._periodMs);
    }

    _tick() {
        const nowMs = this._clock();
        const linkState = this._linkStateFn({
            nowMs,
            lastTelemetryMs: this._lastTelemetryMs,
            everLive: this._everLive,
            linkQualityPct: this._latest ? this._latest.linkQualityPct : undefined,
            failsafe: this._latest ? this._latest.failsafe : undefined,
        });
        const mirrorFresh =
            this._mirror && nowMs - this._lastMirrorMs <= MIRROR_FRESH_MS ? this._mirror : null;
        const packet = buildTelemetrySnapshot({
            tMs: nowMs,
            telem: this._latest,
            linkState,
            mirror: mirrorFresh,
            mode: this._mode,
        });
        const buf = Buffer.from(JSON.stringify(packet));
        try {
            this._socket.send(buf, this._port, this._addr);
        } catch (err) {
            this._log(`[iphone] send failed: ${err.message}`);
        }
    }

    stop() {
        if (this._timer) {
            this._cancel(this._timer);
            this._timer = null;
        }
        if (this._socket && typeof this._socket.close === 'function') {
            try {
                this._socket.close();
            } catch {
                /* already closed */
            }
        }
        this._socket = null;
    }
}

module.exports = { IphoneTelemetryBridge, MIRROR_FRESH_MS };
