// Runtime lifecycle authority for the PIT WALL hotspot (audit B1). ONE place —
// this module, in the MAIN process — owns the runtime hotspot state; the
// renderer mirrors the snapshots it emits and never invents state of its own,
// so a navigated-away (or reloaded) PIT WALL re-reads the same truth it left.
// It wraps the backend-facing HotspotManager, which remains the OWNERSHIP
// truth (`manager.active()` = the backend THIS APP started; never an external
// hotspot). On top of that this module adds:
//
//  - the approved runtime model INACTIVE -> STARTING -> LIVE -> STOPPING
//    (decision Q2): a failed start returns to INACTIVE with an actionable
//    lastError; a failed stop returns to LIVE with ownership retained so
//    retry stays possible (audit N2);
//  - a config-mismatch partial start presented as LIVE + lastError: tethering
//    IS broadcasting and IS app-owned (wrong SSID), so STOP/retry must be
//    offered — INACTIVE would misrepresent a radio that is actually on;
//  - duplicate start/stop suppression at the authority ({ok:false,
//    kind:'busy'} while a transition is in flight) — the UI disables
//    conflicting controls too, but the DOM is never the enforcement point;
//  - the capability probe (audit N3): cached, single-flight (concurrent
//    callers share one PowerShell probe), refreshable via {refresh:true},
//    and never a render blocker — snapshots report probe:'probing' while it
//    runs, and a broken probe becomes a controlled {status:'failed'} result,
//    never an unhandled rejection;
//  - change notifications so main.js can push every snapshot to the renderer
//    (including changes made by the quit dialog's stop attempt).
//
// Snapshots are credential-free by construction: the password is passed
// through to the manager and never stored, logged, or echoed here.

const PHASES = Object.freeze(['inactive', 'starting', 'live', 'stopping']);

const busyText = (phase) => (phase === 'live'
    ? 'a hotspot started by this app is already live — STOP HOTSPOT first'
    : `hotspot ${phase === 'starting' ? 'start' : 'stop'} already in progress — wait for it to finish`);

// Narrow error surface for snapshots: kind + message (+ optional suggestion),
// never the whole backend result (and never anything credential-bearing —
// the manager already guarantees its error strings are password-free).
const pickError = (res, fallbackText) => ({
    kind: res.kind || 'error',
    error: res.error || fallbackText,
    ...(res.suggestion ? { suggestion: res.suggestion } : {}),
});

class HotspotLifecycle {
    constructor({ manager, verify = null, log = () => {} } = {}) {
        this._manager = manager;
        this._verify = verify;     // injected local readiness check (hotspotVerify.js); null = unavailable
        this._log = log;
        this._phase = 'inactive';
        this._backend = null;
        this._ssid = '';
        this._hostIp = null;
        this._lastError = null; // { kind, error, suggestion? }
        this._listeners = new Set();
        this._probeResult = null;  // last completed probe (cached)
        this._probePromise = null; // in-flight probe (shared by callers)
        this._transition = null;   // in-flight start/stop (quit policy waits on it)
        this._seq = 0;             // bumped per state change; snapshots carry it
        // Honest readiness model (Windows observation #4): a hotspot whose
        // start command succeeded is NOT presented as client-ready until the
        // local checks pass. status: 'idle' (no verification ran/applies) |
        // 'verifying' | 'verified' | 'degraded' (+reasons). Distinct from
        // `interrupted`, which records a WLAN-adapter loss WHILE live.
        this._readiness = { status: 'idle', reasons: [] };
        this._interrupted = null;  // reason string, only ever set while live
        this._verifyEpoch = 0;     // stale async verify completions are dropped
    }

