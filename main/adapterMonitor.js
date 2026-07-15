// Live WLAN adapter monitor (Windows observations #2/#3: an adapter plugged in
// while PIT WALL is open never appeared until the page was re-entered, and
// disconnection behavior was undefined). Runs in the MAIN process for the whole
// app lifetime — adapter truth must not be coupled to page navigation — and
// pushes a snapshot to the renderer only when membership or connection state
// actually changes.
//
// netsh has no adapter-arrival event the current abstraction can subscribe to
// (WifiManager is a thin netsh wrapper), so this is BOUNDED POLLING by design:
//  - one fixed interval, started/stopped idempotently (no duplicate timers);
//  - an in-flight listInterfaces call is never overlapped — a slow netsh just
//    stretches the effective period;
//  - a failing poll becomes an ok:false snapshot and polling CONTINUES (errors
//    never terminate monitoring);
//  - log lines only on TRANSITIONS (adapter added/removed, listing broke,
//    listing recovered) — a broken netsh cannot spam one line per tick.
//
// Adapter identity is the netsh interface NAME (stable per adapter on a
// machine; it is also what the persisted selection and every pinned netsh
// operation already key on). Snapshots carry a monotonic `seq` like the
// hotspot lifecycle's, so the renderer can drop out-of-order pushes.

const DEFAULT_INTERVAL_MS = 3000;

// Membership + connection signature. signalPct is deliberately EXCLUDED: it
// jitters every poll and would turn "emit on change" into "emit always".
const signatureOf = (ok, ifaces, error) => (ok
    ? ifaces.map((i) => `${i.name}\u0000${i.connected ? i.ssid : ''}`).join('\u0001')
    : `err:${error || ''}`);

function createAdapterMonitor({ wifi, intervalMs = DEFAULT_INTERVAL_MS, log = () => {} } = {}) {
    let timer = null;
    let inFlight = false;
    let seq = 0;
    // ok:null = never polled yet (renderer keeps its pull-based card until a
    // real snapshot arrives).
    let last = { seq: 0, ok: null, ifaces: [], error: null, added: [], removed: [] };
    let lastSignature = null;
    let lastOk = null; // for failed/recovered transition logging
    const listeners = new Set();

    const emit = (snap) => {
        for (const listener of listeners) {
            try {
                listener(snap);
            } catch (err) {
                log(`[adapters] listener failed: ${err && err.message ? err.message : err}`);
            }
        }
    };

    // Dedupe by name defensively (netsh should never repeat a block, but a
    // duplicate row in the UI is the failure mode we are guarding against).
    const dedupe = (ifaces) => {
        const seen = new Set();
        return ifaces.filter((i) => (seen.has(i.name) ? false : (seen.add(i.name), true)));
    };

    async function poll() {
        if (inFlight) return last;
        inFlight = true;
        try {
            const res = await wifi.listInterfaces();
            const ok = res.ok !== false;
            const ifaces = ok ? dedupe(res.ifaces || []) : [];
            const error = ok ? null : (res.error || 'adapter listing failed');
            const sig = signatureOf(ok, ifaces, error);
            if (sig !== lastSignature) {
                const prevNames = new Set((last.ifaces || []).map((i) => i.name));
                const names = new Set(ifaces.map((i) => i.name));
                const added = ifaces.filter((i) => !prevNames.has(i.name)).map((i) => i.name);
                const removed = [...prevNames].filter((n) => !names.has(n));
                seq += 1;
                last = { seq, ok, ifaces, error, added, removed };
                lastSignature = sig;
                if (ok && (added.length || removed.length)) {
                    log(`[adapters] change:${added.length ? ` +${added.join(', +')}` : ''}${removed.length ? ` -${removed.join(', -')}` : ''}`);
                }
                if (!ok && lastOk !== false) log(`[adapters] listing failed: ${error}`);
                if (ok && lastOk === false) log('[adapters] listing recovered');
                lastOk = ok;
                emit(last);
            } else {
                lastOk = ok;
            }
        } catch (err) {
            // listInterfaces soft-fails by contract; a rejection is plumbing
            // trouble. Same rules: controlled snapshot, keep polling, no spam.
            const error = `adapter monitor poll rejected: ${err && err.message ? err.message : err}`;
            if (lastOk !== false) log(`[adapters] ${error}`);
            const sig = signatureOf(false, [], error);
            if (sig !== lastSignature) {
                seq += 1;
                last = { seq, ok: false, ifaces: [], error, added: [], removed: (last.ifaces || []).map((i) => i.name) };
                lastSignature = sig;
                emit(last);
            }
            lastOk = false;
        } finally {
            inFlight = false;
        }
        return last;
    }

    return {
        // Idempotent: a second start is a no-op (no duplicate timers). The
        // first poll runs immediately so subscribers get truth without
        // waiting a full interval.
        start() {
            if (timer) return;
            timer = setInterval(poll, intervalMs);
            if (typeof timer.unref === 'function') timer.unref();
            poll();
        },
        // Idempotent disposal — page or app shutdown must be able to call it
        // unconditionally. An in-flight poll finishes but schedules nothing.
        stop() {
            if (timer) clearInterval(timer);
            timer = null;
        },
        running: () => !!timer,
        onChange(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        snapshot: () => last,
        // Manual immediate re-check (RESCAN); shares the in-flight guard.
        refresh: () => poll(),
    };
}

module.exports = { createAdapterMonitor, DEFAULT_INTERVAL_MS };
