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
const path = require('node:path');
const { normalizeRacePrep, MAPPER_TELEMETRY_SOURCE } = require('../shared/settings.js');

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
    const trimmed = profilePath.trim();
    if (trimmed.startsWith('-')) {
        // A leading dash would let a hostile/typo'd settings value ride into
        // option position downstream. Refuse honestly instead of launching.
        return { ok: false, kind: 'bad-profile-path' };
    }
    // Absolute paths only (review minor 3): this module validates existence
    // against the GS's own working directory, but the mapper resolves a
    // relative path against ITS working directory (the binary's folder) — the
    // two silently disagree, so a relative value could pass the check here
    // and still launch the mapper on a missing/different file. Either path
    // convention is accepted (the ⚙ value is written on Windows, dev runs on
    // POSIX), a relative form under BOTH is refused.
    if (!path.win32.isAbsolute(trimmed) && !path.posix.isAbsolute(trimmed)) {
        return { ok: false, kind: 'bad-profile-path' };
    }
    return { ok: true, argv: [MAPPER_ARG_WHITELIST[0], trimmed] };
}

// Owner decision OD-4: 'telemetry' sits AFTER the drive program, because the
// source it selects reads from that program's own read-only stream — there is
// nothing to listen to until it is up.
const STEP_ORDER = Object.freeze(['hotspot', 'mapper', 'telemetry', 'bridge']);

// How long the telemetry step waits for the car's FIRST reading before saying
// so. Deliberately short: the step never fails and never halts the sequence —
// whether the car is switched on is not race day's business — it only decides
// between "on — the car is sending readings" and "on — waiting for the car".
const TELEMETRY_FIRST_READING_MS = 3000;

// How long the mapper step waits for the RF link to come UP before deciding
// (review SYN-2). The mapper answers the moment the stream opens and then every
// 500 ms, so this is a window for the transmitter port to open, not a poll
// budget: a healthy bring-up resolves in well under a second.
const LINK_UP_WAIT_MS = 5000;

// Mapper-step kinds that CLAIM the drive program is up and driving. A link that
// drops under any of them makes that claim false. 'link-not-yet' is deliberately
// NOT here: it claims nothing about the radio, so there is nothing to take back.
const LINK_BEARING_KINDS = new Set(['running', 'already-running', 'external', 'link-unknown']);

// Credential states race day refuses to write settings under (owner decision
// OD-19). The narrow store method below cannot destroy the hotspot password by
// construction, but the ruling asks for the guard as well: on a computer whose
// stored credential is unreadable or session-only, the honest answer is "the
// readings could not be switched on", not an automatic rewrite of the file that
// holds it.
const CREDENTIAL_UNSAFE_STATES = new Set(['undecryptable', 'session-only', 'unavailable']);

