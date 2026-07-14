// Pure parsers for Windows `netsh wlan` output + the WLAN profile XML builder.
// CommonJS, Electron-free — main/wifiManager.js owns the spawning; everything
// here runs on captured text so it unit-tests against fixtures (EN + non-EN).
//
// Localization strategy: netsh labels are localized, so parsing keys off
// STRUCTURE, not label text, wherever possible — "SSID n :" and "BSSID n :"
// markers are literal in every locale, percentages are recognizable by the
// trailing %, and field ORDER within a network block is stable. Where a label
// really is the only signal (hosted-network support) the match is loose and
// the result is allowed to be null = unknown, degrading to guide mode.

// A "field line" is `    <label> : <value>` — label text ignored on purpose.
const FIELD_RE = /^\s+(.+?)\s*:\s*(.*)$/;
const SSID_RE = /^\s*SSID\s+\d+\s*:\s*(.*)$/;
const BSSID_RE = /^\s*BSSID\s+\d+\s*:/;
const PERCENT_RE = /^(\d{1,3})\s*%/;

// `netsh wlan show networks mode=bssid` ->
//   [{ ssid, signalPct, auth, encryption, security, bssidCount }]
// auth = the SECOND field after the SSID marker, encryption = the THIRD (order:
// network type, authentication, encryption — stable across locales); signal =
// the max percentage in the block; `security` = the normalized kind derived
// from auth+encryption (classifyWifiSecurity). Raw auth/encryption are kept for
// diagnostics; UI + manager logic branch on `security`, never localized prose.
function parseNetshNetworks(text) {
    const networks = [];
    let current = null;
    let fieldIdx = 0;
    for (const line of String(text).split(/\r?\n/)) {
        const ssidMatch = line.match(SSID_RE);
        if (ssidMatch) {
            current = { ssid: ssidMatch[1].trim(), signalPct: null, auth: '', encryption: '', bssidCount: 0 };
            networks.push(current);
            fieldIdx = 0;
            continue;
        }
        if (!current) continue;
        if (BSSID_RE.test(line)) {
            current.bssidCount += 1;
            continue;
        }
        const field = line.match(FIELD_RE);
        if (!field) continue;
        const value = field[2].trim();
        const pct = value.match(PERCENT_RE);
        if (pct) {
            const signal = Math.min(100, Number(pct[1]));
            if (current.signalPct === null || signal > current.signalPct) {
                current.signalPct = signal;
            }
            continue;
        }
        fieldIdx += 1;
        if (fieldIdx === 2) current.auth = value;            // authentication, by position
        else if (fieldIdx === 3) current.encryption = value; // encryption, by position
    }
    // A visible network without an SSID (or a whitespace-only one) is a hidden
    // AP or a malformed block; drop it so an unnamed row is never offered. The
    // survivors get a normalized `security` kind for the UI + manager (audit B3).
    return networks
        .filter((n) => n.ssid.length > 0)
        .map((n) => ({ ...n, security: classifyWifiSecurity(n) }));
}

// Normalized Wi-Fi security model (audit B3). Derived STRUCTURALLY from the
// netsh Authentication + Encryption fields so the renderer and manager branch
// on a stable kind, never on localized prose:
//   'open'                 - no encryption, no key needed (join warns: unencrypted)
//   'wpa2-personal'        - WPA2-PSK (the supported secured case)
//   'wpa2-wpa3-transition' - an AP advertising BOTH WPA2 and WPA3; Windows uses
//                            the WPA2 path, so it is joinable as WPA2
//   'wpa3-only'            - WPA3-SAE only (no WPA2 fallback) - NOT supported
//   'enterprise'           - 802.1X/EAP (needs credentials we don't handle)
//   'unknown'              - legacy WPA1, WEP, or anything unrecognized
//
// The protocol tokens (WPA2/WPA3/Enterprise) are latin identifiers netsh keeps
// across locales (the repo's German fixtures show verbatim "WPA2-Personal").
// "Open"/"None" ARE localized, so open is recognized by a small multi-locale
// word set corroborated by the encryption field; anything we cannot place stays
// 'unknown' (safe - it yields a controlled error, never a raw netsh one).
//
// Transition classification (documented per audit B3): a WPA2/WPA3 transition
// AP most commonly reports Authentication "WPA2-Personal" (the mode Windows
// actually uses) -> 'wpa2-personal' (joinable). A COMBINED token carrying both
// "WPA2" and "WPA3" -> 'wpa2-wpa3-transition' (still joinable over WPA2). Only a
// string with WPA3 and NO WPA2 is 'wpa3-only' (rejected) - we never call a
// compatible WPA2 path unsupported.
const OPEN_AUTH_RE = /\b(open|offen|ouvert|abiert|abert|otwart|otevřen|nyitott|açık|acik|åpent|öppet)/i;
const NONE_ENC_RE = /\b(none|keine|aucun|ninguna|nenhum|ingen|brak|žádné|yok)\b/i;

