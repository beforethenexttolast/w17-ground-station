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

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Bounded diagnostics ring: enough tail to diagnose a bad profile path or a
// port clash, small enough that a chatty child can never balloon memory.
const RING_LIMIT = 200; // lines kept
const LINE_LIMIT = 400; // chars kept per line

class MapperRunner {
    constructor({ spawnFn = spawn, existsSync = fs.existsSync, log = () => {} } = {}) {
        this._spawn = spawnFn;
        this._existsSync = existsSync;
        this._log = log;
        this._proc = null;
        this._pid = null;
        this._exitCode = null;
        this._stoppedByUs = false;
        this._ring = [];
        this._listeners = new Set();
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
        this._ring = [];
        if (child.stdout) child.stdout.on('data', (d) => this._record('out', d));
        if (child.stderr) child.stderr.on('data', (d) => this._record('err', d));
        // 'error' fires for spawn failures surfaced asynchronously (e.g. a
        // non-executable file on some platforms): record + treat as an exit.
        child.on('error', (err) => {
            this._record('err', `spawn error: ${err && err.message ? err.message : err}`);
        });
        child.on('exit', (code, signal) => {
            this._proc = null;
            this._exitCode = code ?? (signal ? `signal:${signal}` : null);
            this._log(`[mapper] exited (${this._exitCode})${this._stoppedByUs ? ' — stopped by this app' : ''}`);
            this._emit();
        });
        this._log(`[mapper] started managed (pid ${this._pid}): ${binaryPath} ${argv.join(' ')}`);
        this._emit();
        return { ok: true, pid: this._pid };
    }

    // Clean stop (user STOP or app teardown). Marks the stop as OURS first so
    // the exit handler — and every liveness listener — can tell a requested
    // shutdown from a crash. Idempotent: stopping a stopped runner is a no-op.
    stop() {
        if (!this._proc) return { ok: true, stopped: false };
        this._stoppedByUs = true;
        try {
            this._proc.kill();
        } catch (err) {
            this._log(`[mapper] stop failed: ${err && err.message ? err.message : err}`);
            return { ok: false, kind: 'stop-failed', error: err.message };
        }
        return { ok: true, stopped: true };
    }

    status() {
        return {
            running: !!this._proc,
            pid: this._pid,
            exitCode: this._exitCode,
            stoppedByUs: this._stoppedByUs,
        };
    }

    // Diagnostics tail (technician surface — the raceday:status answer). The
    // giftee UI never renders it; plain-language step lines carry their story.
    logTail() {
        return [...this._ring];
    }
}

module.exports = { MapperRunner, RING_LIMIT, LINE_LIMIT };
