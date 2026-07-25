// mDNS transport for HUD discovery (CB4): main/HudDiscovery.js driven entirely
// through injected fakes — no real socket, no real clock, no real timer, so the
// whole lifecycle is hermetic and runs identically on macOS and Windows CI.
//
// The properties that matter here are availability and containment, not
// features: discovery is an OPTIONAL convenience, so every failure mode
// (unbindable socket, dead network, hostile responder, flood) must degrade to
// "no suggestion" and never to a thrown error in the main process. Real-device
// verification against an actual advertising iPhone is PENDING — no device on
// hand — so nothing here claims the end-to-end path works.
import { describe, it, expect, vi } from 'vitest';
import { decodeMessage, TYPE } from '../shared/dnsWire.js';
import { MAX_CANDIDATES } from '../shared/hudDiscovery.js';
import { createHudDiscovery, MDNS_ADDR, MDNS_PORT } from '../main/HudDiscovery.js';
import { advert, goodbye } from './fixtures/mdnsAdvert.mjs';

function fakeSocket({ bindThrows = false, sendErr = null } = {}) {
    const handlers = new Map();
    const sock = {
        sent: [],
        closed: 0,
        boundCb: null,
        on(ev, fn) { handlers.set(ev, fn); return sock; },
        bind(cb) {
            if (bindThrows) throw new Error('EACCES');
            sock.boundCb = cb;
            cb();                       // bind completes synchronously in tests
        },
        send(buf, off, len, port, addr, cb) {
            sock.sent.push({ buf, port, addr });
            if (cb) cb(sendErr);
        },
        // Real dgram methods the query path uses; individual tests override
        // them to observe or to simulate an unsupported platform.
        setMulticastTTL() {},
        setMulticastInterface() {},
        close() { sock.closed += 1; },
        // Test-side drivers for the socket's own events.
        deliver(bytes, rinfo) { handlers.get('message')(bytes, rinfo); },
        fail(err) { handlers.get('error')(err); },
    };
    return sock;
}

// A discovery instance with a controllable clock and timer, plus handles to the
// sockets it opened and the lines it logged.
function harness({ socketOpts = {}, ...opts } = {}) {
    let now = 1_000;
    const sockets = [];
    const logs = [];
    const timers = [];
    const disco = createHudDiscovery({
        clock: () => now,
        // Pinned, not read from the real host: interface enumeration must not
        // make these tests depend on the machine they run on.
        localIpv4Addresses: () => ['10.0.0.1'],
        socketFactory: () => { const s = fakeSocket(socketOpts); sockets.push(s); return s; },
        setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
        clearTimer: (t) => { if (t) t.cleared = true; },
        log: (line) => logs.push(line),
        ...opts,
    });
    return {
        disco,
        sockets,
        logs,
        timers,
        get socket() { return sockets[sockets.length - 1]; },
        advance(ms) { now += ms; },
        // Fire the pending idle-close timer the way Node eventually would.
        fireIdle() { const t = timers.filter((x) => !x.cleared).pop(); if (t) t.fn(); },
    };
}

const HUD = { addr: '192.168.4.7', rinfo: { address: '192.168.4.7', port: 5353 } };

describe('HudDiscovery — querying', () => {
    it('opens a socket on the first poll and asks the multicast group for the service', () => {
        const h = harness();
        expect(h.sockets).toHaveLength(0);       // nothing opened until asked
        h.disco.poll();
        expect(h.sockets).toHaveLength(1);
        expect(h.socket.sent).toHaveLength(1);
        const { buf, port, addr } = h.socket.sent[0];
        expect(port).toBe(MDNS_PORT);
        expect(addr).toBe(MDNS_ADDR);
        const q = decodeMessage(buf);
        expect(q.ok).toBe(true);
        expect(q.message.questions[0]).toMatchObject({ name: '_w17hud._udp.local', type: TYPE.PTR });
    });

    it('rate-limits queries: polling faster than the interval does not flood the link', () => {
        const h = harness({ queryIntervalMs: 2000 });
        h.disco.poll();
        h.advance(500); h.disco.poll();
        h.advance(500); h.disco.poll();
        expect(h.socket.sent).toHaveLength(1);
        h.advance(1500); h.disco.poll();
        expect(h.socket.sent).toHaveLength(2);
    });

    it('sends nothing at all when never polled — no background browsing', () => {
        const h = harness();
        h.advance(60_000);
        expect(h.sockets).toHaveLength(0);
    });
});