function classifyWifiSecurity({ auth = '', encryption = '' } = {}) {
    const a = String(auth).toLowerCase();
    const e = String(encryption).toLowerCase();
    if (/enterprise|802\.1x|\beap\b/.test(a)) return 'enterprise';
    const wpa3 = /wpa3/.test(a);
    const wpa2 = /wpa2/.test(a);
    if (wpa3 && wpa2) return 'wpa2-wpa3-transition';
    if (wpa3) return 'wpa3-only';
    if (wpa2) return 'wpa2-personal';
    // Legacy WPA1 ("WPA-Personal") - no reliable profile; unsupported.
    if (/wpa(?![23])/.test(a)) return 'unknown';
    // WEP reports Authentication "Open"/"Shared" but IS encrypted-legacy - never
    // classify it as our open (unencrypted) path.
    if (/\bwep\b/.test(a) || /\bwep\b/.test(e)) return 'unknown';
    // Open: the auth word says so, or the encryption field says there is none
    // (an unencrypted network is open by definition; WEP is already excluded).
    if (OPEN_AUTH_RE.test(a) || NONE_ENC_RE.test(e)) return 'open';
    return 'unknown';
}

// NOTE: there is deliberately NO merged whole-output interfaces parser here.
// An earlier `parseNetshInterfaces` scanned every adapter block as one text
// (last SSID won, first signal % won), so with two adapters the reported
// SSID and signal could come from DIFFERENT adapters and join verification
// depended on netsh enumeration order (audit M2). Adapter status must go
// through parseNetshInterfacesList and pick ONE block, so every field is
// guaranteed to describe the same adapter.

// `netsh wlan show interfaces` -> EVERY wlan adapter on the machine:
// [{ name, description, connected, ssid, signalPct }]. Blocks are separated
// by blank lines and the FIRST field line of a block is the adapter name in
// every locale (label text ignored on purpose, like the rest of this file).
// "SSID" is a literal acronym in every locale; connectedness is inferred
// from a non-empty SSID value in the block (the localized State field is
// not trusted), so a still-associating adapter without an SSID line simply
// reads as not connected yet.
// The trailing "Hosted network status" line some Windows builds append forms
// a 1–2 field pseudo-block; real adapters always have many fields (Name,
// Description, GUID, MAC, …), so short blocks are dropped.
const MIN_IFACE_FIELDS = 3;
function parseNetshInterfacesList(text) {
    const blocks = [];
    let current = null;
    for (const line of String(text).split(/\r?\n/)) {
        if (!line.trim()) { current = null; continue; }
        const field = line.match(FIELD_RE);
        if (!field) continue;
        const label = field[1].trim();
        const value = field[2].trim();
        if (!current) {
            current = {
                fields: 0,
                iface: { name: value, description: '', connected: false, ssid: '', signalPct: null },
            };
            blocks.push(current);
        }
        current.fields += 1;
        if (current.fields === 2) current.iface.description = value;
        if (/^SSID$/i.test(label) && value) {
            current.iface.ssid = value;
            current.iface.connected = true;
        }
        const pct = value.match(PERCENT_RE);
        if (pct && current.iface.signalPct === null) {
            current.iface.signalPct = Math.min(100, Number(pct[1]));
        }
    }
    return blocks
        .filter((b) => b.fields >= MIN_IFACE_FIELDS && b.iface.name.length > 0)
        .map((b) => b.iface);
}

