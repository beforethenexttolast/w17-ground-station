// iPhone HUD discovery: pure policy over a decoded mDNS response.
//
// ADVISORY BY DESIGN (docs/windows_bridge_contract.md, "Discovery"). What this
// module produces is a list of CANDIDATE addresses for the W2 telemetry
// destination -- suggestions the operator must confirm by hand. Discovery is
// an addressing convenience and nothing more:
//   - it never auto-connects and never auto-applies an address;
//   - it adds no control authority: W2 stays send-only display telemetry, W3
//     (UDP 5602) stays receive-only and LOG-ONLY, and nothing here can reach
//     CRSF, a servo, the gimbal, or the firmware;
//   - reachability (the GRID ping) remains the ground truth for whether
//     telemetry actually flows -- an advertisement is a claim, not evidence.
// The worst case for a spoofed or stale advertisement is therefore that the
// operator is OFFERED a wrong address, declines it, or confirms it and sends
// display telemetry JSON to the wrong local host.
//
// Canonical service definition (contract "Discovery", mirrored at rev 9d0d8d7):
//   service `_w17hud._udp.local.`, instance `W17 HUD (<device name>)`,
//   SRV port = the app's W2 telemetry listen port (default 5601), TXT keys
//   v / role / tport / feat / dev.
//
// Pure CommonJS: no sockets, no clock of its own (callers pass nowMs) -- the
// repo's standard seam. The transport lives in main/HudDiscovery.js.

const { TYPE, decodeMessage } = require('./dnsWire.js');

const SERVICE_TYPE = '_w17hud._udp.local';

// The contract version this build speaks. `v` is the one TXT key the contract
// makes mandatory; a different value means a peer we do not understand, so we
// decline to suggest it rather than guessing at its semantics.
const CONTRACT_VERSION = '1';

// Features a HUD may claim. Unknown tokens are dropped, not rejected -- adding
// TXT values is backward-compatible for v=1.
const KNOWN_FEATURES = Object.freeze(['w2', 'w3']);

// A display label is untrusted text from the network. It is bounded and
// stripped to printable ASCII (the contract already specifies printable ASCII)
// so it can never carry control characters into a log line or the setup UI.
const MAX_DEV_CHARS = 32;

// How many distinct HUDs we will ever offer. A flood of forged advertisements
// cannot grow this list without bound.
const MAX_CANDIDATES = 8;

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

// Addresses a HUD cannot legitimately be reachable at. Loopback is deliberately
// ALLOWED: the iPhone Simulator on this same host is a supported W2 destination.
function isUsableUnicastIpv4(addr) {
    if (typeof addr !== 'string' || !IPV4_RE.test(addr)) return false;
    const o = addr.split('.').map(Number);
    if (o[0] === 0) return false;               // "this network"
    if (o[0] >= 224) return false;              // multicast + reserved + broadcast
    return true;
}

function sanitizeDev(raw) {
    if (typeof raw !== 'string') return '';
    let out = '';
    for (const ch of raw) {
        const code = ch.codePointAt(0);
        if (code >= 0x20 && code <= 0x7e) out += ch;
        if (out.length >= MAX_DEV_CHARS) break;
    }
    return out.trim();
}

function parseFeatures(raw) {
    if (typeof raw !== 'string' || raw.length === 0) return [];
    const seen = new Set();
    for (const token of raw.split(',')) {
        const t = token.trim().toLowerCase();
        if (KNOWN_FEATURES.includes(t)) seen.add(t);
    }
    return KNOWN_FEATURES.filter((f) => seen.has(f));
}

const lower = (s) => String(s || '').toLowerCase();

// Validate one assembled advertisement against the contract. Returns
// { ok: true, hud } or { ok: false, reason } -- the reason is machine-readable
// and is what a bench session reads out of the log when a real phone is not
// being offered.
function validateAdvertisement({ srv, txt, addr, ttl = null }) {
    if (!srv) return { ok: false, reason: 'no-srv' };
    if (!addr) return { ok: false, reason: 'no-address' };
    if (!isUsableUnicastIpv4(addr)) return { ok: false, reason: 'bad-address' };

    const pairs = (txt && txt.pairs) || {};
    if (!('v' in pairs)) return { ok: false, reason: 'missing-version' };
    if (pairs.v !== CONTRACT_VERSION) return { ok: false, reason: 'unsupported-version' };
    // "If present it must equal `hud` case-insensitively; any other value must
    // be declined. If absent, the advertisement is acceptable." (v is the only
    // required key.)
    if ('role' in pairs && lower(pairs.role) !== 'hud') return { ok: false, reason: 'not-a-hud' };

    const port = srv.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: 'bad-port' };
    // "The advertisement's SRV port and `tport` TXT value must match the actual
    // telemetry listen port." They disagree only in a malformed or forged
    // advertisement, and we cannot tell which one the app is really listening
    // on -- so we decline to guess.
    if ('tport' in pairs && pairs.tport !== String(port)) return { ok: false, reason: 'port-mismatch' };

    return {
        ok: true,
        hud: {
            addr,
            port,
            dev: sanitizeDev(pairs.dev),
            feat: parseFeatures(pairs.feat),
            v: pairs.v,
            // RFC 6762 section 10.1: a responder withdraws a record by
            // re-announcing it with TTL 0. Carried through so the transport can
            // RETIRE the entry — caching a goodbye as a fresh sighting would
            // make the withdrawal extend the suggestion's life instead.
            ttl,
        },
    };
}

