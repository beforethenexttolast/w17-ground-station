// Windows -> iPhone HUD discovery over mDNS (contract "Discovery"; CB4).
//
// WHAT THIS IS: a name lookup that produces CANDIDATE addresses for the W2
// telemetry destination. Every candidate is an ADVISORY HINT the operator
// confirms by hand in the PIT WALL address field -- exactly the existing
// last-W3-sender suggestion's contract, from a second source. Nothing here
// auto-connects, auto-applies an address, or starts a stream; W3 (UDP 5602)
// stays LOG-ONLY and no discovery result can reach CRSF, a servo, the gimbal,
// or the firmware. Reachability (the GRID ping) remains the ground truth.
//
// DEMAND-DRIVEN: the socket opens and the query goes out only while the setup
// flow is actually polling for an address suggestion (poll() is called from the
// 'setup:addr-hint' handler, which the renderer drives on a 2 s interval only
// while PIT WALL is the active step). Leave the step and the queries stop; an
// idle timer then closes the socket. The app never browses the network in the
// background, so "off unless the operator is looking for the phone" is the gate.
//
// WHY AN EPHEMERAL PORT + THE QU BIT, not a bind on 5353: Windows runs its own
// mDNS responder (and Bonjour may be installed alongside), so binding 5353 is
// the case most likely to fail on the deployment target. Setting the
// unicast-response bit (RFC 6762 section 5.4) asks responders to answer our
// ephemeral source port directly, which needs no shared bind and no multicast
// group membership. The trade-off is that unicast answers carry short TTLs and
// some responders rate-limit them -- acceptable for a poll-while-you-look
// lookup, and REAL-DEVICE VERIFICATION IS STILL PENDING (no iPhone on hand).
//
// Thin I/O wrapper over the pure shared/hudDiscovery.js policy (repo HAL-seam
// style): socket, clock, and timers are injectable, so every behavior below is
// tested hermetically with fakes.

const dgram = require('node:dgram');
const os = require('node:os');
const { buildQuery } = require('../shared/dnsWire.js');
const { SERVICE_TYPE, hudsFromDatagram, MAX_CANDIDATES } = require('../shared/hudDiscovery.js');

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;

// An entry is offered for this long after it was last heard. The phone
// withdraws its advertisement when it backgrounds and we may never see the
// goodbye, so entries must age out on their own. Matches the freshness window
// the traffic-hint suggestion already uses (shared/addressProviders.mjs).
const DEFAULT_TTL_MS = 30_000;

// Do not re-query faster than this even if polled more often.
const DEFAULT_QUERY_INTERVAL_MS = 2_000;

// Close the socket once nobody has polled for this long (the operator left the
// step). Any later poll reopens it.
const DEFAULT_IDLE_CLOSE_MS = 15_000;

// Cap warning volume: a broken or hostile responder must not flood the console.
const MAX_REJECT_LOGS = 5;

// Every usable IPv4 address on this host, one per adapter the phone could be
// reachable through. Loopback is included: the iPhone Simulator runs here.
function defaultLocalIpv4Addresses() {
    const out = [];
    let ifaces;
    try {
        ifaces = os.networkInterfaces();
    } catch {
        return out;                             // let the OS pick the interface
    }
    for (const list of Object.values(ifaces || {})) {
        for (const iface of list || []) {
            // Node <18 reports family as the string 'IPv4', newer as the number 4.
            const isV4 = iface.family === 'IPv4' || iface.family === 4;
            if (isV4 && typeof iface.address === 'string' && !out.includes(iface.address)) {
                out.push(iface.address);
            }
        }
    }
    return out;
}