describe('HudDiscovery — candidates', () => {
    it('caches a valid advertisement and offers it with an age', () => {
        const h = harness();
        h.disco.poll();
        h.socket.deliver(advert(), HUD.rinfo);
        h.advance(400);
        const [hud, ...rest] = h.disco.poll();
        expect(rest).toEqual([]);
        expect(hud).toMatchObject({ addr: '192.168.4.7', port: 5601, dev: 'Test iPhone', ageMs: 400 });
    });

    it('ages entries out — a phone that backgrounds stops being suggested', () => {
        const h = harness({ ttlMs: 30_000 });
        h.disco.poll();
        h.socket.deliver(advert(), HUD.rinfo);
        h.advance(29_999);
        expect(h.disco.poll()).toHaveLength(1);
        h.advance(2);
        expect(h.disco.poll()).toEqual([]);
    });

    it('refreshes the age when the same phone answers again', () => {
        const h = harness();
        h.disco.poll();
        h.socket.deliver(advert(), HUD.rinfo);
        h.advance(20_000);
        h.socket.deliver(advert(), HUD.rinfo);
        expect(h.disco.poll()[0].ageMs).toBe(0);
    });

    it('offers the freshest phone first', () => {
        const h = harness();
        h.disco.poll();
        h.socket.deliver(advert({ addr: '192.168.4.7', host: 'a.local' }), { address: '192.168.4.7' });
        h.advance(5_000);
        h.socket.deliver(advert({ addr: '192.168.4.9', host: 'b.local' }), { address: '192.168.4.9' });
        expect(h.disco.poll().map((x) => x.addr)).toEqual(['192.168.4.9', '192.168.4.7']);
    });
});

describe('HudDiscovery — the multi-adapter deployment target', () => {
    it('asks EVERY local IPv4 interface, not just the one holding the default route', () => {
        // The bench host has office Wi-Fi (default route) AND the hotspot the
        // phone is actually on. A plain send would follow the routing table and
        // never reach the phone's subnet.
        const chosen = [];
        const h = harness({ localIpv4Addresses: () => ['192.168.1.5', '192.168.137.1'] });
        h.disco.poll();
        h.socket.setMulticastInterface = (a) => chosen.push(a);
        h.advance(5_000);
        h.disco.poll();
        expect(chosen).toEqual(['192.168.1.5', '192.168.137.1']);
        expect(h.socket.sent).toHaveLength(4);   // 2 interfaces × 2 polls
    });

    it('falls back to letting the OS choose when no interface can be enumerated', () => {
        const h = harness({ localIpv4Addresses: () => [] });
        h.disco.poll();
        expect(h.socket.sent).toHaveLength(1);
    });

    it('skips an interface that refuses selection instead of losing the whole query', () => {
        const h = harness({ localIpv4Addresses: () => ['192.168.1.5', '192.168.137.1'] });
        h.disco.poll();
        h.socket.setMulticastInterface = (a) => { if (a === '192.168.1.5') throw new Error('EADDRNOTAVAIL'); };
        h.advance(5_000);
        h.disco.poll();
        expect(h.socket.sent).toHaveLength(3);   // 2 from the first poll, 1 good interface now
    });

    it('survives a platform without setMulticastTTL/Interface at all', () => {
        const h = harness();
        h.disco.poll();
        h.socket.setMulticastTTL = () => { throw new Error('unsupported'); };
        h.socket.setMulticastInterface = () => { throw new Error('unsupported'); };
        h.advance(5_000);
        expect(() => h.disco.poll()).not.toThrow();
    });
});