// Assemble candidates from one decoded response: PTR names the instances, SRV
// gives each one a port + target host, TXT the metadata, A the address.
// Responders normally put SRV/TXT/A in the additional section, so all sections
// are searched together.
function candidatesFromMessage(message, { serviceType = SERVICE_TYPE } = {}) {
    const suffix = `.${lower(serviceType)}`;
    const srvByName = new Map();
    const txtByName = new Map();
    const addrByHost = new Map();
    const ttlByName = new Map();
    const instances = new Set();

    const noteTtl = (name, ttl) => {
        // The lowest TTL across an instance's records wins: one withdrawn
        // record (TTL 0) retires the whole suggestion.
        const prev = ttlByName.get(name);
        ttlByName.set(name, prev === undefined ? ttl : Math.min(prev, ttl));
    };

    for (const rec of message.records) {
        const name = lower(rec.name);
        if (rec.type === TYPE.PTR && name === lower(serviceType) && rec.data) {
            const target = lower(rec.data.target);
            instances.add(target);
            noteTtl(target, rec.ttl);
        } else if (rec.type === TYPE.SRV && rec.data) {
            if (!srvByName.has(name)) srvByName.set(name, rec.data);
            noteTtl(name, rec.ttl);
            // A response may carry SRV/TXT without the PTR (a targeted answer,
            // or a responder trimming what it already announced). Owning a name
            // under the service type is itself enough to identify an instance.
            if (name.endsWith(suffix)) instances.add(name);
        } else if (rec.type === TYPE.TXT && rec.data) {
            if (!txtByName.has(name)) txtByName.set(name, rec.data);
        } else if (rec.type === TYPE.A && rec.data) {
            if (!addrByHost.has(name)) addrByHost.set(name, rec.data.addr);
        }
    }

    const huds = [];
    const rejected = [];
    const seenAddrs = new Set();
    for (const instance of instances) {
        if (!instance.endsWith(suffix)) { rejected.push({ instance, reason: 'wrong-service' }); continue; }
        const srv = srvByName.get(instance) || null;
        const txt = txtByName.get(instance) || null;
        const addr = srv ? addrByHost.get(lower(srv.target)) || null : null;
        const ttl = ttlByName.has(instance) ? ttlByName.get(instance) : null;
        const res = validateAdvertisement({ srv, txt, addr, ttl });
        if (!res.ok) { rejected.push({ instance, reason: res.reason }); continue; }
        if (seenAddrs.has(res.hud.addr)) continue;   // one suggestion per address
        seenAddrs.add(res.hud.addr);
        huds.push(res.hud);
        if (huds.length >= MAX_CANDIDATES) break;
    }
    return { huds, rejected };
}

// Decode + assemble in one step, for a raw datagram straight off the socket.
// Returns { ok: false, reason } for a packet that is not a decodable response,
// { ok: true, huds, rejected } otherwise. Never throws.
function hudsFromDatagram(bytes, opts = {}) {
    const decoded = decodeMessage(bytes);
    if (!decoded.ok) return { ok: false, reason: decoded.reason };
    // A query is not an answer -- our own multicast query comes back to us on a
    // shared socket, and another browser's query says nothing about a HUD.
    if (!decoded.message.isResponse) return { ok: false, reason: 'not-a-response' };
    const { huds, rejected } = candidatesFromMessage(decoded.message, opts);
    return { ok: true, huds, rejected };
}

module.exports = {
    SERVICE_TYPE,
    CONTRACT_VERSION,
    KNOWN_FEATURES,
    MAX_DEV_CHARS,
    MAX_CANDIDATES,
    isUsableUnicastIpv4,
    sanitizeDev,
    parseFeatures,
    validateAdvertisement,
    candidatesFromMessage,
    hudsFromDatagram,
};
