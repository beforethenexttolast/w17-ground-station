import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  MapperRunner, RING_LIMIT, LINE_LIMIT, MESSAGE_LIMIT, MESSAGE_LINES,
} = require('../main/mapperRunner.js');

// Fake child seam: no real process is ever spawned in this suite (workspace
// rule — race-day tests run everywhere, including CI containers).
function fakeChild({ pid = 4242 } = {}) {
    const child = new EventEmitter();
    child.pid = pid;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn(() => {
        // Node semantics: kill() requests termination; 'exit' arrives async.
        setImmediate(() => child.emit('exit', null, 'SIGTERM'));
        return true;
    });
    return child;
}

function harness({ exists = true, pid = 4242, env } = {}) {
    const spawned = [];
    let child = null;
    const runner = new MapperRunner({
        spawnFn: (bin, argv, opts) => {
            child = fakeChild({ pid });
            spawned.push({ bin, argv, opts, child });
            return child;
        },
        existsSync: () => exists,
        ...(env ? { env } : {}),
    });
    return { runner, spawned, child: () => child };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('MapperRunner — managed start', () => {
    it('spawns the binary with the given argv, from its own directory, and reports running', () => {
        const { runner, spawned } = harness();
        const res = runner.start({ binaryPath: '/opt/w17/mapper', argv: ['-config-file-path', '/opt/w17/w17.json'] });
        expect(res).toEqual({ ok: true, pid: 4242 });
        expect(spawned).toHaveLength(1);
        expect(spawned[0].bin).toBe('/opt/w17/mapper');
        expect(spawned[0].argv).toEqual(['-config-file-path', '/opt/w17/w17.json']);
        expect(spawned[0].opts.cwd).toBe('/opt/w17');
        expect(runner.status()).toMatchObject({ running: true, pid: 4242, exitCode: null });
    });

    it('the spawn is lifecycle-only by construction: no stdin handle, no IPC slot, hidden window', () => {
        const { runner, spawned } = harness();
        runner.start({ binaryPath: '/opt/w17/mapper', argv: [] });
        const opts = spawned[0].opts;
        // First stdio slot 'ignore' = the child has NO writable standard input;
        // out/err are pipes into the bounded ring; there is NO fourth 'ipc' slot.
        expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
        // Giftee-facing: the managed mapper never pops a console window.
        expect(opts.windowsHide).toBe(true);
        // NOT detached: a dead ground station must never orphan a managed child
        // silently (teardown stops it; the GRID convenience launcher is the
        // deliberate detached path).
        expect(opts.detached).toBeUndefined();
    });

    it('the child env is SCRUBBED: the whole W17_* class is stripped in ANY letter case, everything else passes (review blocker 2 / boundaries-5)', () => {
        // The mapper's own experimental flags DEFAULT from W17_* env vars, so
        // inheriting the GS environment verbatim would be an env-shaped bypass
        // of the argv whitelist on any bench machine carrying such a var. The
        // scrub is by CLASS — a future W17_* knob is covered without a list edit.
        //
        // The case variants are the boundaries-5 regression: the gift target is
        // Windows, whose environment names are case-INSENSITIVE, so
        // `set w17_headtrack_ingest=1` reaches a Windows child as the same
        // variable an uppercase spelling would. A case-SENSITIVE prefix test let
        // exactly that spelling through.
        const { runner, spawned } = harness({
            env: {
                PATH: '/usr/bin',
                HOME: '/Users/pit',
                W17_HEADTRACK_INGEST: '1',
                W17_HEADTRACK: '1',
                W17_IPHONE_BRIDGE: '1',
                W17_WIFI_SIM: 'pixel',
                W17_ANY_FUTURE_KNOB: 'x',
                w17_headtrack_ingest: '1',
                W17_HeadTrack_Ingest: '1',
                w17_any_future_knob: 'x',
            },
        });
        runner.start({ binaryPath: '/opt/w17/mapper', argv: [] });
        const opts = spawned[0].opts;
        // An env option MUST be present — absence means full inheritance.
        expect(opts.env).toBeDefined();
        // Case-INSENSITIVE assertion: no spelling of the namespace survives.
        expect(Object.keys(opts.env).filter((k) => k.toUpperCase().startsWith('W17_'))).toEqual([]);
        // Non-W17 vars survive (the mapper still needs PATH etc. to run).
        expect(opts.env.PATH).toBe('/usr/bin');
        expect(opts.env.HOME).toBe('/Users/pit');
    });

    it('soft-fails without spawning: no path, missing binary, already running', () => {
        const missing = harness({ exists: false });
        expect(missing.runner.start({ binaryPath: '/nope' })).toMatchObject({ ok: false, kind: 'not-found' });
        expect(missing.spawned).toHaveLength(0);

        const { runner, spawned } = harness();
        expect(runner.start({})).toMatchObject({ ok: false, kind: 'not-configured' });
        runner.start({ binaryPath: '/opt/w17/mapper' });
        expect(runner.start({ binaryPath: '/opt/w17/mapper' })).toMatchObject({ ok: false, kind: 'already-running' });
        expect(spawned).toHaveLength(1); // the duplicate start spawned nothing
    });

    it('a throwing spawn becomes a controlled spawn-failed result, never an exception', () => {
        const runner = new MapperRunner({
            spawnFn: () => { throw new Error('EACCES'); },
            existsSync: () => true,
        });
        expect(runner.start({ binaryPath: '/opt/w17/mapper' })).toEqual({ ok: false, kind: 'spawn-failed', error: 'EACCES' });
        expect(runner.status().running).toBe(false);
    });
});

describe('MapperRunner — liveness and stop', () => {
    it('an exit flips status to not-running with the code, and notifies listeners', async () => {
        const { runner, child } = harness();
        const seen = [];
        runner.onChange((st) => seen.push(st));
        runner.start({ binaryPath: '/opt/w17/mapper' });
        child().emit('exit', 3, null);
        await tick();
        expect(runner.status()).toMatchObject({ running: false, exitCode: 3, stoppedByUs: false });
        // start emitted once (running), exit emitted once (stopped).
        expect(seen.map((s) => s.running)).toEqual([true, false]);
    });

    it('stop() kills the child and the exit is marked as OURS (a crash is not)', async () => {
        const { runner, child } = harness();
        runner.start({ binaryPath: '/opt/w17/mapper' });
        const res = runner.stop();
        expect(res).toEqual({ ok: true, stopped: true });
        expect(child().kill).toHaveBeenCalledTimes(1);
        await tick();
        expect(runner.status()).toMatchObject({ running: false, stoppedByUs: true });
    });

    it('stop() is idempotent: stopping a never-started or already-stopped runner is a clean no-op', async () => {
        const { runner } = harness();
        expect(runner.stop()).toEqual({ ok: true, stopped: false });
        runner.start({ binaryPath: '/opt/w17/mapper' });
        runner.stop();
        await tick();
        expect(runner.stop()).toEqual({ ok: true, stopped: false });
    });

    it('a restart after exit works and resets exit state (the retry path)', async () => {
        const { runner, child, spawned } = harness();
        runner.start({ binaryPath: '/opt/w17/mapper' });
        child().emit('exit', 1, null);
        await tick();
        const res = runner.start({ binaryPath: '/opt/w17/mapper' });
        expect(res.ok).toBe(true);
        expect(spawned).toHaveLength(2);
        expect(runner.status()).toMatchObject({ running: true, exitCode: null, stoppedByUs: false });
    });
});

// Review blocker 1: an async spawn failure (ENOENT/EACCES/non-executable
// file) fires 'error' and NEVER 'exit'. The old handler only recorded to the
// ring, so the runner claimed running forever: the card lied, stop()
// "succeeded" against nothing, and the retry was refused as already-running.
describe('MapperRunner — a failed spawn that fires error with NO exit (review blocker 1)', () => {
    it('flips to not-running with the spawn-error code and notifies listeners', () => {
        const { runner, child } = harness();
        const seen = [];
        runner.onChange((st) => seen.push(st));
        runner.start({ binaryPath: '/opt/w17/not-executable' });
        child().emit('error', new Error('spawn EACCES'));
        // no 'exit' ever arrives — that IS the reproduced defect shape
        expect(runner.status()).toMatchObject({ running: false, exitCode: 'spawn-error', stoppedByUs: false });
        expect(seen.map((s) => s.running)).toEqual([true, false]);
        // The failure detail landed in the diagnostics ring for the technician.
        expect(runner.logTail().some((l) => l.includes('spawn EACCES'))).toBe(true);
    });

    it('stop() after the error is a truthful no-op — never a claimed kill of a dead child', () => {
        const { runner, child } = harness();
        runner.start({ binaryPath: '/opt/w17/not-executable' });
        child().emit('error', new Error('spawn ENOENT'));
        expect(runner.stop()).toEqual({ ok: true, stopped: false });
        expect(child().kill).not.toHaveBeenCalled();
    });

    it('the retry respawns instead of being refused as already-running', () => {
        const { runner, child, spawned } = harness();
        runner.start({ binaryPath: '/opt/w17/mapper' });
        child().emit('error', new Error('spawn EACCES'));
        const res = runner.start({ binaryPath: '/opt/w17/mapper' });
        expect(res.ok).toBe(true);
        expect(spawned).toHaveLength(2);
        expect(runner.status()).toMatchObject({ running: true, exitCode: null });
    });

    it('handlers are identity-guarded: a stale event from a replaced child never clobbers the new run', () => {
        const { runner, spawned } = harness();
        runner.start({ binaryPath: '/opt/w17/mapper' });
        const first = spawned[0].child;
        first.emit('error', new Error('spawn EACCES')); // settles run 1
        runner.start({ binaryPath: '/opt/w17/mapper' }); // run 2 alive
        // Late duplicate events from the DEAD first child arrive afterwards.
        first.emit('exit', 1, null);
        first.emit('error', new Error('late'));
        expect(runner.status()).toMatchObject({ running: true, exitCode: null });
        expect(spawned).toHaveLength(2);
    });

    it('error followed by a real exit emits exactly one state flip (no double transition)', () => {
        const { runner, child } = harness();
        const seen = [];
        runner.onChange((st) => seen.push(st));
        runner.start({ binaryPath: '/opt/w17/mapper' });
        child().emit('error', new Error('boom'));
        child().emit('exit', 1, null); // some platforms fire both
        expect(seen.map((s) => s.running)).toEqual([true, false]);
        expect(runner.status().exitCode).toBe('spawn-error'); // first settlement wins
    });
});

describe('MapperRunner — bounded diagnostics ring', () => {
    it('captures stdout and stderr lines, tagged by stream', () => {
        const { runner, child } = harness();
        runner.start({ binaryPath: '/opt/w17/mapper' });
        child().stdout.emit('data', Buffer.from('listening on :3000\npartial'));
        child().stderr.emit('data', Buffer.from('WARN low battery\n'));
        expect(runner.logTail()).toEqual([
            '[out] listening on :3000',
            '[out] partial',
            '[err] WARN low battery',
        ]);
    });

    it('the ring is bounded in LINES and per-line LENGTH — a chatty child cannot balloon memory', () => {
        const { runner, child } = harness();
        runner.start({ binaryPath: '/opt/w17/mapper' });
        for (let i = 0; i < RING_LIMIT + 50; i += 1) {
            child().stdout.emit('data', Buffer.from(`line ${i}\n`));
        }
        child().stdout.emit('data', Buffer.from(`${'x'.repeat(LINE_LIMIT * 3)}\n`));
        const tail = runner.logTail();
        expect(tail.length).toBeLessThanOrEqual(RING_LIMIT);
        // Oldest lines dropped, newest kept.
        expect(tail[tail.length - 1].length).toBeLessThanOrEqual(LINE_LIMIT + '[out] '.length);
        expect(tail[tail.length - 2]).toBe(`[out] line ${RING_LIMIT + 49}`);
    });

    it('a fresh start clears the previous run\'s ring (diagnostics belong to THIS run)', async () => {
        const { runner, child } = harness();
        runner.start({ binaryPath: '/opt/w17/mapper' });
        child().stdout.emit('data', Buffer.from('old run\n'));
        child().emit('exit', 0, null);
        await tick();
        runner.start({ binaryPath: '/opt/w17/mapper' });
        expect(runner.logTail()).toEqual([]);
    });

    it('logTail() returns a copy — a caller cannot mutate the ring', () => {
        const { runner, child } = harness();
        runner.start({ binaryPath: '/opt/w17/mapper' });
        child().stdout.emit('data', Buffer.from('a\n'));
        runner.logTail().push('injected');
        expect(runner.logTail()).toEqual(['[out] a']);
    });
});

// --- Review correctness-5 + lifecycle-concurrency-3: stop TRUTH -------------
// Two defects with one shape: the runner said things about the stop that were
// not so. kill() returns FALSE when the signal was not delivered (ESRCH/EPERM)
// and the boolean was discarded, so a kill that never landed read as a clean
// stop; and the card was told nothing until the child's 'exit' arrived, so the
// red STOP button survived its own press.
//
// A manual clock: no timer in this suite is real, so escalation is exercised
// deterministically and `taskkill` is a spy — nothing is ever spawned.
function clockHarness({ deliver = true, platform = 'linux' } = {}) {
    const timers = new Map();
    let nextId = 1;
    let child = null;
    const killTree = vi.fn(() => Promise.resolve({ ok: true }));
    const logs = [];
    const runner = new MapperRunner({
        spawnFn: () => {
            child = new EventEmitter();
            child.pid = 4242;
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            // Deliberately does NOT exit: this harness drives the stop clock.
            child.kill = vi.fn(() => deliver);
            return child;
        },
        existsSync: () => true,
        platform,
        killTree,
        schedule: (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; },
        cancelTimer: (id) => timers.delete(id),
        log: (m) => logs.push(m),
    });
    const seen = [];
    // Fire every timer currently pending (one generation at a time, so an
    // escalation that arms the next timer does not run away).
    const fire = () => {
        const due = [...timers.entries()];
        timers.clear();
        for (const [, t] of due) t.fn();
    };
    runner.onChange((st) => seen.push(st));
    return {
        runner, killTree, logs, fire, seen, child: () => child, pending: () => timers.size,
    };
}

describe('MapperRunner — stop truth (review correctness-5 / lifecycle-concurrency-3)', () => {
    it('lifecycle-concurrency-3: a requested stop reports running:false ON THE PRESS, not on the exit', () => {
        const { runner, child } = clockHarness();
        const seen = [];
        runner.start({ binaryPath: '/opt/w17/mapper' });
        runner.onChange((st) => seen.push(st));
        expect(runner.status().running).toBe(true);
        const res = runner.stop();
        expect(res).toEqual({ ok: true, stopped: true });
        // The child has NOT exited yet (no 'exit' emitted) …
        expect(child().kill).toHaveBeenCalledTimes(1);
        // … and the card is already told, which is what makes the red STOP
        // button disappear on the press instead of on the next one.
        expect(runner.status()).toMatchObject({ running: false, stopping: true, stopFailed: false });
        expect(seen).toHaveLength(1);
        expect(seen[0].running).toBe(false);
    });

    it('a second stop while one is in flight does not re-signal the child', () => {
        const { runner, child } = clockHarness();
        runner.start({ binaryPath: '/opt/w17/mapper' });
        runner.stop();
        expect(runner.stop()).toEqual({ ok: true, stopped: true, pending: true });
        expect(child().kill).toHaveBeenCalledTimes(1);
    });

    it('correctness-5: kill() returning FALSE is a FAILED stop, not a clean one', () => {
        const { runner, seen } = clockHarness({ deliver: false });
        runner.start({ binaryPath: '/opt/w17/mapper' });
        const res = runner.stop();
        expect(res.ok).toBe(false);
        expect(res.kind).toBe('stop-failed');
        // Review finding 3: the failure is reported IMMEDIATELY. The old code
        // set `stopping` here, which made running:false for the whole give-up
        // window over a provably live process — the card drew an idle drive
        // program for 3 s and only then told the truth. There is nothing to
        // wait for: the signal did not land.
        expect(runner.status()).toMatchObject({ running: true, stopping: false, stopFailed: true });
        expect(seen[seen.length - 1]).toMatchObject({ running: true, stopFailed: true });
    });

    it('an undelivered stop still forces the issue, and a child that then dies clears the failure', () => {
        const { runner, child, fire } = clockHarness({ deliver: false });
        runner.start({ binaryPath: '/opt/w17/mapper' });
        runner.stop();
        // The escalation ran at once (no polite window to wait out).
        expect(child().kill).toHaveBeenLastCalledWith('SIGKILL');
        expect(runner.status().stopFailed).toBe(true);
        child().emit('exit', null, 'SIGKILL');
        expect(runner.status()).toMatchObject({ running: false, stopFailed: false, stopping: false });
        fire(); // the give-up timer must not fire against a settled stop
        expect(runner.status().stopFailed).toBe(false);
    });

    it('correctness-5: a stop the child ignores escalates to SIGKILL, then says so instead of lying', () => {
        const { runner, child, fire } = clockHarness();
        runner.start({ binaryPath: '/opt/w17/mapper' });
        runner.stop();
        expect(child().kill).toHaveBeenCalledTimes(1);
        fire(); // ESCALATE_MS
        expect(child().kill).toHaveBeenCalledTimes(2);
        expect(child().kill).toHaveBeenLastCalledWith('SIGKILL');
        // Still no exit: the give-up window closes and the runner reports the
        // program as ALIVE again — the card must never show a stopped state
        // over a live drive program.
        fire(); // GIVE_UP_MS
        expect(runner.status()).toMatchObject({ running: true, stopping: false, stopFailed: true });
    });

    it('on Windows the escalation is a process-TREE kill, never a bare signal', () => {
        const { runner, killTree, child, fire } = clockHarness({ platform: 'win32' });
        runner.start({ binaryPath: '/opt/w17/mapper' });
        runner.stop();
        fire();
        expect(killTree).toHaveBeenCalledWith(4242);
        // The bare kill() was the polite request only — no second signal.
        expect(child().kill).toHaveBeenCalledTimes(1);
    });

    it('an exit that lands first cancels the escalation (a reused pid is never signalled)', () => {
        const { runner, child, killTree, pending } = clockHarness({ platform: 'win32' });
        runner.start({ binaryPath: '/opt/w17/mapper' });
        runner.stop();
        expect(pending()).toBe(1);
        child().emit('exit', null, 'SIGTERM');
        expect(pending()).toBe(0);
        expect(killTree).not.toHaveBeenCalled();
        expect(runner.status()).toMatchObject({ running: false, stopping: false, stopFailed: false, stoppedByUs: true });
    });

    it('a stop-failed runner recovers honestly if the child does finally die', () => {
        const { runner, child, fire } = clockHarness();
        runner.start({ binaryPath: '/opt/w17/mapper' });
        runner.stop();
        fire();
        fire();
        expect(runner.status().stopFailed).toBe(true);
        child().emit('exit', null, 'SIGKILL');
        expect(runner.status()).toMatchObject({ running: false, stopFailed: false, stopping: false });
    });
});

// --- The child's own last word (orchestrator addition, mapper branch A) -----
// The mapper now exits 1 with ONE plain sentence when the saved profile still
// carries its REPLACE-WITH-* placeholders. Race day must be able to show that
// sentence: "stopped on its own — press RACE DAY to bring it back" would send
// the operator round a loop that can never succeed.
describe('MapperRunner — the exit message the child itself printed', () => {
    it('carries the last line of a self-death, cleaned of stream tag and control characters', async () => {
        const { runner, child } = harness();
        runner.start({ binaryPath: '/opt/w17/mapper' });
        child().stdout.emit('data', Buffer.from(
            '\x1b[31mthis saved profile has not been matched to this computer yet\x1b[0m\n',
        ));
        child().emit('exit', 1, null);
        await tick();
        expect(runner.status().exitMessage)
            .toBe('this saved profile has not been matched to this computer yet');
        expect(runner.status().exitCode).toBe(1);
    });

    it('a stop WE asked for carries no message (there is nothing to explain)', async () => {
        const { runner, child } = harness();
        runner.start({ binaryPath: '/opt/w17/mapper' });
        child().stdout.emit('data', Buffer.from('listening\n'));
        runner.stop();
        await tick();
        expect(runner.status().exitMessage).toBeNull();
    });

    it('a silent death carries null, and a long line is capped', async () => {
        const { runner, child } = harness();
        runner.start({ binaryPath: '/opt/w17/mapper' });
        child().emit('exit', 1, null);
        await tick();
        expect(runner.status().exitMessage).toBeNull();

        runner.start({ binaryPath: '/opt/w17/mapper' });
        child().stdout.emit('data', Buffer.from(`${'x'.repeat(1000)}\n`));
        child().emit('exit', 1, null);
        await tick();
        expect(runner.status().exitMessage).toHaveLength(MESSAGE_LIMIT);
    });

    // Review finding 4: the mapper prints its refusal at
    // cmd/elrs-joystick-control/main.go:190 and THEN runs six deferred Quit()
    // calls. "Only the last non-empty line" handed the card whatever those
    // printed; the message quotes the tail instead, so the sentence survives.
    it('a refusal followed by teardown noise still carries the refusal', async () => {
        const { runner, child } = harness();
        runner.start({ binaryPath: '/opt/w17/mapper' });
        child().stdout.emit('data', Buffer.from(
            'this saved profile has not been matched to this computer yet\n',
        ));
        child().stderr.emit('data', Buffer.from('some trailing noise\nand more\n'));
        child().emit('exit', 1, null);
        await tick();
        const msg = runner.status().exitMessage;
        expect(msg).toContain('this saved profile has not been matched to this computer yet');
        expect(msg).toBe('this saved profile has not been matched to this computer yet / some trailing noise / and more');
    });

    it('quotes at most the last MESSAGE_LINES lines, longest featured first, rest kept in order', async () => {
        const { runner, child } = harness();
        expect(MESSAGE_LINES).toBe(8);
        runner.start({ binaryPath: '/opt/w17/mapper' });
        // 10 lines printed, only the last 8 non-empty ones survive the ring
        // walk ('one' and 'two' fall off) — 'sixsixsix' is the longest of
        // those eight and is featured first even though it is neither the
        // oldest nor the newest of the kept lines; the rest keep their
        // original chronological order behind it.
        child().stdout.emit('data', Buffer.from(
            'one\ntwo\nthree\nfour\nfive\nsixsixsix\nseven\neight\nnine\nten\n',
        ));
        child().emit('exit', 1, null);
        await tick();
        expect(runner.status().exitMessage)
            .toBe('sixsixsix / three / four / five / seven / eight / nine / ten');

        runner.start({ binaryPath: '/opt/w17/mapper' });
        child().stdout.emit('data', Buffer.from(`${'x'.repeat(200)}\n${'y'.repeat(200)}\n`));
        child().emit('exit', 1, null);
        await tick();
        const capped = runner.status().exitMessage;
        expect(capped).toHaveLength(MESSAGE_LIMIT);
        // The two lines tie in length; the featured (first-on-tie) one is the
        // chronologically earlier 'x' line, so truncation still eats the tail.
        expect(capped.startsWith('x'.repeat(200))).toBe(true);
    });

    // Residual (Opus re-verify, report a273a7cf1f0600542): the review found
    // the teardown can print through three of six deferred Quit()s
    // (pkg/config/controller.go:178, pkg/devices/controller.go:50,
    // pkg/http/controller.go:161) after the refusal, and
    // pkg/server/controller.go:165 PANICS on a Stop error — a full goroutine
    // dump. With the old MESSAGE_LINES=3 a dump this size would have pushed
    // the refusal out of the tail entirely; at 8, it survives, and the
    // longest-line preference puts it first regardless of where the dump
    // truncates.
    it('a refusal followed by a goroutine dump still leads the message (MESSAGE_LINES=8)', async () => {
        const { runner, child } = harness();
        runner.start({ binaryPath: '/opt/w17/mapper' });
        child().stdout.emit('data', Buffer.from(
            'this saved profile has not been matched to this computer yet\n',
        ));
        child().stderr.emit('data', Buffer.from(
            'panic: stop called twice\n'
            + 'goroutine 1 [running]:\n'
            + 'main.(*Controller).Stop(...)\n'
            + 'controller.go:165 +0x2a4\n'
            + 'created by main.main\n',
        ));
        child().emit('exit', 2, null);
        await tick();
        const msg = runner.status().exitMessage;
        // The old 3-line tail would have carried none of this sentence.
        expect(msg.startsWith('this saved profile has not been matched to this computer yet')).toBe(true);
        expect(msg).toContain('panic: stop called twice');
        expect(msg).toContain('created by main.main');
    });

    it('a fresh start clears the previous run\'s message', async () => {
        const { runner, child } = harness();
        runner.start({ binaryPath: '/opt/w17/mapper' });
        child().stdout.emit('data', Buffer.from('bad profile\n'));
        child().emit('exit', 1, null);
        await tick();
        expect(runner.status().exitMessage).toBe('bad profile');
        runner.start({ binaryPath: '/opt/w17/mapper' });
        expect(runner.status().exitMessage).toBeNull();
    });
});
