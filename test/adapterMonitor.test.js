// main/adapterMonitor.js — the live WLAN adapter monitor (2B/2C, Windows
// observations #2/#3). Drives poll() directly via refresh() for determinism;
// a small fake-timer block covers start/stop/idempotency. All the acceptance
// requirements from 2B/2C are asserted here: appear/remove/reinsert without a
// page re-entry, no duplicate rows, stable identity, emit-on-change only,
// errors never stop monitoring, no overlapping refresh, and clean disposal.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createAdapterMonitor, DEFAULT_INTERVAL_MS } = require('../main/adapterMonitor.js');

// A fake WifiManager whose next listInterfaces() result the test controls.
function fakeWifi(initial = { ok: true, ifaces: [] }) {
    let next = initial;
    let calls = 0;
    return {
        set: (r) => { next = r; },
        calls: () => calls,
        listInterfaces: async () => { calls += 1; return typeof next === 'function' ? next() : next; },
    };
}
const ifaces = (...names) => ({ ok: true, ifaces: names.map((name) => ({ name, connected: false })) });

describe('createAdapterMonitor — change detection (2B)', () => {
    it('emits the initial membership, then a change ONLY when membership actually changes', async () => {
        const wifi = fakeWifi(ifaces('Wi-Fi'));
        const mon = createAdapterMonitor({ wifi });
        const seen = [];
        mon.onChange((s) => seen.push(s));

        await mon.refresh();                              // initial: +Wi-Fi
        wifi.set(ifaces('Wi-Fi'));
        await mon.refresh();                              // no change → no emit
        wifi.set({ ok: true, ifaces: [{ name: 'Wi-Fi', connected: true, ssid: 'HOME', signalPct: 40 }] });
        await mon.refresh();                              // connection change → emit
        wifi.set({ ok: true, ifaces: [{ name: 'Wi-Fi', connected: true, ssid: 'HOME', signalPct: 90 }] });
        await mon.refresh();                              // only signal% jittered → NO emit (stable identity)

        expect(seen.length).toBe(2);
        expect(seen[0].added).toEqual(['Wi-Fi']);
        expect(seen[1].ifaces[0]).toMatchObject({ connected: true, ssid: 'HOME' });
    });

    it('detects a dongle appearing while the page is open (added), removal, and reinsertion', async () => {
        const wifi = fakeWifi(ifaces('Wi-Fi'));
        const mon = createAdapterMonitor({ wifi });
        const seen = [];
        mon.onChange((s) => seen.push(s));

        await mon.refresh();                              // +Wi-Fi
        wifi.set(ifaces('Wi-Fi', 'Wi-Fi 2'));
        await mon.refresh();                              // +Wi-Fi 2 (appeared)
        wifi.set(ifaces('Wi-Fi'));
        await mon.refresh();                              // -Wi-Fi 2 (removed)
        wifi.set(ifaces('Wi-Fi', 'Wi-Fi 2'));
        await mon.refresh();                              // +Wi-Fi 2 (reinserted)

        expect(seen.map((s) => s.added)).toEqual([['Wi-Fi'], ['Wi-Fi 2'], [], ['Wi-Fi 2']]);
        expect(seen.map((s) => s.removed)).toEqual([[], [], ['Wi-Fi 2'], []]);
        // seq is strictly monotonic so the renderer can drop out-of-order pushes.
        expect(seen.map((s) => s.seq)).toEqual([1, 2, 3, 4]);
    });

    it('never produces duplicate adapter rows even if netsh repeats a block', async () => {
        const wifi = fakeWifi({ ok: true, ifaces: [{ name: 'Wi-Fi' }, { name: 'Wi-Fi' }, { name: 'Wi-Fi 2' }] });
        const mon = createAdapterMonitor({ wifi });
        const snap = await mon.refresh();
        expect(snap.ifaces.map((i) => i.name)).toEqual(['Wi-Fi', 'Wi-Fi 2']);
    });
});

describe('createAdapterMonitor — resilience (2C)', () => {
    it('a failed listing becomes an ok:false snapshot and monitoring CONTINUES (recovers on the next poll)', async () => {
        const wifi = fakeWifi(ifaces('Wi-Fi'));
        const mon = createAdapterMonitor({ wifi });
        const seen = [];
        mon.onChange((s) => seen.push(s));

        await mon.refresh();                              // ok +Wi-Fi
        wifi.set({ ok: false, error: 'netsh: WLAN service not running' });
        await mon.refresh();                              // failed → ok:false snapshot
        wifi.set(ifaces('Wi-Fi'));
        await mon.refresh();                              // recovered

        expect(seen.map((s) => s.ok)).toEqual([true, false, true]);
        expect(seen[1].error).toContain('WLAN service');
        expect(seen[1].removed).toEqual(['Wi-Fi']);       // the list is empty while broken
    });

    it('a rejected listInterfaces is caught, reported as ok:false, and polling keeps going', async () => {
        const wifi = fakeWifi(ifaces('Wi-Fi'));
        const mon = createAdapterMonitor({ wifi, log: () => {} });
        const seen = [];
        mon.onChange((s) => seen.push(s));
        await mon.refresh();                              // ok
        wifi.set(() => { throw new Error('plumbing broke'); });
        await mon.refresh();                              // rejection → controlled ok:false
        expect(seen[1].ok).toBe(false);
        expect(seen[1].error).toContain('plumbing broke');
    });

    it('never overlaps an in-flight poll (a slow netsh stretches the period, no re-entry)', async () => {
        let release;
        const gate = new Promise((r) => { release = r; });
        const wifi = { calls: 0, listInterfaces() { this.calls += 1; return gate; } };
        const mon = createAdapterMonitor({ wifi });
        const p1 = mon.refresh();                         // starts a poll, awaits the gate
        await mon.refresh();                              // in-flight → returns last, no second call
        expect(wifi.calls).toBe(1);
        release({ ok: true, ifaces: [{ name: 'Wi-Fi' }] });
        await p1;
        expect(wifi.calls).toBe(1);
    });
});

describe('createAdapterMonitor — lifecycle (2B: main-process, not page-coupled)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('start polls immediately then on the interval; start is idempotent (no duplicate timers); stop disposes', async () => {
        const wifi = fakeWifi(ifaces('Wi-Fi'));
        const spy = vi.spyOn(wifi, 'listInterfaces');
        const mon = createAdapterMonitor({ wifi, intervalMs: DEFAULT_INTERVAL_MS });
        expect(mon.running()).toBe(false);
        mon.start();
        expect(mon.running()).toBe(true);
        mon.start();                                      // idempotent — must not add a second timer
        expect(spy).toHaveBeenCalledTimes(1);             // one immediate poll, not two
        await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL_MS);
        expect(spy).toHaveBeenCalledTimes(2);             // exactly one poll per interval (single timer)
        mon.stop();
        expect(mon.running()).toBe(false);
        await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL_MS * 3);
        expect(spy).toHaveBeenCalledTimes(2);             // stopped: no further polls
        expect(() => mon.stop()).not.toThrow();           // idempotent disposal
    });
});
