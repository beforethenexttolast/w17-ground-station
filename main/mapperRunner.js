// Managed lifecycle for the drive program (the mapper) on race day: spawn,
// liveness, bounded log capture, and a clean stop on user request or app
// exit. This is DELIBERATELY a different contract from main/elrsLauncher.js:
//
//  - elrsLauncher is the GRID convenience LAUNCH — detached, fire-and-forget,
//    structurally unable to stop or talk to the program (its own pinned test).
//    That contract stands untouched.
//  - THIS runner is the one-action race-day supervisor (vision operator
//    model): a giftee who presses one button must also get a clean shutdown,
//    so the app may own the PROCESS lifecycle — start, liveness, stop —
//    exactly like it already owns mediamtx's.
//
// The safety line moves with the invariant, not past it: managing the process
// is allowed; TALKING to it is not. The child gets NO standard input (the
// first stdio slot is 'ignore' — there is no writable handle to it at all),
// no IPC channel, no sockets from here, and this app still never sends the
// mapper channel/control data on any path (test/noControlPath.test.js pins
// this module structurally; the orchestrator's argv whitelist pins what the
// command line can carry).
//
// No restart-on-crash, deliberately (unlike mediamtx): auto-restarting the
// program that DRIVES THE CAR is a control-adjacent policy decision. A death
// is surfaced honestly on the race-day card instead, and the giftee's retry
// button is the restart.
//
// POSIX orphan note (review obs 5): a hard crash of the GS (SIGKILL — no
// teardown runs) can orphan the child on macOS/Linux dev hosts; accepted —
// the Windows gift target is covered by the non-detached kill-on-close
// teardown, and a dev host owner can kill the process by hand.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { scrubW17Env } = require('../shared/childEnv.js');
const { runCommand, winTreeKillArgs } = require('./runCommand.js');

// Bounded diagnostics ring: enough tail to diagnose a bad profile path or a
// port clash, small enough that a chatty child can never balloon memory.
const RING_LIMIT = 200; // lines kept
const LINE_LIMIT = 400; // chars kept per line
// The child's own last words, as shown on the giftee's race-day card. Long
// enough for the mapper's one-sentence refusals, short enough that a chatty
// line cannot take the card over.
const MESSAGE_LIMIT = 240; // chars
// How many trailing non-empty lines the message may carry (review finding 4).
// The refusal sentence is not always the LAST thing printed — the mapper runs
// deferred teardown after it — so the message quotes the tail, not one line.
//
// Residual (Opus re-verify, report a273a7cf1f0600542): six deferred Quit()
// calls run on the way out, three of which can print
// (pkg/config/controller.go:178, pkg/devices/controller.go:50,
// pkg/http/controller.go:161), and pkg/server/controller.go:165 PANICS on a
// Stop error — a full goroutine dump. Any of those could push the refusal
// out of a 3-line tail. Raised to 8: this reduces the risk but does not
// eliminate it (an unbounded dump can still outrun any fixed N) — see
// _lastLine()'s longest-line preference for the other half of the mitigation.
const MESSAGE_LINES = 8;

// Stop escalation (review correctness-5). A polite termination request is not a
// death: SIGTERM can be ignored, and on Windows the default signal only reaches
// the immediate process. So a requested stop that has not produced an 'exit'
// within ESCALATE_MS is escalated (SIGKILL on POSIX, `taskkill /pid <pid> /t /f`
// on Windows — the whole tree), and if the child is STILL there GIVE_UP_MS after
// that, the runner says so instead of pretending the stop worked.
const ESCALATE_MS = 2000;
const GIVE_UP_MS = 3000;

// Default Windows tree kill: the same argv main/runCommand.js already uses for a
// hung PowerShell child. Injected in tests, so no suite ever spawns taskkill.
const defaultKillTree = (pid) => runCommand('taskkill', winTreeKillArgs(pid), { timeoutMs: 10000 });