class RaceDayOrchestrator {
    constructor({
        hotspotLifecycle, mapperRunner, sessionApplier, settingsStore,
        existsSync = fsDefault.existsSync,
        // Probe for an instance of the drive program running OUTSIDE race day
        // (the GRID's detached launch is the same executable in the gift kit).
        // Injected: main.js hands in the existing elrs.detectRunning seam.
        elrsDetect = async () => ({ configured: false, detected: false }),
        // Owner decision OD-4. What the session runtime currently has:
        // { source, receiving }. Injected (main.js hands in the SessionRuntime's
        // own telemetryStatus) so this module reads truth rather than deriving
        // it, and so the step tests need no telemetry plumbing at all.
        telemetryStatus = () => ({ source: 'none', receiving: false }),
        // Review SYN-2. The mapper's OWN answer to "am I transmitting?", read
        // from its read-only link-state stream: { start, stop, snapshot, onChange }
        // where snapshot() is { up: true | false | null }. Injected, and null by
        // default — with no probe wired this module behaves exactly as it did
        // before, rather than inventing a link state it cannot observe.
        linkProbe = null,
        // Test seam for the one bounded wait in this module.
        schedule = (fn, ms) => setTimeout(fn, ms),
        log = () => {},
    } = {}) {
        this._lifecycle = hotspotLifecycle;
        this._runner = mapperRunner;
        this._applier = sessionApplier;
        this._settingsStore = settingsStore;
        this._existsSync = existsSync;
        this._elrsDetect = elrsDetect;
        this._telemetryStatus = telemetryStatus;
        this._linkProbe = linkProbe;
        this._schedule = schedule;
        this._log = log;
        this._running = false;
        this._seq = 0;
        // OD-19: race day changed a persisted setting on this computer. Sticky
        // for the session so the GARAGE line survives a later idle card — a
        // configuration that changed quietly is what the operator must be told.
        this._telemetrySelected = false;
        // Review blocking 2: has the mapper ever CLAIMED the link was up in
        // this session? Before it has, a window that closes on "not connected"
        // is a bring-up still in progress, not a fault to blame a cable for.
        this._linkEverUp = false;
        // The success kind the current link check is standing in for, so a link
        // that comes up later restores the right sentence ('external' stays
        // 'external', not a claim that race day started it).
        this._linkOkKind = 'running';
        this._steps = {
            hotspot: { status: 'idle', kind: null },
            mapper: { status: 'idle', kind: null },
            telemetry: { status: 'idle', kind: null },
            bridge: { status: 'idle', kind: null },
        };
        this._listeners = new Set();
        // Liveness mirror: if the managed mapper dies while its step says OK,
        // the card must say so (honestly) without waiting for a button press.
        // A stop WE requested winds the step back to idle instead — a
        // requested shutdown is not a failure.
        this._unsubRunner = this._runner.onChange((st) => {
            // A stop we asked for was forced and STILL did not take: the drive
            // program is alive. This one is set from ANY step state (the stop
            // path already wound the card to idle) — a stopped-looking card
            // over a live program is the single worst thing race day can draw.
            if (st.stopFailed) {
                this._set('mapper', 'fail', 'stop-failed');
                return;
            }
            if (st.running || this._steps.mapper.status !== 'ok') return;
            if (st.stoppedByUs) this._set('mapper', 'idle', null);
            // A failed spawn surfaces asynchronously as the runner's
            // 'spawn-error' exit (review blocker 1): the honest line is the
            // check-the-⚙-location one, not "stopped on its own".
            else if (st.exitCode === 'spawn-error') this._set('mapper', 'fail', 'spawn-failed');
            // It died on its own AND said why. The drive program refuses a
            // saved controller setup whose per-computer values are still
            // unfilled, printing one plain sentence and stopping — for THAT,
            // "press RACE DAY to bring it back" is a loop that can never end,
            // so the card points at the program's own words instead.
            else this._set('mapper', 'fail', st.exitMessage ? 'exited-with-message' : 'exited');
        });
        // Link mirror (review SYN-2): the drive program can be alive with its
        // transmitter port shut, in which case no CRSF frame leaves the PC. If
        // that happens AFTER the bring-up said the link was up, the card must
        // stop claiming it — and must take the claim back when it returns.
        this._unsubLink = (this._linkProbe && this._linkProbe.onChange)
            ? this._linkProbe.onChange((snap) => {
                const step = this._steps.mapper;
                if (step.status === 'ok' && LINK_BEARING_KINDS.has(step.kind) && snap.up === false) {
                    this._set('mapper', 'fail', 'link-down');
                } else if (step.status === 'fail' && step.kind === 'link-down' && snap.up === true) {
                    this._set('mapper', 'ok', 'running');
                }
            })
            : null;
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
            // The mapper's own link answer (review SYN-2), or an honest
            // unknown when nothing is watching it on this computer.
            link: this._linkProbe ? this._linkProbe.snapshot() : { up: null },
            // OD-19: race day persisted the one setting it is allowed to
            // persist. The GARAGE renders a line for it (shared/raceDayView).
            telemetrySelected: this._telemetrySelected,
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
                && await this._mapperStep(prep)
                && await this._telemetryStep()
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
                // Owner decision OD-7 (review giftee-ux-2). A hotspot that is
                // ALREADY broadcasting is refused by the backend — including
                // the one THIS app left running when the operator chose LEAVE
                // HOTSPOT RUNNING, or after any relaunch. Race day halts at the
                // first failing step, so that refusal used to stop the drive
                // program too and blame the Wi-Fi, on the one route the booklet
                // prints as the recovery. When the broadcasting name IS the
                // saved one, the network the phone needs is up: say so and
                // carry on. A DIFFERENT hotspot still fails — the phone could
                // not join it — and so does one this computer could not name,
                // because "probably ours" is not a thing to tell the operator.
                if (res.kind === 'already-on') {
                    const wanted = typeof hs.ssid === 'string' ? hs.ssid.trim() : '';
                    const found = typeof res.ssid === 'string' ? res.ssid.trim() : '';
                    if (wanted && found === wanted) {
                        this._set('hotspot', 'ok', 'external');
                        return true;
                    }
                    this._set('hotspot', 'fail', found ? 'other-hotspot' : 'already-on-unknown');
                    return false;
                }
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
    async _mapperStep(prep) {
        if (this._runner.status().running) {
            return this._linkCheck('already-running');
        }
        if (!prep.mapperPath) {
            this._set('mapper', 'fail', 'not-configured');
            return false;
        }
        // An instance may already be driving from OUTSIDE race day (review
        // minor 5) — the GRID's detached convenience launch is this same
        // executable in the gift kit. A second instance would lose its port
        // bind and die with a misleading "stopped on its own" line, so probe
        // first (the existing elrs detection seam) and no-op honestly. A
        // rejected probe reads as not-running: the launch below then reports
        // its own truth. The external instance is never adopted or stopped —
        // the launch-only doctrine holds for processes race day did not start.
        let external = null;
        try {
            external = await this._elrsDetect(prep.mapperPath);
        } catch (err) {
            this._log(`[raceday] external drive-program probe failed (treated as not running): ${err && err.message ? err.message : err}`);
        }
        if (external && external.configured && external.detected) {
            return this._linkCheck('external');
        }
        const argvRes = mapperArgv(prep);
        if (!argvRes.ok) {
            this._set('mapper', 'fail', argvRes.kind);
            return false;
        }
        // Existence check on the exact (trimmed) value the mapper will get.
        if (!this._existsSync(argvRes.argv[1])) {
            this._set('mapper', 'fail', 'profile-not-found');
            return false;
        }
        this._set('mapper', 'running', 'starting');
        const res = this._runner.start({ binaryPath: prep.mapperPath, argv: argvRes.argv });
        if (!res.ok) {
            if (res.kind === 'already-running') {
                return this._linkCheck('already-running');
            }
            this._set('mapper', 'fail', res.kind || 'spawn-failed');
            return false;
        }
        return this._linkCheck('running');
    }

    // Review SYN-2. A started process is NOT a driveable car: the mapper opens
    // the transmitter's serial port itself, and with that port shut it emits no
    // CRSF frame at all — the card said "running" either way, which is the one
    // claim on this screen the giftee acts on. So every success path converges
    // here and asks the mapper.
    //
    // Three outcomes, because "not up" and "we could not look" are different
    // things to tell an operator: up -> the given ok kind; down -> an honest
    // failure that names the cable; unknown (nothing answered within the
    // window — no probe wired, or no mapper on a dev host) -> ok, and SAYS it
    // could not be checked, exactly as the hotspot's 'unverified' does.
    async _linkCheck(okKind) {
        if (!this._linkProbe) {
            this._set('mapper', 'ok', okKind);
            return true;
        }
        try {
            this._linkProbe.start();
        } catch (err) {
            this._log(`[raceday] link watch failed to start: ${err && err.message ? err.message : err}`);
            this._set('mapper', 'ok', 'link-unknown');
            return true;
        }
        const up = await this._awaitLink();
        if (up === true) {
            this._set('mapper', 'ok', okKind);
            return true;
        }
        if (up === null) {
            this._set('mapper', 'ok', 'link-unknown');
            return true;
        }
        this._set('mapper', 'fail', 'link-down');
        return false;
    }

    // Poll the probe until the link is UP or the window closes; a false answer
    // does not resolve early, because the transmitter port may still be opening.
    // Returns the last answer (true / false / null).
    _awaitLink(totalMs = LINK_UP_WAIT_MS, stepMs = 100) {
        return new Promise((resolve) => {
            let waited = 0;
            const tick = () => {
                let snap;
                try { snap = this._linkProbe.snapshot() || {}; } catch { snap = {}; }
                const up = snap.up === true ? true : (snap.up === false ? false : null);
                if (up === true) { resolve(true); return; }
                waited += stepMs;
                if (waited >= totalMs) { resolve(up); return; }
                this._schedule(tick, stepMs);
            };
            tick();
        });
    }

    // Step (c): the car's telemetry, so a battery number can reach BOTH screens
    // (owner decision OD-4). On the shipped defaults the telemetry source is
    // 'none' and nothing anywhere could tell the operator the pack is low —
    // the HUD's BATT reads '--' and the low-battery banner can never raise.
    // 'crsf-serial' cannot fix that during a drive: it needs the transmitter's
    // serial port, which the drive program holds exclusively. So race day
    // selects the read-only stream the drive program already publishes.
    //
    // The source id arrives as a CONSTANT from shared/settings.js and is never
    // spelled out here: this module's no-control-path pin bans every transport
    // word outright, and selecting a source must not be the thing that makes
    // one appear in its source text.
    //
    // This step NEVER fails and never halts the sequence. Whether the car is
    // switched on is not race day's business; the honest outcomes are "on — the
    // car is sending readings" and "on — waiting for the car", and a deliberate
    // choice of another source is left alone.
    async _telemetryStep() {
        // The injected seam is read defensively everywhere in this step: a
        // throwing status must degrade to "nothing yet", never take the whole
        // bring-up down and leave this step wedged on 'pending' — a card with a
        // green headline over a step that never ran is exactly the dishonesty
        // race day exists to remove.
        const st = this._readTelemetryStatus();
        const source = st.source || 'none';
        // A developer setting on this computer (W17_TELEMETRY_SOURCE) pins the
        // source; race day must not fight it, and must say why the readings are
        // not coming. The effective config is where that lock is recorded.
        const eff = this._applier.effective ? this._applier.effective() : null;
        const locked = !!(eff && eff.envOverridden && eff.envOverridden.telemetrySource);
        if (locked && source === 'none') {
            this._set('telemetry', 'skipped', 'held-off');
            return true;
        }
        if (source !== 'none' && source !== MAPPER_TELEMETRY_SOURCE) {
            // replay (the demo loop) or crsf-serial: someone chose it on
            // purpose. Report it and change nothing.
            this._set('telemetry', 'skipped', 'own-source');
            return true;
        }
        if (source === 'none') {
            if (locked) {
                this._set('telemetry', 'skipped', 'held-off');
                return true;
            }
            // Owner decision OD-19 / review blocking 1. This is the only write
            // race day makes, and it is made through the store's NARROW patch —
            // never save(), whose load/normalize/serialize round trip drops the
            // encrypted hotspot password and rewrites it only from a plaintext
            // it could decrypt. On a computer that cannot read the stored token
            // that round trip DELETED the credential, unattended, on one press.
            const credState = this._credentialState();
            if (CREDENTIAL_UNSAFE_STATES.has(credState)) {
                this._log(`[raceday] telemetry source left alone: the saved Wi-Fi credential is '${credState}' on this computer`);
                this._set('telemetry', 'skipped', 'unavailable');
                return true;
            }
            this._set('telemetry', 'running', 'selecting');
            let patched = null;
            try {
                patched = this._settingsStore.patchTelemetrySource(MAPPER_TELEMETRY_SOURCE);
            } catch (err) {
                this._log(`[raceday] could not select the telemetry source: ${err && err.message ? err.message : err}`);
                this._set('telemetry', 'skipped', 'unavailable');
                return true;
            }
            if (!patched || patched.ok !== true) {
                this._log(`[raceday] telemetry source not written (${(patched && patched.kind) || 'refused'})`);
                this._set('telemetry', 'skipped', 'unavailable');
                return true;
            }
            // A configuration that quietly changed is the same class of surprise
            // as one that quietly reset, so the GARAGE says so (OD-19). Sticky
            // for the life of this session, like the settings-recovery notice.
            if (patched.changed !== false) this._telemetrySelected = true;
            try {
                this._applier.apply();
                this._log('[raceday] telemetry source set to the drive program\'s read-only stream');
            } catch (err) {
                this._log(`[raceday] could not apply the telemetry source: ${err && err.message ? err.message : err}`);
                this._set('telemetry', 'skipped', 'unavailable');
                return true;
            }
        }
        this._set('telemetry', 'running', 'waiting');
        const receiving = await this._awaitFirstReading();
        this._set('telemetry', 'ok', receiving ? 'live' : 'waiting');
        return true;
    }

    // The store's non-secret credential state ('none' / 'persisted' /
    // 'undecryptable' / 'session-only' / 'unavailable' / 'migration-failed').
    // Never the value, never the ciphertext. A store that cannot answer reads
    // as 'unknown' and does NOT block the write — the narrow patch is safe on
    // its own; this guard is the second belt, not the only one.
    _credentialState() {
        try {
            const st = this._settingsStore.credentialStatus
                ? this._settingsStore.credentialStatus() : null;
            return (st && typeof st.state === 'string') ? st.state : 'unknown';
        } catch (err) {
            this._log(`[raceday] credential status unavailable: ${err && err.message ? err.message : err}`);
            return 'unknown';
        }
    }

    _readTelemetryStatus() {
        try {
            return this._telemetryStatus() || {};
        } catch (err) {
            this._log(`[raceday] telemetry status unavailable: ${err && err.message ? err.message : err}`);
            return {};
        }
    }

    // Poll the injected status until a reading lands or the short window
    // closes. Polling (rather than a subscription) keeps this module free of
    // any handle on the telemetry source itself.
    _awaitFirstReading(totalMs = TELEMETRY_FIRST_READING_MS, stepMs = 100) {
        return new Promise((resolve) => {
            let waited = 0;
            const tick = () => {
                if (this._readTelemetryStatus().receiving) { resolve(true); return; }
                waited += stepMs;
                if (waited >= totalMs) { resolve(false); return; }
                this._schedule(tick, stepMs);
            };
            tick();
        });
    }

    // Step (d): the phone telemetry link, per settings. Nothing new is wired:
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
        if (st.running) {
            const res = this._runner.stop();
            if (!res.ok) {
                // A failed kill means the child is STILL ALIVE (review minor
                // 4): leave every step exactly as it stands — winding the card
                // to idle would present a stopped state over a live process —
                // and hand the honest kind to the renderer's radio line.
                return { ok: false, kind: 'stop-failed', snapshot: this.snapshot() };
            }
        }
        // Nothing race day started is transmitting any more; stop watching.
        this._stopLinkProbe();
        for (const id of STEP_ORDER) this._steps[id] = { status: 'idle', kind: null };
        this._emit();
        return { ok: true, snapshot: this.snapshot() };
    }

    _stopLinkProbe() {
        if (!this._linkProbe) return;
        try { this._linkProbe.stop(); } catch (err) {
            this._log(`[raceday] link watch stop failed: ${err && err.message ? err.message : err}`);
        }
    }

    // App-teardown hook (composition root): stop the managed child quietly.
    // Idempotent; never emits (the windows are going away).
    dispose() {
        if (this._unsubRunner) {
            this._unsubRunner();
            this._unsubRunner = null;
        }
        if (this._unsubLink) {
            this._unsubLink();
            this._unsubLink = null;
        }
        this._stopLinkProbe();
        const st = this._runner.status();
        if (st.running) this._runner.stop();
    }
}

module.exports = { RaceDayOrchestrator, mapperArgv, MAPPER_ARG_WHITELIST, STEP_ORDER };
