// Lifecycle owner for the session-scoped runtime pieces: the telemetry source
// and the OUTBOUND iPhone telemetry bridge (W2, send-only). Extracted from
// main.js so `session:apply` can reconfigure them after the setup flow without
// restarting the app, and so the start/stop choreography unit-tests with fake
// factories (repo HAL-seam style).
//
// Deliberately NOT here: the W3 diagnostic receiver. Its construct/start/stop
// stays inline in main.js — the single sanctioned wiring point — so the
// no-control-path module-graph guard can list this file as clean.
//
// applyConfig is diff-aware and idempotent: an unchanged subsystem keeps
// running untouched (a GRID re-apply must not blink live telemetry).

class SessionRuntime {
    constructor({ createTelemetrySource, createIphoneBridge, log = () => {} }) {
        this._createTelemetrySource = createTelemetrySource;
        this._createIphoneBridge = createIphoneBridge;
        this._log = log;

        this._telemetry = null;
        this._telemetryKey = null;
        this._unsubscribe = null;

        this._bridge = null;
        this._bridgeKey = null;

        this._snapshotSink = null; // renderer push, set when the window exists
    }

    // Renderer sink for telemetry snapshots (webContents.send in the app,
    // a spy in tests). The bridge fan-out is internal and unconditional.
    setSnapshotSink(fn) {
        this._snapshotSink = fn;
    }

    hasTelemetrySource() {
        return !!this._telemetry;
    }

    applyConfig(effective) {
        const teleKey = JSON.stringify(effective.telemetry);
        if (teleKey !== this._telemetryKey) {
            this._stopTelemetry();
            this._telemetry = this._createTelemetrySource(effective.telemetry) || null;
            this._telemetryKey = teleKey;
            if (this._telemetry) {
                this._unsubscribe = this._telemetry.onTelemetry((t) => {
                    if (this._snapshotSink) this._snapshotSink(t);
                    // Second consumer: the send-only bridge. Feeding it here
                    // never alters the renderer push above.
                    if (this._bridge) this._bridge.onTelemetry(t);
                });
                this._telemetry.start();
            }
        }

        const demo = effective.telemetry.source === 'replay';
        const bridgeKey = effective.iphoneBridge
            ? JSON.stringify({ ...effective.iphoneBridge, demo })
            : null;
        if (bridgeKey !== this._bridgeKey) {
            this._stopBridge();
            this._bridge = effective.iphoneBridge
                ? this._createIphoneBridge(effective.iphoneBridge, { demo }) || null
                : null;
            this._bridgeKey = bridgeKey;
            if (this._bridge) this._bridge.start();
        }

        return {
            telemetry: effective.telemetry.source,
            iphoneBridge: !!this._bridge,
        };
    }

    // READ-ONLY display mirror from the renderer, forwarded outward only.
    onCommandMirror(mirror) {
        if (this._bridge) this._bridge.onCommandMirror(mirror);
    }

    _stopTelemetry() {
        if (this._unsubscribe) {
            this._unsubscribe();
            this._unsubscribe = null;
        }
        if (this._telemetry) {
            this._telemetry.stop();
            this._telemetry = null;
        }
        this._telemetryKey = null;
    }

    _stopBridge() {
        if (this._bridge) {
            this._bridge.stop();
            this._bridge = null;
        }
        this._bridgeKey = null;
    }

    stopAll() {
        this._stopTelemetry();
        this._stopBridge();
    }
}

module.exports = { SessionRuntime };