class MapperRunner {
    constructor({
        spawnFn = spawn,
        existsSync = fs.existsSync,
        env = process.env,
        log = () => {},
        platform = process.platform,
        killTree = defaultKillTree,
        schedule = (fn, ms) => setTimeout(fn, ms),
        cancelTimer = (h) => clearTimeout(h),
    } = {}) {
        this._spawn = spawnFn;
        this._existsSync = existsSync;
        this._env = env;
        this._log = log;
        this._platform = platform;
        this._killTree = killTree;
        this._schedule = schedule;
        this._cancelTimer = cancelTimer;
        this._proc = null;
        this._pid = null;
        this._exitCode = null;
        this._stoppedByUs = false;
        // A stop WE requested is in flight: the signal was delivered and the
        // child is on its way out. status() reports running:false immediately
        // from here (review lifecycle-concurrency-3) so the card's red STOP
        // button goes away on the press, not on the next one.
        this._stopping = false;
        // The stop was requested, escalated, and the child is STILL alive.
        this._stopFailed = false;
        this._stopTimer = null;
        // The last thing the child printed before dying on its own — the one
        // sentence the drive program itself gives the operator (an unfilled
        // profile prints exactly one and exits 1). null when we stopped it.
        this._exitMessage = null;
        this._ring = [];
        this._listeners = new Set();
    }

    // Child environment: the parent's, minus the ENTIRE W17_* namespace
    // (review blocker 2). The mapper reads its own experimental defaults from
    // W17_* variables — a bench machine carrying one would otherwise have
    // race day start the mapper with features the argv whitelist deliberately
    // never passes, an env-shaped bypass of that whitelist. Scrubbing the
    // CLASS (not an enumerated name list) means a future W17_* knob on either
    // side cannot silently reopen the hole. The launched mapper runs on its
    // committed profile + built-in defaults, nothing inherited from this app.
    //
    // The scrub itself now lives in shared/childEnv.js so the GRID convenience
    // launcher spawns with the SAME guarantee (review boundaries-4), and it
    // matches the W17_ prefix case-INSENSITIVELY because Windows environment
    // names are case-insensitive (review boundaries-5).
    _childEnv() {
        return scrubW17Env(this._env);
    }

