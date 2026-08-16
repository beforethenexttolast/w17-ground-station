// One-action race day (vision operator model): a single giftee-facing command
// brings the whole laptop side up — (a) hotspot up + locally verified through
// the EXISTING lifecycle authority and its honest-readiness model, (b) the
// drive program (mapper) started with the saved controller profile through
// the managed MapperRunner seam, (c) the phone telemetry link (W2, send-only)
// enabled per settings via the EXISTING session applier. No step grows a new
// authority: this module only sequences the authorities that already exist
// and mirrors their truth into one per-step status snapshot.
//
// INVARIANT (the line this feature moves deliberately, and no further): the
// ground station may manage the mapper PROCESS — start, liveness, stop — but
// it never SENDS the mapper anything. No standard-input writes of any kind
// (the runner opens no handle to it), no RPC calls to the mapper's control
// services, nothing on the mapper's diagnostic UDP port (W3 — the log-only
// port stays exactly as documented in CLAUDE.md). The command line is the
// ONLY thing this module hands the mapper, and it is built by a pure
// whitelist function below: launch-lifecycle strings only, nothing that could
// carry channel/control content, and none of the mapper's experimental
// head-tracking ingest flags — v1 passes no such flag, ever
// (test/noControlPath.test.js and test/raceDayOrchestrator.test.js pin both
// the whitelist and this module's structure).
//
// Failure semantics (giftee bar: honest plain language + safe partial state):
// the sequence halts at the first failing step; steps already up STAY up
// (nothing is wound back on failure), later steps stay 'pending'. Pressing
// RACE DAY again re-runs idempotently — a live hotspot is only re-verified, a
// running mapper is left running, the bridge re-applies. STOP winds down only
// what race day exclusively owns (the managed mapper): hotspot shutdown stays
// the quit policy's / PIT WALL's decision (Q1), and the phone link follows
// persisted settings, exactly as before this feature.
//
// Step kinds are machine-readable; the plain-language wording lives in
// shared/raceDayView.mjs (renderer side) so the giftee copy is testable
// against the wave-2a wording bar without booting Electron.

const fsDefault = require('node:fs');
const { normalizeRacePrep } = require('../shared/settings.js');

// The COMPLETE set of option strings race day may ever hand the mapper:
// the saved-profile flag, nothing else. The flag takes its value as the NEXT
// argv element (never '='-joined), so the profile path can never be parsed as
// an option itself — and a path that LOOKS like an option is rejected below.
const MAPPER_ARG_WHITELIST = Object.freeze(['-config-file-path']);

// Pure argv builder — the only source of mapper command lines. Emits either
// a whitelist flag + validated value or a machine-readable refusal; there is
// deliberately NO branch that can append any other string (no extra-args
// escape hatch), so the whitelist holds by construction.
function mapperArgv({ profilePath } = {}) {
    if (typeof profilePath !== 'string' || !profilePath.trim()) {
        return { ok: false, kind: 'no-profile' };
    }
    if (profilePath.trim().startsWith('-')) {
        // A leading dash would let a hostile/typo'd settings value ride into
        // option position downstream. Refuse honestly instead of launching.
        return { ok: false, kind: 'bad-profile-path' };
    }
    return { ok: true, argv: [MAPPER_ARG_WHITELIST[0], profilePath] };
}

const STEP_ORDER = Object.freeze(['hotspot', 'mapper', 'bridge']);