describe('HudDiscovery — containment', () => {
    it('ignores an advertisement that points somewhere other than its sender, and says so once per socket', () => {
        const h = harness();
        h.disco.poll();
        // A spoofer on the link advertising the HUD service but naming a
        // different host as the destination.
        h.socket.deliver(advert({ addr: '10.9.9.9' }), { address: '192.168.4.200' });
        expect(h.disco.poll()).toEqual([]);
        expect(h.logs.join('\n')).toContain('sender/address mismatch');
    });

    it('caps mismatch logging so a hostile responder cannot flood the console', () => {
        const h = harness();
        h.disco.poll();
        for (let i = 0; i < 50; i += 1) {
            h.socket.deliver(advert({ addr: '10.9.9.9' }), { address: '192.168.4.200' });
        }
        expect(h.logs.filter((l) => l.includes('mismatch'))).toHaveLength(5);
    });

    it('never grows past MAX_CANDIDATES, evicting the stalest so a later phone still fits', () => {
        const h = harness();
        h.disco.poll();
        for (let i = 0; i < MAX_CANDIDATES + 4; i += 1) {
            const addr = `192.168.4.${20 + i}`;
            h.advance(10);
            h.socket.deliver(advert({ addr, host: `h${i}.local` }), { address: addr });
        }
        const out = h.disco.poll();
        expect(out).toHaveLength(MAX_CANDIDATES);
        // The newest arrivals survived; the first ones were evicted.
        expect(out[0].addr).toBe(`192.168.4.${20 + MAX_CANDIDATES + 3}`);
    });

    it('retires a candidate on a TTL-0 goodbye instead of extending its life', () => {
        // RFC 6762 §10.1: the phone withdraws by re-announcing with TTL 0. If
        // that were cached like any sighting, the withdrawal would keep the
        // suggestion alive for another full TTL — exactly backwards.
        const h = harness();
        h.disco.poll();
        h.socket.deliver(advert(), HUD.rinfo);
        expect(h.disco.poll()).toHaveLength(1);
        h.socket.deliver(goodbye(), HUD.rinfo);
        expect(h.disco.poll()).toEqual([]);
    });

    it('logs WHY an advertisement was declined — the first thing a bench session needs', () => {
        const h = harness();
        h.disco.poll();
        h.socket.deliver(advert({ txt: ['v=2', 'role=hud'] }), HUD.rinfo);
        expect(h.logs.join('\n')).toContain('unsupported-version');
        expect(h.disco.poll()).toEqual([]);
    });

    it('bounds decline logging the same way as mismatch logging', () => {
        const h = harness();
        h.disco.poll();
        for (let i = 0; i < 40; i += 1) h.socket.deliver(advert({ txt: ['v=9'] }), HUD.rinfo);
        expect(h.logs.filter((l) => l.includes('declined')).length).toBeLessThanOrEqual(5);
    });

    it('shrugs off garbage, truncated packets, and its own query echoed back', () => {
        const h = harness();
        h.disco.poll();
        const own = h.socket.sent[0].buf;
        for (const junk of [Buffer.alloc(0), Buffer.alloc(3), Buffer.alloc(9000), Buffer.from('hello'), own]) {
            expect(() => h.socket.deliver(junk, HUD.rinfo)).not.toThrow();
        }
        expect(h.disco.poll()).toEqual([]);
    });

    it('accepts a datagram with no rinfo without throwing', () => {
        const h = harness();
        h.disco.poll();
        expect(() => h.socket.deliver(advert(), undefined)).not.toThrow();
        expect(h.disco.poll()).toHaveLength(1);   // no sender to compare against
    });
});

describe('HudDiscovery — failure is a missing convenience, never an app failure', () => {
    it('survives a socket that cannot be created', () => {
        const h = harness({ socketFactory: () => { throw new Error('no sockets today'); } });
        expect(() => h.disco.poll()).not.toThrow();
        expect(h.disco.poll()).toEqual([]);
        expect(h.logs.join('\n')).toContain('socket create failed');
    });

    it('survives a bind failure (the Windows 5353-in-use case)', () => {
        const h = harness({ socketOpts: { bindThrows: true } });
        expect(h.disco.poll()).toEqual([]);
        expect(h.logs.join('\n')).toContain('bind failed');
        expect(h.socket.closed).toBe(1);
    });

    it('survives a send failure (no route to the multicast group)', () => {
        const h = harness({ socketOpts: { sendErr: new Error('ENETUNREACH') } });
        expect(h.disco.poll()).toEqual([]);
        expect(h.logs.join('\n')).toContain('query send failed');
    });

    it('drops the socket on a socket error and reopens on the next poll', () => {
        const h = harness();
        h.disco.poll();
        const first = h.socket;
        first.fail(new Error('EBADF'));
        expect(first.closed).toBe(1);
        h.advance(5_000);
        h.disco.poll();
        expect(h.sockets).toHaveLength(2);
        expect(h.socket).not.toBe(first);
    });
});