    onChange(listener) {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    _emit() {
        const st = this.status();
        for (const listener of this._listeners) {
            try {
                listener(st);
            } catch (err) {
                this._log(`[mapper] state listener failed: ${err && err.message ? err.message : err}`);
            }
        }
    }

    _record(stream, chunk) {
        for (const raw of chunk.toString().split(/\r?\n/)) {
            const line = raw.trimEnd();
            if (!line) continue;
            this._ring.push(`[${stream}] ${line.slice(0, LINE_LIMIT)}`);
        }
        if (this._ring.length > RING_LIMIT) this._ring.splice(0, this._ring.length - RING_LIMIT);
    }

    // Start the managed child. `argv` comes from the orchestrator's pure
    // whitelist builder — this runner passes it through verbatim and adds
    // nothing. Results are soft-fail objects in the repo style; `kind` is
    // machine-readable for the plain-language view layer.
    start({ binaryPath, argv = [] } = {}) {
        if (this._proc) return { ok: false, kind: 'already-running', error: 'the mapper is already running' };
        if (!binaryPath) return { ok: false, kind: 'not-configured', error: 'no mapper path configured' };
        if (!this._existsSync(binaryPath)) return { ok: false, kind: 'not-found', error: `not found: ${binaryPath}` };
        let child;
        try {
            child = this._spawn(binaryPath, argv, {
                // 'ignore' in the first slot: the child has NO standard-input
                // handle — nothing here (or anywhere) can write to it. stdout/
                // stderr are piped ONLY into the bounded diagnostics ring.
                stdio: ['ignore', 'pipe', 'pipe'],
                cwd: path.dirname(binaryPath),
                // Scrubbed environment (review blocker 2): never the parent's
                // env verbatim — see _childEnv for the W17_* class scrub.
                env: this._childEnv(),
                // Race day is giftee-facing: never pop a console window at the
                // operator (the GRID convenience launcher shows one on purpose;
                // this managed run logs into the ring instead).
                windowsHide: true,
            });
        } catch (err) {
            return { ok: false, kind: 'spawn-failed', error: err.message };
        }
        this._proc = child;
        this._pid = child.pid ?? null;
        this._exitCode = null;
        this._stoppedByUs = false;
        this._clearStopTimer();
        this._stopping = false;
        this._stopFailed = false;
        this._exitMessage = null;
        this._ring = [];
        if (child.stdout) child.stdout.on('data', (d) => this._record('out', d));
        if (child.stderr) child.stderr.on('data', (d) => this._record('err', d));
        // 'error' fires for spawn failures surfaced asynchronously (ENOENT /
        // EACCES / a non-executable file) — and for THOSE, Node never fires
        // 'exit' at all (review blocker 1). Without the reset below the runner
        // claimed "running" forever after a failed spawn: the card lied, a
        // stop "succeeded" against nothing, and the retry was refused as
        // already-running. Identity-guarded so a late event from a replaced
        // child can never clobber a newer run's state.
        child.on('error', (err) => {
            if (this._proc !== child) return; // already settled or replaced — a stale child's noise stays out of the new run's ring
            this._record('err', `process error: ${err && err.message ? err.message : err}`);
            this._proc = null;
            this._settleStop();
            this._exitCode = 'spawn-error';
            this._exitMessage = this._lastLine();
            this._log('[mapper] process error with no exit (failed spawn) — treated as exited');
            this._emit();
        });
        child.on('exit', (code, signal) => {
            // The 'error' path above may have settled this child already, and
            // after a retry `this._proc` is a NEWER child — never touch state
            // that is not this child's own.
            if (this._proc !== child) return;
            this._proc = null;
            // The exit LANDED: whatever stop was in flight is genuinely done,
            // and any escalation timer must not fire against a dead pid (which
            // a later run could reuse).
            this._settleStop();
            this._exitCode = code ?? (signal ? `signal:${signal}` : null);
            // A death of its own carries the child's last line to the card;
            // a stop WE asked for carries nothing (there is nothing to explain).
            this._exitMessage = this._stoppedByUs ? null : this._lastLine();
            this._log(`[mapper] exited (${this._exitCode})${this._stoppedByUs ? ' — stopped by this app' : ''}`);
            this._emit();
        });
        this._log(`[mapper] started managed (pid ${this._pid}): ${binaryPath} ${argv.join(' ')}`);
        this._emit();
        return { ok: true, pid: this._pid };
    }

    // Clean stop (user STOP or app teardown). Marks the stop as OURS first so
    // the exit handler — and every liveness listener — can tell a requested
    // shutdown from a crash. Idempotent: stopping a stopped runner is a no-op,
    // and a stop already in flight is not signalled twice.
    //
    // Review correctness-5: kill() does NOT throw when the signal cannot be
    // delivered — it RETURNS FALSE (ESRCH: the pid is gone; EPERM: not ours to
    // signal, which also emits 'error' on the child, which this runner's own
    // handler would then read as an exit). The old code discarded that boolean
    // and reported every non-throwing kill as a clean stop.
    stop() {
        if (!this._proc) return { ok: true, stopped: false };
        // A stop is already on its way out; signalling again buys nothing and
        // would restart the escalation clock.
        if (this._stopping) return { ok: true, stopped: true, pending: true };
        const child = this._proc;
        this._stoppedByUs = true;
        let delivered;
        try {
            delivered = child.kill();
        } catch (err) {
            this._log(`[mapper] stop failed: ${err && err.message ? err.message : err}`);
            return { ok: false, kind: 'stop-failed', error: err.message };
        }
        if (delivered === false) {
            // The signal never reached the child (ESRCH / EPERM). Review
            // finding 3: the old code set `_stopping = true` here, which makes
            // status().running FALSE for the whole give-up window over a
            // process that is provably alive — the orchestrator's liveness
            // mirror drew an IDLE drive program for 3 s and only then flipped
            // to stop-failed. There is nothing to wait for: the request did not
            // land, so say so NOW. `_stopping` stays false, so `running` stays
            // true and the card keeps showing a live program with STOP on it.
            this._log('[mapper] stop signal was not delivered — the drive program is still there');
            this._stopFailed = true;
            // Still force the issue (SIGKILL / taskkill /t /f): a signal the
            // runtime could not deliver may yet be reachable through the tree
            // kill. If that works, the child's own 'exit' settles the stop and
            // clears `_stopFailed` — the report is honest either way.
            this._escalate(child);
            this._emit();
            return { ok: false, kind: 'stop-failed', error: 'the stop request did not reach the drive program' };
        }
        // Review lifecycle-concurrency-3: report running:false from HERE, on the
        // press, rather than waiting for the child's 'exit'. `_proc` stays set —
        // the escalation below still needs the handle.
        this._stopping = true;
        this._stopTimer = this._schedule(() => {
            this._stopTimer = null;
            this._escalate(child);
        }, ESCALATE_MS);
        this._emit();
        return { ok: true, stopped: true };
    }

    // Force the issue: SIGKILL on POSIX, the whole process TREE on Windows
    // (child.kill() reaches only the immediate process there). Then give the
    // OS a last window; if the child is STILL ours after it, say so instead of
    // leaving a stopped-looking card over a live drive program.
    _escalate(child) {
        if (this._proc !== child) return; // it exited on its own after all
        this._log('[mapper] the drive program did not stop on request — forcing it');
        try {
            if (this._platform === 'win32' && this._pid) {
                Promise.resolve(this._killTree(this._pid)).catch(() => {});
            } else {
                child.kill('SIGKILL');
            }
        } catch (err) {
            this._log(`[mapper] forced stop failed: ${err && err.message ? err.message : err}`);
        }
        this._clearStopTimer();
        this._stopTimer = this._schedule(() => {
            this._stopTimer = null;
            if (this._proc !== child) return;
            this._stopFailed = true;
            this._stopping = false; // it is alive: never report it as gone
            this._log('[mapper] the drive program is STILL running after a forced stop');
            this._emit();
        }, GIVE_UP_MS);
    }

    _clearStopTimer() {
        if (this._stopTimer !== null && this._stopTimer !== undefined) {
            this._cancelTimer(this._stopTimer);
            this._stopTimer = null;
        }
    }

    // The stop is over (the exit landed, or a fresh start replaced the child):
    // no escalation may fire against a pid the OS is free to reuse.
    _settleStop() {
        this._clearStopTimer();
        this._stopping = false;
        this._stopFailed = false;
    }

    // The child's own last WORDS, cleaned for display: the ring's newest
    // non-empty lines without their stream tags, control characters stripped,
    // whitespace collapsed, joined in the order the child printed them, the
    // whole thing capped. This is what the drive program said before it died —
    // on an unfilled profile the mapper prints one plain sentence and exits 1 —
    // and race day shows it verbatim rather than guessing at a cause
    // (orchestrator + shared/raceDayView.mjs).
    //
    // Review finding 4: taking only the LAST non-empty line lost that sentence
    // to anything printed after it, and the mapper runs six deferred Quit()
    // calls on its way out ("they only print on error" was never verified). The
    // last MESSAGE_LINES lines cost nothing and cannot lose it — and among
    // those, the longest line is featured first (see below) so the cap
    // truncates teardown noise, not the reason.
    _lastLine() {
        const picked = [];
        for (let i = this._ring.length - 1; i >= 0 && picked.length < MESSAGE_LINES; i -= 1) {
            const text = this._ring[i].replace(/^\[(?:out|err)\]\s*/, '')
                // A colourised child line must not drag its escape codes
                // onto the giftee's card: drop whole ANSI sequences first,
                // then any remaining control character (a stray CR, a NUL).
                .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
                .replace(/[\u0000-\u001f\u007f]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            if (text) picked.push(text);
        }
        if (!picked.length) return null;
        const ordered = picked.reverse(); // chronological order, oldest kept line first
        // Residual (Opus re-verify, report a273a7cf1f0600542): a plain-
        // English refusal sentence is almost always the LONGEST line in the
        // tail — teardown noise (deferred Quit() chatter, a goroutine dump's
        // stack fragments) runs short. Feature the longest line first so the
        // MESSAGE_LIMIT cap below truncates the noise, not the reason; ties
        // keep the earlier (chronologically first) line. The rest keep their
        // original order behind it.
        let longest = 0;
        for (let i = 1; i < ordered.length; i += 1) {
            if (ordered[i].length > ordered[longest].length) longest = i;
        }
        const featured = ordered[longest];
        const rest = ordered.filter((_, i) => i !== longest);
        return [featured, ...rest].join(' / ').slice(0, MESSAGE_LIMIT);
    }

    status() {
        return {
            // A stop WE requested makes this false immediately; a stop that
            // FAILED puts it back to true, because the program really is there.
            running: !!this._proc && !this._stopping,
            stopping: this._stopping,
            // The stop was requested, escalated, and the child outlived both.
            stopFailed: this._stopFailed,
            pid: this._pid,
            exitCode: this._exitCode,
            stoppedByUs: this._stoppedByUs,
            // Set only when the child died on its own; null otherwise.
            exitMessage: this._exitMessage,
        };
    }

    // Diagnostics tail (technician surface — the raceday:status answer). The
    // giftee UI never renders it; plain-language step lines carry their story.
    logTail() {
        return [...this._ring];
    }
}

module.exports = {
    MapperRunner, RING_LIMIT, LINE_LIMIT, MESSAGE_LIMIT, MESSAGE_LINES, ESCALATE_MS, GIVE_UP_MS,
};
