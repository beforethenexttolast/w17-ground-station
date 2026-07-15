// The MAIN-process head-intent diagnostics consumer (CB8 slice 3B). Exercised
// with a FAKE gRPC call (an .on/.cancel emitter) and fake timers — no real grpc,
// no live mapper — so the reconnect/backoff/state-mapping and the display-only
// guarantees are pinned deterministically.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { HeadIntentDiagnosticsClient, CONN } = require('../main/HeadIntentDiagnosticsClient.js');

// gRPC status codes used by the mapper's diagnostics stream.
const UNAVAILABLE = 14;
const RESOURCE_EXHAUSTED = 8;
const CANCELLED = 1;

function harness({ backoff } = {}) {
    const broadcasts = [];
    const timers = [];   // { fn, ms } scheduled reconnects (null once fired/cancelled)
    const calls = [];    // every fake call the client opened
    let now = 1000;

    const makeCall = () => {
        const handlers = {};
        const call = {
            writes: 0,           // a write would be a control path — must stay 0
            cancelled: 0,
            on(ev, fn) { handlers[ev] = fn; return call; },
            cancel() { this.cancelled += 1; },
            write() { this.writes += 1; },      // present so a stray write is observable
            emit(ev, arg) { if (handlers[ev]) handlers[ev](arg); },
            has(ev) { return typeof handlers[ev] === 'function'; },
        };
        calls.push(call);
        return call;
    };

    let connectImpl = () => makeCall();
    const client = new HeadIntentDiagnosticsClient({
        connect: () => connectImpl(),
        broadcast: (s) => broadcasts.push(s),
        clock: () => now,
        schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
        cancel: (h) => { if (timers[h]) timers[h] = null; },
        log: () => {},
        backoff,
    });

    return {
        client, broadcasts, timers, calls,
        setConnect: (fn) => { connectImpl = fn; },
        current: () => calls[calls.length - 1],
        pendingTimers: () => timers.filter(Boolean),
        // Fire the most recently scheduled (still-pending) reconnect timer.
        fireReconnect() {
            for (let i = timers.length - 1; i >= 0; i -= 1) {
                if (timers[i]) { const t = timers[i]; timers[i] = null; t.fn(); return t.ms; }
            }
            throw new Error('no pending reconnect timer');
        },
    };
}

const diag = (state, extra = {}) => ({ state, has_last_valid: true, receive_age_ms: 10, ...extra });

describe('HeadIntentDiagnosticsClient — construction guard', () => {
    it('requires a connect() function', () => {
        expect(() => new HeadIntentDiagnosticsClient({})).toThrow(/connect/);
    });
});

describe('HeadIntentDiagnosticsClient — stream consumption (display-only)', () => {
    it('start opens exactly one stream and broadcasts connecting', () => {
        const h = harness();
        h.client.start();
        expect(h.calls.length).toBe(1);
        expect(h.current().has('data')).toBe(true);
        expect(h.broadcasts.at(-1)).toMatchObject({ connection: CONN.connecting, diagnostics: null });
    });

    it('a data frame is forwarded VERBATIM with connection=live (no reinterpretation)', () => {
        const h = harness();
        h.client.start();
        const msg = diag('HEAD_INTENT_STATE_ACTIVE_LOG_ONLY', { yaw_deg: -12.5, receive_age_ms: 37 });
        h.current().emit('data', msg);
        const last = h.broadcasts.at(-1);
        expect(last.connection).toBe(CONN.live);
        expect(last.diagnostics).toBe(msg); // same object — nothing recomputed or copied over
    });

    it('start is idempotent — a second start does not open a second stream', () => {
        const h = harness();
        h.client.start();
        h.client.start();
        expect(h.calls.length).toBe(1);
    });
});

describe('HeadIntentDiagnosticsClient — reconnect with bounded backoff', () => {
    it('a clean stream end schedules a reconnect and reopens', () => {
        const h = harness();
        h.client.start();
        h.current().emit('end');
        expect(h.broadcasts.at(-1).connection).toBe(CONN.error);
        expect(h.pendingTimers().length).toBe(1);
        h.fireReconnect();
        expect(h.calls.length).toBe(2); // reopened
        expect(h.broadcasts.at(-1).connection).toBe(CONN.connecting);
    });

    it('backoff grows per consecutive failure and RESETS after a healthy frame', () => {
        const h = harness({ backoff: { baseMs: 500, factorMax: 10_000 } });
        h.client.start();
        h.current().emit('error', { code: UNAVAILABLE });
        expect(h.fireReconnect()).toBe(500);   // attempt 1
        h.current().emit('error', { code: UNAVAILABLE });
        expect(h.fireReconnect()).toBe(1000);  // attempt 2
        h.current().emit('error', { code: UNAVAILABLE });
        expect(h.fireReconnect()).toBe(2000);  // attempt 3
        // A good frame resets the backoff clock.
        h.current().emit('data', diag('HEAD_INTENT_STATE_IDLE'));
        h.current().emit('error', { code: UNAVAILABLE });
        expect(h.fireReconnect()).toBe(500);   // back to attempt 1
    });

    it('backoff is capped (a long outage never schedules an unbounded delay)', () => {
        const h = harness({ backoff: { baseMs: 500, factorMax: 10_000 } });
        h.client.start();
        let last = 0;
        for (let i = 0; i < 8; i += 1) {
            h.current().emit('error', { code: UNAVAILABLE });
            last = h.fireReconnect();
        }
        expect(last).toBe(10_000);
    });
});

