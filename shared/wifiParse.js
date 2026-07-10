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

// `netsh wlan show networks mode=bssid` -> [{ ssid, signalPct, auth, bssidCount }]
// auth = the SECOND field after the SSID marker (order: network type,
// authentication, encryption — stable across locales); signal = the max
// percentage value seen in the block.
function parseNetshNetworks(text) {
    const networks = [];
    let current = null;
    let fieldIdx = 0;
    for (const line of String(text).split(/\r?\n/)) {
        const ssidMatch = line.match(SSID_RE);
        if (ssidMatch) {
            current = { ssid: ssidMatch[1].trim(), signalPct: null, auth: '', bssidCount: 0 };
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
        if (fieldIdx === 2) current.auth = value; // authentication, by position
    }
    // A visible network without an SSID is a hidden AP; drop empties.
    return networks.filter((n) => n.ssid.length > 0);
}

// `netsh wlan show interfaces` -> { connected, ssid, signalPct }
// "SSID" is a literal acronym in every locale; connectedness is inferred from
// a non-empty SSID value (the localized State field is not trusted).
function parseNetshInterfaces(text) {
    let ssid = '';
    let signalPct = null;
    for (const line of String(text).split(/\r?\n/)) {
        const field = line.match(FIELD_RE);
        if (!field) continue;
        const label = field[1].trim();
        const value = field[2].trim();
        if (/^SSID$/i.test(label) && value) ssid = value;
        const pct = value.match(PERCENT_RE);
        if (pct && signalPct === null) signalPct = Math.min(100, Number(pct[1]));
    }
    return { connected: ssid.length > 0, ssid, signalPct };
}

// `netsh wlan show interfaces` -> EVERY wlan adapter on the machine:
// [{ name, description, connected, ssid, signalPct }]. Blocks are separated
// by blank lines and the FIRST field line of a block is the adapter name in
// every locale (label text ignored on purpose, like the rest of this file).
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

module.exports = {
    parseNetshNetworks,
    parseNetshInterfaces,
    parseNetshInterfacesList,
    parseNetshProfiles,
    parseNetshDrivers,
    buildWlanProfileXml,
    xmlEscape,
};
