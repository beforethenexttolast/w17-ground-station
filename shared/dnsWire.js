// Minimal DNS/mDNS wire codec: encode one query, decode a response. Pure
// CommonJS -- no sockets, no clock, no IO. The W17-specific policy (which
// service, which TXT keys, what counts as a usable HUD) lives one layer up in
// shared/hudDiscovery.js; this file knows only the wire format.
//
// SECURITY POSTURE: every byte decoded here arrives from UNAUTHENTICATED local
// multicast -- any host on the link can send anything. So:
//   - every read is bounds-checked against the buffer before it happens;
//   - nothing is allocated from an attacker-supplied length that has not been
//     bounds-checked first;
//   - name decompression is bounded THREE ways, all of them load-bearing:
//     pointers must point strictly backwards, jumps are capped, and total name
//     length is capped. The backwards rule alone is NOT sufficient — a label at
//     12 that walks forward to 17 and a pointer at 17 aiming back at 12 is a
//     cycle in which every jump is legally backwards. Do not delete a cap as
//     redundant; test/dnsWire.test.js pins that case;
//   - names, labels, record counts, and message size all have hard caps;
//   - decode NEVER throws -- it returns { ok: false, reason } instead, so a
//     hostile packet is a logged non-event rather than a crashed main process.
//
// Only the four record types discovery needs are decoded (A/PTR/TXT/SRV). Any
// other type is kept with `data: null` so record counts stay honest.

const TYPE = Object.freeze({ A: 1, PTR: 12, TXT: 16, SRV: 33 });
const CLASS_IN = 1;

// A response sets the top class bit as the mDNS "cache-flush" flag (RFC 6762
// §10.2); it is not part of the class value and must be masked off.
const CACHE_FLUSH = 0x8000;
const CLASS_MASK = 0x7fff;

// A query sets the top class bit to request a UNICAST response (RFC 6762 §5.4).
const UNICAST_RESPONSE = 0x8000;

// Caps. mDNS messages may reach ~9000 bytes over Ethernet; real HUD
// advertisements are a few hundred. The record cap bounds decode work per
// packet -- the counts come from the packet itself, so they are attacker-set.
const MAX_MESSAGE_BYTES = 9000;
const MAX_NAME_BYTES = 255;
const MAX_LABEL_BYTES = 63;
const MAX_RECORDS = 256;
const MAX_POINTER_JUMPS = 64;

const HEADER_BYTES = 12;

// Read a (possibly compressed) name at `offset`.
// Returns { labels, name, next } or null if malformed/out of bounds. `next` is
// the offset just past the name IN THE ENCLOSING STREAM -- for a compressed
// name that is past the 2-byte pointer, not past the data it points at.
function readName(buf, offset) {
    const labels = [];
    let pos = offset;
    let next = -1;
    let jumps = 0;
    let total = 0;
    for (;;) {
        if (pos < 0 || pos >= buf.length) return null;
        const len = buf[pos];
        if (len === 0) {
            pos += 1;
            if (next < 0) next = pos;
            break;
        }
        const kind = len & 0xc0;
        if (kind === 0xc0) {
            if (pos + 1 >= buf.length) return null;
            const target = ((len & 0x3f) << 8) | buf[pos + 1];
            if (next < 0) next = pos + 2;
            // Backwards-only rules out the trivial self-loop, but NOT a cycle
            // through forward label walking (see the header). The jump cap and
            // the length cap below are what actually bound the work.
            if (target >= pos) return null;
            if (++jumps > MAX_POINTER_JUMPS) return null;
            pos = target;
            continue;
        }
        // 0b01 and 0b10 are reserved label types -- not something a real
        // responder emits, so treat them as malformed rather than guessing.
        if (kind !== 0) return null;
        if (len > MAX_LABEL_BYTES) return null;
        const end = pos + 1 + len;
        if (end > buf.length) return null;
        total += len + 1;
        if (total > MAX_NAME_BYTES) return null;
        // Labels are UTF-8 by convention (RFC 6763 §4.1.3). Arbitrary bytes
        // decode to replacement characters rather than throwing; callers that
        // need stricter text (a display label) enforce it themselves.
        labels.push(buf.toString('utf8', pos + 1, end));
        pos = end;
    }
    return { labels, name: labels.join('.'), next };
}

// Encode a dotted name. Used only for our own query, so the input is a
// trusted literal -- an over-long label is a programming error, not input.
function encodeName(name) {
    const parts = String(name).split('.').filter((p) => p.length > 0);
    const chunks = [];
    for (const part of parts) {
        const bytes = Buffer.from(part, 'utf8');
        if (bytes.length > MAX_LABEL_BYTES) throw new Error(`label too long: ${part}`);
        chunks.push(Buffer.from([bytes.length]), bytes);
    }
    chunks.push(Buffer.from([0]));
    return Buffer.concat(chunks);
}

// One-shot query for `service` (a PTR lookup, the standard service-browse).
// `unicastResponse` sets the QU bit so responders answer our ephemeral source
// port directly -- see main/HudDiscovery.js for why that matters on Windows.
function buildQuery(service, { unicastResponse = true, type = TYPE.PTR } = {}) {
    const header = Buffer.alloc(HEADER_BYTES);
    header.writeUInt16BE(0, 0);          // ID 0: mDNS ignores it
    header.writeUInt16BE(0, 2);          // standard query, not truncated
    header.writeUInt16BE(1, 4);          // QDCOUNT
    const qname = encodeName(service);
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(type, 0);
    tail.writeUInt16BE(unicastResponse ? (CLASS_IN | UNICAST_RESPONSE) : CLASS_IN, 2);
    return Buffer.concat([header, qname, tail]);
}