// `netsh wlan show profiles` -> [profile names]. Every profile renders as an
// indented `<label> : <name>` line; header/section lines have no ` : value`.
function parseNetshProfiles(text) {
    const names = [];
    for (const line of String(text).split(/\r?\n/)) {
        const field = line.match(/^\s{2,}(.+?)\s+:\s+(.+?)\s*$/);
        if (field) names.push(field[2]);
    }
    return names;
}

// `netsh wlan show drivers` -> { hostedNetworkSupported: true | false | null }
// The label is localized but keeps the latin word "host" in every locale we
// could check (EN "Hosted network supported", DE "Gehostetes Netzwerk
// unterstützt", …). Unknown -> null; the caller treats null as "prefer the
// Mobile Hotspot backend / degrade to guide mode", never as a hard no.
const YES_WORDS = /^(yes|ja|oui|s[ií]|sim|da|да|tak|evet)\b/i;
const NO_WORDS = /^(no|nein|non|nao|não|nie|нет|hay[ıi]r)\b/i;

function parseNetshDrivers(text) {
    let supported = null;
    for (const line of String(text).split(/\r?\n/)) {
        const field = line.match(FIELD_RE);
        if (!field) continue;
        if (!/host/i.test(field[1])) continue;
        const value = field[2].trim();
        if (YES_WORDS.test(value)) supported = true;
        else if (NO_WORDS.test(value)) supported = false;
    }
    return { hostedNetworkSupported: supported };
}

// WLAN profile XML for `netsh wlan add profile` (WPA2-Personal/AES — the
// setup flow's join-with-password path). SSID and key are UNTRUSTED USER
// INPUT: they are XML-escaped here and must always be passed to netsh as
// argv elements, never through a shell string.
function xmlEscape(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function buildWlanProfileXml(ssid, password) {
    const name = xmlEscape(ssid);
    const key = xmlEscape(password);
    return `<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
    <name>${name}</name>
    <SSIDConfig><SSID><name>${name}</name></SSID></SSIDConfig>
    <connectionType>ESS</connectionType>
    <connectionMode>manual</connectionMode>
    <MSM><security>
        <authEncryption>
            <authentication>WPA2PSK</authentication>
            <encryption>AES</encryption>
            <useOneX>false</useOneX>
        </authEncryption>
        <sharedKey>
            <keyType>passPhrase</keyType>
            <protected>false</protected>
            <keyMaterial>${key}</keyMaterial>
        </sharedKey>
    </security></MSM>
</WLANProfile>
`;
}

// WLAN profile XML for an OPEN network (audit B3): authentication=open,
// encryption=none, NO key. A discovered open network without a saved Windows
// profile cannot be joined by `netsh wlan connect name=X` (there is nothing to
// connect to), so the manager installs this first. There is no credential to
// leak; the SSID is still UNTRUSTED USER INPUT and is XML-escaped, and it must
// always reach netsh as argv elements, never through a shell string.
function buildOpenWlanProfileXml(ssid) {
    const name = xmlEscape(ssid);
    return `<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
    <name>${name}</name>
    <SSIDConfig><SSID><name>${name}</name></SSID></SSIDConfig>
    <connectionType>ESS</connectionType>
    <connectionMode>manual</connectionMode>
    <MSM><security>
        <authEncryption>
            <authentication>open</authentication>
            <encryption>none</encryption>
            <useOneX>false</useOneX>
        </authEncryption>
    </security></MSM>
</WLANProfile>
`;
}

module.exports = {
    parseNetshNetworks,
    parseNetshInterfacesList,
    parseNetshProfiles,
    parseNetshDrivers,
    classifyWifiSecurity,
    buildWlanProfileXml,
    buildOpenWlanProfileXml,
    xmlEscape,
};