describe('HeadIntentDiagnosticsClient — server states surfaced as display, not crashes', () => {
    it('UNAVAILABLE (ingest disabled / mapper down) renders as a display state and keeps retrying', () => {
        const h = harness();
        h.client.start();
        h.current().emit('error', { code: UNAVAILABLE, details: 'ingest disabled' });
        expect(h.broadcasts.at(-1).connection).toBe(CONN.unavailable);
        expect(h.pendingTimers().length).toBe(1); // still retrying — mapper may enable ingest later
    });

    it('RESOURCE_EXHAUSTED (mapper 4-stream cap) renders as a display state and keeps retrying', () => {
        const h = harness();
        h.client.start();
        h.current().emit('error', { code: RESOURCE_EXHAUSTED });
        expect(h.broadcasts.at(-1).connection).toBe(CONN.exhausted);
        expect(h.pendingTimers().length).toBe(1); // a slot may free up
    });

    it('an unmapped error code surfaces as a generic stream-error and reconnects', () => {
        const h = harness();
        h.client.start();
        h.current().emit('error', { code: 2, message: 'boom' });
        expect(h.broadcasts.at(-1).connection).toBe(CONN.error);
        expect(h.pendingTimers().length).toBe(1);
    });

    it('error then end in one cycle schedules only ONE reconnect (no double-open)', () => {
        const h = harness();
        h.client.start();
        const call = h.current();
        call.emit('error', { code: UNAVAILABLE });
        call.emit('end'); // late/duplicate terminal event — must be ignored
        expect(h.pendingTimers().length).toBe(1);
    });
});

describe('HeadIntentDiagnosticsClient — stop() is a clean, reconnect-free shutdown', () => {
    it('cancels the live call, clears the reconnect, and stops broadcasting live', () => {
        const h = harness();
        h.client.start();
        const call = h.current();
        h.client.stop();
        expect(call.cancelled).toBe(1);
        expect(h.pendingTimers().length).toBe(0);
        expect(h.broadcasts.at(-1).connection).toBe(CONN.stopped);
    });

    it('our own cancel surfacing as CANCELLED does NOT trigger a reconnect', () => {
        const h = harness();
        h.client.start();
        const call = h.current();
        h.client.stop();
        call.emit('error', { code: CANCELLED }); // grpc emits this after cancel()
        expect(h.pendingTimers().length).toBe(0);
        expect(h.calls.length).toBe(1);
    });

    it('stop() while a reconnect is pending clears the timer (no zombie reopen)', () => {
        const h = harness();
        h.client.start();
        h.current().emit('error', { code: UNAVAILABLE });
        expect(h.pendingTimers().length).toBe(1);
        h.client.stop();
        expect(h.pendingTimers().length).toBe(0);
    });
});

describe('HeadIntentDiagnosticsClient — NO control path (guard)', () => {
    it('the public surface is start/stop/connectionState only — no setter, no emitter', () => {
        const h = harness();
        const api = Object.getOwnPropertyNames(Object.getPrototypeOf(h.client))
            .filter((n) => n !== 'constructor' && !n.startsWith('_'));
        expect(api.sort()).toEqual(['connectionState', 'start', 'stop']);
    });

    it('the client NEVER writes to the gRPC call — it only reads (.on) and cancels', () => {
        const h = harness();
        h.client.start();
        h.current().emit('data', diag('HEAD_INTENT_STATE_ACTIVE_LOG_ONLY'));
        h.current().emit('error', { code: UNAVAILABLE });
        h.fireReconnect();
        h.client.stop();
        // Not one write on any call the client opened across its whole lifecycle.
        expect(h.calls.every((c) => c.writes === 0)).toBe(true);
        expect(h.calls.some((c) => c.cancelled > 0)).toBe(true); // it does cancel to stop
    });

    it('the ONLY external output is the broadcast — it takes no renderer input', () => {
        // The constructor accepts a broadcast SINK and a connect SOURCE; there is
        // no injected "receive from renderer" seam anywhere on the instance.
        const broadcast = vi.fn();
        const client = new HeadIntentDiagnosticsClient({ connect: () => ({ on() {}, cancel() {} }), broadcast });
        client.start();
        expect(broadcast).toHaveBeenCalled(); // it emits...
        // ...and exposes no method that could send toward the mapper.
        for (const forbidden of ['send', 'write', 'set', 'onCommand', 'ingest']) {
            expect(typeof client[forbidden]).toBe('undefined');
        }
    });
});