class RaceDayOrchestrator {
    constructor({ hotspotLifecycle, mapperRunner, sessionApplier, settingsStore, existsSync = fsDefault.existsSync, log = () => {} } = {}) {
        this._lifecycle = hotspotLifecycle;
        this._runner = mapperRunner;
        this._applier = sessionApplier;
        this._settingsStore = settingsStore;
        this._existsSync = existsSync;
        this._log = log;
        this._running = false;
        this._seq = 0;
        this._steps = {
            hotspot: { status: 'idle', kind: null },
            mapper: { status: 'idle', kind: null },
            bridge: { status: 'idle', kind: null },
        };
        this._listeners = new Set();
        // Liveness mirror: if the managed mapper dies while its step says OK,
        // the card must say so (honestly) without waiting for a button press.
        // A stop WE requested winds the step back to idle instead — a
        // requested shutdown is not a failure.
        this._unsubRunner = this._runner.onChange((st) => {
            if (st.running || this._steps.mapper.status !== 'ok') return;
            if (st.stoppedByUs) this._set('mapper', 'idle', null);
            else this._set('mapper', 'fail', 'exited');
        });
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
                this._log(`[raceday] state listener failed: ${err && err.message ? err.message : err}`);
            }
        }
    }

    _set(id, status, kind) {
        this._steps[id] = { status, kind: kind ?? null };
        this._emit();
    }

    // Renderer-facing mirror (same shape discipline as the hotspot lifecycle):
    // seq orders snapshots causally; steps carry ONLY status + machine kind —
    // never settings, never credentials, never raw backend error text (that
    // stays in the main-process log). The mapper block adds liveness plus the
    // bounded diagnostics tail for the technician-facing status query.
    snapshot() {
        return {
            seq: this._seq,
            running: this._running,
            steps: STEP_ORDER.map((id) => ({ id, ...this._steps[id] })),
            mapper: { ...this._runner.status(), logTail: this._runner.logTail() },
        };
    }

    async start() {
        if (this._running) {
            return { ok: false, kind: 'busy', snapshot: this.snapshot() };
        }
        this._running = true;
        for (const id of STEP_ORDER) this._steps[id] = { status: 'pending', kind: null };
        this._emit();
        let ok = false;
        try {
            const settings = this._settingsStore.load();
            const prep = normalizeRacePrep(settings.racePrep);
            ok = await this._hotspotStep(settings)
                && this._mapperStep(prep)
                && this._bridgeStep(settings, prep);
        } catch (err) {
            // An unexpected rejection must never wedge the card in RUNNING.
            // Whichever step was in flight goes honestly red; detail is logged
            // main-side only (a rejection can echo credential-bearing args).
            this._log('[raceday] sequence failed unexpectedly (detail withheld from the renderer)');
            for (const id of STEP_ORDER) {
                if (this._steps[id].status === 'running') this._steps[id] = { status: 'fail', kind: 'unexpected' };
            }
            ok = false;
        }
        this._running = false;
        this._emit();
        return { ok, snapshot: this.snapshot() };
    }

    // Step (a): hotspot, only when the saved network plan IS the hotspot.
    // Reuses the one lifecycle authority end to end; every outcome an operator
    // can hit maps to a kind the view renders in plain language.
    async _hotspotStep(settings) {
        const net = settings.network || {};
        if (net.kind !== 'hotspot') {
            this._set('hotspot', 'skipped', 'own-wifi');
            return true;
        }
        let snap = this._lifecycle.snapshot();
        if (snap.phase === 'starting' || snap.phase === 'stopping') {
            this._set('hotspot', 'fail', 'busy');
            return false;
        }
        if (snap.phase !== 'live') {
            this._set('hotspot', 'running', 'starting');
            const hs = net.hotspot || {};
            const res = await this._lifecycle.start({ ssid: hs.ssid, password: hs.password });
            snap = this._lifecycle.snapshot();
            // A config-mismatch partial start is LIVE + owned (the lifecycle's
            // own model) — the readiness check below is what decides honesty.
            if (!res.ok && snap.phase !== 'live') {
                this._set('hotspot', 'fail', 'start-failed');
                return false;
            }
        }
        this._set('hotspot', 'running', 'checking');
        const v = await this._lifecycle.verify();
        if (v.ok) {
            const status = v.readiness && v.readiness.status;
            if (status === 'verified') {
                this._set('hotspot', 'ok', 'verified');
                return true;
            }
            this._set('hotspot', 'fail', 'degraded');
            return false;
        }
        if (v.kind === 'unsupported') {
            // No local verifier on this platform (macOS/Linux dev without the
            // sim): the hotspot is live but this computer cannot double-check
            // client readiness. Honest partial success, distinct from verified.
            this._set('hotspot', 'ok', 'unverified');
            return true;
        }
        if (v.kind === 'stale') {
            // A concurrent re-verify superseded ours; adopt the authority's
            // current truth rather than guessing.
            const cur = this._lifecycle.snapshot();
            if (cur.phase === 'live' && cur.readiness && cur.readiness.status === 'verified') {
                this._set('hotspot', 'ok', 'verified');
                return true;
            }
            this._set('hotspot', 'fail', 'degraded');
            return false;
        }
        this._set('hotspot', 'fail', v.kind === 'not-live' ? 'start-failed' : 'degraded');
        return false;
    }

    // Step (b): the drive program with the saved profile. All validation is
    // up-front and honest — a missing profile refuses to launch (launching the
    // mapper unconfigured would drop the giftee into hobbyist territory).
    _mapperStep(prep) {
        if (this._runner.status().running) {
            this._set('mapper', 'ok', 'already-running');
            return true;
        }
        if (!prep.mapperPath) {
            this._set('mapper', 'fail', 'not-configured');
            return false;
        }
        const argvRes = mapperArgv(prep);
        if (!argvRes.ok) {
            this._set('mapper', 'fail', argvRes.kind);
            return false;
        }
        if (!this._existsSync(prep.profilePath)) {
            this._set('mapper', 'fail', 'profile-not-found');
            return false;
        }
        this._set('mapper', 'running', 'starting');
        const res = this._runner.start({ binaryPath: prep.mapperPath, argv: argvRes.argv });
        if (!res.ok) {
            if (res.kind === 'already-running') {
                this._set('mapper', 'ok', 'already-running');
                return true;
            }
            this._set('mapper', 'fail', res.kind || 'spawn-failed');
            return false;
        }
        this._set('mapper', 'ok', 'running');
        return true;
    }

    // Step (c): the phone telemetry link, per settings. Nothing new is wired:
    // the session applier already owns bridge start/stop from persisted
    // settings + env; race day just runs it and mirrors the outcome.
    _bridgeStep(settings, prep) {
        if (settings.fpvMode !== 'iphone-hud') {
            this._set('bridge', 'skipped', 'desktop-session');
            return true;
        }
        if (!prep.autoBridge) {
            this._set('bridge', 'skipped', 'off-by-choice');
            return true;
        }
        this._set('bridge', 'running', 'applying');
        let applied;
        try {
            applied = this._applier.apply();
        } catch (err) {
            this._log(`[raceday] session apply failed: ${err && err.message ? err.message : err}`);
            this._set('bridge', 'fail', 'apply-failed');
            return false;
        }
        if (applied && applied.iphoneBridge) {
            this._set('bridge', 'ok', 'on');
            return true;
        }
        const eff = this._applier.effective ? this._applier.effective() : null;
        if (eff && eff.envOverridden && eff.envOverridden.iphoneBridge) {
            this._set('bridge', 'fail', 'forced-off');
            return false;
        }
        this._set('bridge', 'fail', 'no-address');
        return false;
    }

    // User STOP: winds down ONLY what race day exclusively owns — the managed
    // mapper. The hotspot stays governed by the quit policy / PIT WALL (Q1),
    // the phone link by persisted settings. Refused while a bring-up is in
    // flight (the authorities in flight own their own transitions).
    stop() {
        if (this._running) {
            return { ok: false, kind: 'busy', snapshot: this.snapshot() };
        }
        const st = this._runner.status();
        if (st.running) this._runner.stop();
        for (const id of STEP_ORDER) this._steps[id] = { status: 'idle', kind: null };
        this._emit();
        return { ok: true, snapshot: this.snapshot() };
    }

    // App-teardown hook (composition root): stop the managed child quietly.
    // Idempotent; never emits (the windows are going away).
    dispose() {
        if (this._unsubRunner) {
            this._unsubRunner();
            this._unsubRunner = null;
        }
        const st = this._runner.status();
        if (st.running) this._runner.stop();
    }
}

module.exports = { RaceDayOrchestrator, mapperArgv, MAPPER_ARG_WHITELIST, STEP_ORDER };