// Decode RDATA for the types we care about. `buf` is the WHOLE message
// (SRV/PTR targets may compress against earlier names), bounded to [start,end).
function readRdata(buf, type, start, end) {
    if (type === TYPE.A) {
        if (end - start !== 4) return null;
        return { addr: `${buf[start]}.${buf[start + 1]}.${buf[start + 2]}.${buf[start + 3]}` };
    }
    if (type === TYPE.PTR) {
        const n = readName(buf, start);
        // A target whose encoding runs past its own record is malformed.
        if (!n || n.next > end) return null;
        return { target: n.name, targetLabels: n.labels };
    }
    if (type === TYPE.SRV) {
        if (end - start < 7) return null;
        const n = readName(buf, start + 6);
        if (!n || n.next > end) return null;
        return {
            priority: buf.readUInt16BE(start),
            weight: buf.readUInt16BE(start + 2),
            port: buf.readUInt16BE(start + 4),
            target: n.name,
        };
    }
    if (type === TYPE.TXT) {
        // Length-prefixed strings back to back (RFC 6763 §6.1). Duplicate keys:
        // first wins, per §6.4. Keys are case-insensitive, values are not.
        const strings = [];
        const pairs = Object.create(null);
        let pos = start;
        while (pos < end) {
            const len = buf[pos];
            const stop = pos + 1 + len;
            if (stop > end) return null;
            const s = buf.toString('utf8', pos + 1, stop);
            strings.push(s);
            const eq = s.indexOf('=');
            // No '=' means a valueless boolean attribute (§6.4); empty key is
            // not a legal attribute and is dropped.
            const key = (eq === -1 ? s : s.slice(0, eq)).toLowerCase();
            const value = eq === -1 ? '' : s.slice(eq + 1);
            if (key.length > 0 && !(key in pairs)) pairs[key] = value;
            pos = stop;
        }
        return { strings, pairs };
    }
    return null;
}

// Decode a whole message. Returns { ok: true, message } or { ok: false, reason }.
// Never throws.
function decodeMessage(bytes) {
    if (!Buffer.isBuffer(bytes)) return { ok: false, reason: 'not-bytes' };
    if (bytes.length > MAX_MESSAGE_BYTES) return { ok: false, reason: 'oversized' };
    if (bytes.length < HEADER_BYTES) return { ok: false, reason: 'truncated-header' };

    const flags = bytes.readUInt16BE(2);
    const counts = {
        qd: bytes.readUInt16BE(4),
        an: bytes.readUInt16BE(6),
        ns: bytes.readUInt16BE(8),
        ar: bytes.readUInt16BE(10),
    };
    const total = counts.qd + counts.an + counts.ns + counts.ar;
    // The counts are attacker-controlled; refuse an absurd claim before doing
    // any per-record work.
    if (total > MAX_RECORDS) return { ok: false, reason: 'too-many-records' };

    let pos = HEADER_BYTES;
    const questions = [];
    for (let i = 0; i < counts.qd; i += 1) {
        const n = readName(bytes, pos);
        if (!n) return { ok: false, reason: 'bad-question-name' };
        if (n.next + 4 > bytes.length) return { ok: false, reason: 'truncated-question' };
        questions.push({
            name: n.name,
            type: bytes.readUInt16BE(n.next),
            class: bytes.readUInt16BE(n.next + 2) & CLASS_MASK,
        });
        pos = n.next + 4;
    }

    const records = [];
    const rrCount = counts.an + counts.ns + counts.ar;
    for (let i = 0; i < rrCount; i += 1) {
        const n = readName(bytes, pos);
        if (!n) return { ok: false, reason: 'bad-record-name' };
        // name + type(2) + class(2) + ttl(4) + rdlength(2)
        if (n.next + 10 > bytes.length) return { ok: false, reason: 'truncated-record' };
        const type = bytes.readUInt16BE(n.next);
        const klass = bytes.readUInt16BE(n.next + 2);
        const ttl = bytes.readUInt32BE(n.next + 4);
        const rdlength = bytes.readUInt16BE(n.next + 8);
        const rdStart = n.next + 10;
        const rdEnd = rdStart + rdlength;
        if (rdEnd > bytes.length) return { ok: false, reason: 'truncated-rdata' };
        records.push({
            name: n.name,
            labels: n.labels,
            type,
            class: klass & CLASS_MASK,
            cacheFlush: (klass & CACHE_FLUSH) !== 0,
            ttl,
            // A record we cannot decode is KEPT with data null (honest counts);
            // a record we should be able to decode but cannot is data null too,
            // and the policy layer simply finds nothing usable in it.
            data: readRdata(bytes, type, rdStart, rdEnd),
        });
        pos = rdEnd;
    }

    return {
        ok: true,
        message: {
            isResponse: (flags & 0x8000) !== 0,
            questions,
            records,
        },
    };
}

module.exports = {
    TYPE,
    CLASS_IN,
    MAX_MESSAGE_BYTES,
    MAX_NAME_BYTES,
    MAX_LABEL_BYTES,
    MAX_RECORDS,
    readName,
    encodeName,
    buildQuery,
    decodeMessage,
};