describe('HudDiscovery — lifecycle', () => {
    it('closes the socket once nobody has polled for a while', () => {
        const h = harness({ idleCloseMs: 15_000 });
        h.disco.poll();
        expect(h.socket.closed).toBe(0);
        h.fireIdle();
        expect(h.socket.closed).toBe(1);
        // A later poll reopens rather than staying dead.
        h.advance(20_000);
        h.disco.poll();
        expect(h.sockets).toHaveLength(2);
    });

    it('re-arms the idle timer on each poll instead of leaking one per call', () => {
        const h = harness();
        h.disco.poll();
        h.advance(3_000); h.disco.poll();
        h.advance(3_000); h.disco.poll();
        expect(h.timers.filter((t) => !t.cleared)).toHaveLength(1);
    });

    it('stop() closes the socket, forgets every candidate, and is idempotent', () => {
        const h = harness();
        h.disco.poll();
        h.socket.deliver(advert(), HUD.rinfo);
        expect(h.disco.poll()).toHaveLength(1);
        h.disco.stop();
        expect(h.socket.closed).toBe(1);
        expect(() => h.disco.stop()).not.toThrow();
        expect(h.socket.closed).toBe(1);          // not closed twice
        // Nothing lingers: a poll after stop starts from an empty cache.
        expect(h.disco.poll()).toEqual([]);
    });

    it('ignores a dropped socket\'s late ERROR instead of tearing down its replacement', () => {
        // Socket A is closed by the idle timer; the operator returns and poll()
        // opens socket B. A queued error on A (async bind failure, or
        // ERR_SOCKET_DGRAM_NOT_RUNNING after close) must not close B — that
        // would take discovery dark for a cycle and log the wrong socket.
        const h = harness();
        h.disco.poll();
        const first = h.socket;
        h.fireIdle();                                    // A closed
        expect(first.closed).toBe(1);
        h.advance(5_000);
        h.disco.poll();                                  // B opened
        const second = h.socket;
        expect(second).not.toBe(first);
        first.fail(new Error('ERR_SOCKET_DGRAM_NOT_RUNNING'));
        expect(second.closed).toBe(0);                   // B untouched
        expect(h.logs.filter((l) => l.includes('socket error'))).toEqual([]);
        // B is still the live socket: it answers the next poll rather than a
        // third one being opened.
        h.advance(5_000);
        h.disco.poll();
        expect(h.sockets).toHaveLength(2);
    });

    it('ignores a dropped socket\'s late bind callback instead of arming the next one', () => {
        // Real bind is async: the socket we opened can be gone (error, idle
        // close, quit) before its callback fires.
        const pending = [];
        const opened = [];
        const h = harness({
            socketFactory: () => {
                const s = fakeSocket();
                s.bind = (cb) => { pending.push(cb); };   // never completes on its own
                opened.push(s);
                return s;
            },
        });
        h.disco.poll();
        const [first] = opened;
        first.fail(new Error('EBADF'));                  // dropped before binding
        h.advance(5_000);
        h.disco.poll();                                  // opens a second socket
        expect(opened).toHaveLength(2);
        pending[0]();                                    // the DEAD socket finally binds
        expect(first.sent).toEqual([]);
        expect(opened[1].sent).toEqual([]);              // and it did not speak for the new one
        pending[1]();
        expect(opened[1].sent).toHaveLength(1);          // the live one still works
    });

    it('unrefs its idle timer so discovery can never hold the app open at quit', () => {
        const unref = vi.fn();
        const h = harness({ setTimer: () => ({ unref }) });
        h.disco.poll();
        expect(unref).toHaveBeenCalled();
    });
});
