// Address-provider seam for the iPhone destination (W2 telemetry). ESM.
// Every provider yields CANDIDATES the user must still confirm by hand —
// nothing here (or downstream) applies an address without confirmation.
//
// Providers today: manual entry (validated) and the last-sender hint surfaced
// by main's diagnostic seam. mDNS/Bonjour discovery is a declared stub: it
// plugs in HERE once the iPhone app advertises itself — see
// docs/proposals/iphone_mdns_discovery.md (Codex-owned contract, coordinated
// change; the Windows side must not build against an unconfirmed service).

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

// mDNS stub — returns no candidates until the coordinated milestone lands.
export function mdnsCandidates() {
    return [];
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
