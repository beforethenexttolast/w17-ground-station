import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MapperRunner, RING_LIMIT, LINE_LIMIT } = require('../main/mapperRunner.js');

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

    it('the child env is SCRUBBED: the whole W17_* class is stripped, everything else passes (review blocker 2)', () => {
        // The mapper's own experimental flags DEFAULT from W17_* env vars, so
        // inheriting the GS environment verbatim would be an env-shaped bypass
        // of the argv whitelist on any bench machine carrying such a var. The
        // scrub is by CLASS — a future W17_* knob is covered without a list edit.
        const { runner, spawned } = harness({
            env: {
                PATH: '/usr/bin',
                HOME: '/Users/pit',
                W17_HEADTRACK_INGEST: '1',
                W17_HEADTRACK: '1',
                W17_IPHONE_BRIDGE: '1',
                W17_WIFI_SIM: 'pixel',
                W17_ANY_FUTURE_KNOB: 'x',
            },
        });
        runner.start({ binaryPath: '/opt/w17/mapper', argv: [] });
        const opts = spawned[0].opts;
        // An env option MUST be present — absence means full inheritance.
        expect(opts.env).toBeDefined();
        expect(Object.keys(opts.env).filter((k) => k.startsWith('W17_'))).toEqual([]);
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