function createHudDiscovery({
    service = SERVICE_TYPE,
    clock = () => Date.now(),
    // Injectable so the multi-adapter behavior is testable without a real host.
    localIpv4Addresses = defaultLocalIpv4Addresses,
    socketFactory = () => dgram.createSocket({ type: 'udp4', reuseAddr: true }),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (h) => clearTimeout(h),
    ttlMs = DEFAULT_TTL_MS,
    queryIntervalMs = DEFAULT_QUERY_INTERVAL_MS,
    idleCloseMs = DEFAULT_IDLE_CLOSE_MS,
    log = () => {},
} = {}) {
    // addr -> { hud, atMs }. Keyed by address because the address IS the
    // suggestion; a phone that renames itself is the same candidate.
    const cache = new Map();
    let socket = null;
    let bound = false;
    let lastQueryMs = -Infinity;
    let idleTimer = null;
    let rejectLogs = 0;

    const closeSocket = () => {
        if (idleTimer !== null) { clearTimer(idleTimer); idleTimer = null; }
        const s = socket;
        socket = null;
        bound = false;
        if (!s) return;
        try { s.close(); } catch { /* already closed -- nothing to undo */ }
    };

    const armIdleClose = () => {
        if (idleTimer !== null) clearTimer(idleTimer);
        idleTimer = setTimer(() => { idleTimer = null; closeSocket(); }, idleCloseMs);
        // Never let the lookup hold the process open at quit.
        if (idleTimer && typeof idleTimer.unref === 'function') idleTimer.unref();
    };

    const onMessage = (buf, rinfo) => {
        const res = hudsFromDatagram(buf, { serviceType: service });
        if (!res.ok) return;                     // not a decodable response: ignore
        const from = rinfo && rinfo.address;
        // Why a HUD was declined is the first thing a bench session needs when
        // a real phone is not being offered, so the reasons are logged (bounded).
        for (const { reason } of res.rejected) {
            if (rejectLogs >= MAX_REJECT_LOGS) break;
            rejectLogs += 1;
            log(`[discovery] declined an advertisement from ${from || 'unknown'}: ${reason}`);
        }
        for (const hud of res.huds) {
            // RFC 6762 section 10.1: TTL 0 is a goodbye. The phone is telling us
            // it has stopped listening (backgrounded, telemetry off), so RETIRE
            // the suggestion — caching it would extend its life by another TTL,
            // which is exactly backwards.
            if (hud.ttl === 0) {
                cache.delete(hud.addr);
                continue;
            }
            // An advertisement that points somewhere OTHER than the host that
            // sent it is a redirect attempt (or a multi-homed responder we
            // cannot verify). Both are declined and named in the log, so a
            // bench session can see instantly why a real phone was skipped.
            if (from && hud.addr !== from) {
                if (rejectLogs < MAX_REJECT_LOGS) {
                    rejectLogs += 1;
                    log(`[discovery] ignored advertisement from ${from} claiming ${hud.addr} (sender/address mismatch)`);
                }
                continue;
            }
            if (!cache.has(hud.addr) && cache.size >= MAX_CANDIDATES) {
                // Evict the stalest so a burst of junk cannot lock out a phone
                // that shows up afterwards.
                let oldestKey = null;
                let oldestAt = Infinity;
                for (const [key, entry] of cache) {
                    if (entry.atMs < oldestAt) { oldestAt = entry.atMs; oldestKey = key; }
                }
                if (oldestKey !== null) cache.delete(oldestKey);
            }
            cache.set(hud.addr, { hud, atMs: clock() });
        }
    };

    const open = () => {
        if (socket) return;
        rejectLogs = 0;
        try {
            socket = socketFactory();
        } catch (err) {
            socket = null;
            log(`[discovery] socket create failed: ${err.message}`);
            return;
        }
        // Captured once, before any handler is attached: every callback below
        // is identity-checked against THIS socket, so a late event from a
        // socket we already dropped can never act on its replacement.
        const opened = socket;
        opened.on('error', (err) => {
            // A discovery failure is a missing convenience, never an app
            // failure: drop the socket, keep whatever was already found (it
            // ages out), and let the next poll try again. Identity-checked for
            // the same reason as the bind callback below — a late error from a
            // socket we already dropped must not tear down its replacement.
            if (socket !== opened) return;
            log(`[discovery] socket error: ${err.message}`);
            closeSocket();
        });
        opened.on('message', (buf, rinfo) => { if (socket === opened) onMessage(buf, rinfo); });
        try {
            // Bind completes asynchronously, so the socket we opened may already
            // have been dropped (error, idle close, quit) by the time this fires.
            opened.bind(() => {
                if (socket !== opened) return;
                bound = true;
                sendQuery();
            });
        } catch (err) {
            log(`[discovery] bind failed: ${err.message}`);
            closeSocket();
        }
    };

    function sendQuery() {
        if (!socket || !bound) return;
        const now = clock();
        if (now - lastQueryMs < queryIntervalMs) return;
        lastQueryMs = now;
        let packet;
        try {
            packet = buildQuery(service);
        } catch (err) {
            log(`[discovery] query build failed: ${err.message}`);
            return;
        }
        const emit = () => socket.send(packet, 0, packet.length, MDNS_PORT, MDNS_ADDR, (err) => {
            // No route to the multicast group (no network, adapter down) is the
            // ordinary case here, not an error worth alarming about.
            if (err) log(`[discovery] query send failed: ${err.message}`);
        });
        try {
            // RFC 6762 section 11 wants IP TTL 255 on mDNS traffic; some
            // responders check it. Best-effort — an unsupported platform must
            // not cost us the query.
            try { socket.setMulticastTTL(255); } catch { /* keep the default */ }

            // THE MULTI-ADAPTER CASE, which is the normal one on the deployment
            // target: the bench host has Ethernet or office Wi-Fi holding the
            // default route AND the hotspot/dongle adapter the phone is actually
            // on. A plain send follows the routing table and would only ever ask
            // one of them, so the phone on the other subnet is never discovered
            // and nothing says why. Ask every usable IPv4 interface in turn.
            const addrs = localIpv4Addresses();
            if (addrs.length === 0) {
                emit();                       // no enumeration: let the OS choose
                return;
            }
            for (const addr of addrs) {
                try { socket.setMulticastInterface(addr); } catch { continue; }
                emit();
            }
        } catch (err) {
            log(`[discovery] query send threw: ${err.message}`);
        }
    }

    return {
        // Called by the 'setup:addr-hint' IPC handler. Opens the socket on
        // first use, rate-limits the query, and returns the fresh candidates.
        // NEVER throws and never rejects: the caller treats an empty list as
        // "no suggestion this tick".
        poll() {
            open();
            sendQuery();
            armIdleClose();
            const now = clock();
            const out = [];
            for (const [addr, entry] of [...cache]) {
                const ageMs = Math.max(0, now - entry.atMs);
                if (ageMs > ttlMs) { cache.delete(addr); continue; }
                out.push({ ...entry.hud, ageMs });
            }
            // Freshest first: the phone that answered most recently is the one
            // most likely still on this network at this address.
            out.sort((a, b) => a.ageMs - b.ageMs);
            return out;
        },

        // Teardown (main.js quit choreography). Idempotent.
        stop() {
            closeSocket();
            cache.clear();
        },
    };
}

module.exports = {
    createHudDiscovery,
    MDNS_ADDR,
    MDNS_PORT,
    DEFAULT_TTL_MS,
    DEFAULT_QUERY_INTERVAL_MS,
    DEFAULT_IDLE_CLOSE_MS,
};
