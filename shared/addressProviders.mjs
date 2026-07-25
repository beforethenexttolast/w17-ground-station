// Address-provider seam for the iPhone destination (W2 telemetry). ESM.
// Every provider yields CANDIDATES the user must still confirm by hand —
// nothing here (or downstream) applies an address without confirmation.
//
// Providers today: manual entry (validated), the last-sender hint surfaced by
// main's diagnostic seam, and mDNS/Bonjour discovery of the iPhone HUD
// (contract "Discovery", `_w17hud._udp.local.`). Discovery arrives here
// already decoded and validated by the main process (shared/hudDiscovery.js —
// CommonJS, so renderer-side it is only ever the IPC payload); this module
// re-checks the address anyway and decides what the UI may say about it.

export const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function isValidIpv4(s) {
    return typeof s === 'string' && IPV4_RE.test(s);
}

// A hint is worth suggesting only while fresh — the phone that sent it is
// still on this network, most likely with this address.
export const HINT_MAX_AGE_MS = 30_000;

export function suggestionFromHint(hint, { maxAgeMs = HINT_MAX_AGE_MS } = {}) {
    if (!hint || typeof hint.addr !== 'string') return null;
    if (!isValidIpv4(hint.addr)) return null;
    if (typeof hint.ageMs !== 'number' || hint.ageMs > maxAgeMs) return null;
    return hint.addr;
}

// An address a HUD could actually be reachable at. This DUPLICATES the rule in
// shared/hudDiscovery.js (`isUsableUnicastIpv4`) on purpose: that module is
// CommonJS and main-process-only, so the renderer cannot import it, and a
// "defense in depth" re-check that is weaker than the check it backs up is not
// defense at all. Keep the two in step.
function isOfferableAddress(addr) {
    if (!isValidIpv4(addr)) return false;
    const first = Number(addr.split('.')[0]);
    return first !== 0 && first < 224;          // no "this network", no multicast/broadcast
}

// Addresses from discovered HUDs, freshest first (main already sorted them).
export function mdnsCandidates(huds) {
    if (!Array.isArray(huds)) return [];
    return huds
        .map((h) => (h && typeof h.addr === 'string' ? h.addr : null))
        .filter((addr) => addr !== null && isOfferableAddress(addr));
}

// The label shown on a discovery suggestion. Bounded and stripped to printable
// ASCII a second time (main sanitized it already) because this string is the
// one piece of NETWORK-AUTHORED text the setup UI displays.
const MAX_LABEL_CHARS = 24;

export function hudLabel(hud) {
    const raw = hud && typeof hud.dev === 'string' ? hud.dev : '';
    let out = '';
    for (const ch of raw) {
        const code = ch.codePointAt(0);
        // Printable ASCII only. This also happens to exclude the chip's field
        // separator '·' (U+00B7, above 0x7e), so a label cannot forge the
        // higher-trust provenance wording by advertising itself as
        // "X · from HUD traffic". Do not widen this range without re-checking
        // that — test/addressProviders.test.js pins it.
        if (code >= 0x20 && code <= 0x7e) out += ch;
        if (out.length >= MAX_LABEL_CHARS) break;
    }
    return out.trim();
}

// The single suggestion the address field offers, and where it came from.
// Priority is evidence-ordered: a fresh traffic hint means a packet ACTUALLY
// arrived from that address, while an advertisement is only a claim made by
// whoever is on the link. Either way the operator confirms it by hand — this
// returns something to OFFER, never something to apply.
export function pickAddressSuggestion(hint, { maxAgeMs = HINT_MAX_AGE_MS } = {}) {
    const fromTraffic = suggestionFromHint(hint, { maxAgeMs });
    if (fromTraffic) return { addr: fromTraffic, source: 'traffic', why: 'from HUD traffic' };
    const huds = (hint && Array.isArray(hint.huds)) ? hint.huds : [];
    const [best] = mdnsCandidates(huds);
    if (!best) return null;
    const label = hudLabel(huds.find((h) => h && h.addr === best));
    return {
        addr: best,
        source: 'mdns',
        // Provenance LAST and unconditional, so the trust level is the part of
        // the line the operator can always rely on.
        why: label ? `${label} · found on network` : 'found on network',
    };
}

// Merge candidate lists in priority order, deduped, valid-only.
export function mergeCandidates(...lists) {
    const seen = new Set();
    const out = [];
    for (const list of lists) {
        for (const addr of list || []) {
            if (!isValidIpv4(addr) || seen.has(addr)) continue;
            seen.add(addr);
            out.push(addr);
        }
    }
    return out;
}