    onChange(listener) {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    _emit() {
        this._seq += 1;
        const snap = this.snapshot();
        for (const listener of this._listeners) {
            try {
                listener(snap);
            } catch (err) {
                this._log(`[hotspot] state listener failed: ${err && err.message ? err.message : err}`);
            }
        }
    }

    // The renderer-facing mirror. `owned` comes straight from the manager on
    // every call — ownership truth is never a cached copy here, let alone DOM
    // state. probe.status: 'idle' (never ran) | 'probing' | 'supported' |
    // 'unsupported' | 'failed', plus backend/mobileState/externallyActive
    // once a probe has completed. `seq` orders snapshots CAUSALLY: it bumps
    // on every state change, and the renderer drops any snapshot older than
    // the newest it holds — Electron can deliver a push issued inside an
    // ipcMain.handle turn AFTER one issued from a later microtask (observed
    // in the sim acceptance pass), so arrival order must never be trusted.
    snapshot() {
        return {
            seq: this._seq,
            phase: this._phase,
            owned: !!this._manager.active(),
            backend: this._backend,
            ssid: this._ssid,
            hostIp: this._hostIp,
            lastError: this._lastError,
            readiness: this._readiness,
            interrupted: this._interrupted,
            probe: this._probePromise
                ? { status: 'probing' }
                : (this._probeResult || { status: 'idle' }),
        };
    }

    // Resolves once no start/stop transition is in flight (never rejects).
    // The quit policy uses this to defer its ownership decision until a quit
    // issued during STARTING/STOPPING has a settled state to judge.
    whenSettled() {
        return this._transition ? this._transition.then(() => {}, () => {}) : Promise.resolve();
    }

    // Capability probe (audit N3). Cached after the first completion;
    // {refresh:true} forces a re-probe (the pane's RECHECK). Concurrent
    // callers share the in-flight probe, so repeated PIT WALL entries can
    // never stack PowerShell probes.
    probe({ refresh = false } = {}) {
        if (this._probePromise) return this._probePromise;
        if (this._probeResult && !refresh) return Promise.resolve(this._probeResult);
        this._probePromise = this._runProbe();
        this._emit(); // 'probing' becomes visible immediately
        return this._probePromise;
    }

    async _runProbe() {
        let result;
        try {
            const p = await this._manager.probeBackends();
            result = {
                status: p.canHotspot ? 'supported' : 'unsupported',
                backend: p.preferred || null,
                mobileState: p.mobileState ?? null,
                // WinRT says tethering is already On and WE did not start it:
                // an externally started hotspot (Windows Settings, another
                // tool). Shown as such — never owned, never stopped by us.
                externallyActive: p.mobileState === 'On' && !this._manager.active(),
            };
        } catch (err) {
            // probeBackends soft-fails by contract; a rejection is plumbing
            // trouble. Surface a controlled 'failed' state the UI can retry.
            this._log(`[hotspot] capability probe failed: ${err && err.message ? err.message : err}`);
            result = { status: 'failed', backend: null, mobileState: null, externallyActive: false };
        }
        this._probeResult = result;
        this._probePromise = null;
        this._emit();
        return result;
    }

    async start({ ssid, password } = {}) {
        if (this._phase !== 'inactive') {
            return { ok: false, kind: 'busy', error: busyText(this._phase) };
        }
        this._phase = 'starting';
        this._lastError = null;
        this._interrupted = null;
        this._readiness = { status: 'idle', reasons: [] };
        this._emit();
        const op = this._doStart({ ssid, password });
        this._transition = op;
        try {
            return await op;
        } finally {
            this._transition = null;
        }
    }

    async _doStart({ ssid, password }) {
        let res;
        try {
            res = await this._manager.start({ ssid, password });
        } catch (err) {
            // The manager soft-fails by contract; a rejection here is a
            // plumbing bug. Detail is withheld — the thrown message can echo
            // the arguments, which carry the password.
            this._log('[hotspot] start rejected unexpectedly (detail withheld — args carry credentials)');
            res = { ok: false, kind: 'ps-error', error: 'hotspot start failed unexpectedly — retry' };
        }
        if (res.ok) {
            this._phase = 'live';
            this._backend = res.method;
            this._ssid = res.ssid;
            this._hostIp = res.hostIp || null;
            this._lastError = null;
            // A successful start command is NOT client-readiness. Kick the
            // local verification (non-blocking); until it lands the pane says
            // VERIFYING, never a plain success.
            this._startVerify();
        } else if (this._manager.active()) {
            // Partial start we own (START_CONFIG_MISMATCH): tethering IS
            // running, started by us, with the wrong SSID. LIVE + error keeps
            // STOP and retry available; ssid stays empty — the requested name
            // was NOT applied and must not be presented as broadcast.
            this._phase = 'live';
            this._backend = this._manager.active();
            this._ssid = '';
            this._hostIp = null;
            this._lastError = pickError(res, 'hotspot started in a wrong state — STOP HOTSPOT and retry');
        } else {
            this._phase = 'inactive';
            this._backend = null;
            this._ssid = '';
            this._hostIp = null;
            this._lastError = pickError(res, 'hotspot start failed');
        }
        this._emit();
        return res;
    }

    async stop() {
        if (this._phase === 'starting' || this._phase === 'stopping') {
            return { ok: false, kind: 'busy', error: busyText(this._phase) };
        }
        if (!this._manager.active()) {
            // Nothing this app owns: never stops an externally started
            // hotspot (Q1/Q2) — and does not pretend to have stopped one.
            return { ok: true, noop: true };
        }
        this._phase = 'stopping';
        this._emit();
        const op = this._doStop();
        this._transition = op;
        try {
            return await op;
        } finally {
            this._transition = null;
        }
    }

    async _doStop() {
        let res;
        try {
            res = await this._manager.stop();
        } catch (err) {
            this._log(`[hotspot] stop rejected unexpectedly: ${err && err.message ? err.message : err}`);
            res = { ok: false, kind: 'stop-failed', error: 'hotspot stop failed unexpectedly — retry' };
        }
        if (res.ok) {
            this._phase = 'inactive';
            this._backend = null;
            this._ssid = '';
            this._hostIp = null;
            this._lastError = null;
            this._interrupted = null;
            this._readiness = { status: 'idle', reasons: [] };
        } else {
            // The manager retains ownership on a failed stop (audit N2), so
            // the honest state is still LIVE: ours, broadcasting, retryable.
            this._phase = 'live';
            this._lastError = pickError(res, 'hotspot stop failed');
        }
        this._emit();
        return res;
    }

    // --- local readiness verification (Windows observation #4) -------------

    // Public re-verify (the pane's REVERIFY, and the adapter-change guard).
    // Bounded and observable: one run at a time per epoch, snapshots carry
    // 'verifying' while it runs, and a run that outlives the LIVE phase (or a
    // newer run) is discarded. No blind sleeps anywhere — verification is
    // triggered by events (start success, adapter change, operator request).
    async verify() {
        if (this._phase !== 'live') {
            return { ok: false, kind: 'not-live', error: 'no live hotspot to verify' };
        }
        if (!this._verify) {
            return { ok: false, kind: 'unsupported', error: 'local verification is unavailable on this platform' };
        }
        return this._startVerify();
    }

    async _startVerify() {
        if (!this._verify) return { ok: true, readiness: this._readiness };
        this._verifyEpoch += 1;
        const epoch = this._verifyEpoch;
        this._readiness = { status: 'verifying', reasons: [] };
        this._emit();
        let readiness;
        try {
            const { status, reasons } = await this._verify({ backend: this._backend });
            readiness = { status, reasons };
        } catch (err) {
            this._log(`[hotspot] readiness verification rejected: ${err && err.message ? err.message : err}`);
            readiness = { status: 'degraded', reasons: ['local readiness check failed unexpectedly — REVERIFY to retry'] };
        }
        // Stale completion: the hotspot stopped, or a newer verify superseded
        // this one, while the checks ran. Its result must not overwrite truth.
        if (epoch !== this._verifyEpoch || this._phase !== 'live') {
            return { ok: false, kind: 'stale', readiness };
        }
        this._readiness = readiness;
        this._emit();
        return { ok: true, readiness };
    }

    // WLAN-adapter loss while the hotspot is live (Windows observation #3):
    // the radio cannot still be broadcasting with no adapter present, so LIVE
    // would be a false state. Ownership is retained — STOP remains the honest
    // cleanup path — but the snapshot says INTERRUPTED, never plain LIVE.
    markInterrupted(reason) {
        if (this._phase !== 'live' || this._interrupted) return false;
        this._interrupted = reason || 'the WLAN adapter disappeared while the hotspot was live';
        this._readiness = { status: 'degraded', reasons: [this._interrupted] };
        this._log(`[hotspot] interrupted: ${this._interrupted}`);
        this._emit();
        return true;
    }
}

module.exports = { HotspotLifecycle, PHASES };
