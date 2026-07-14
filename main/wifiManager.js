// Windows WiFi operations for the PIT WALL setup step: scan visible networks,
// join one (adding a temp profile when a password is supplied), and report
// connection status. Thin IO in the repo style — every parser lives in
// shared/wifiParse.js and runs on captured text; this file only spawns netsh
// (argv arrays, never a shell string: SSIDs/passwords are user input) and
// glues results together.
//
// Non-Windows platforms report no capabilities and the renderer shows guide
// mode (instructions + verify) — the macOS dev machine still exercises the
// whole flow, just without OS control.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    parseNetshNetworks,
    parseNetshInterfacesList,
    parseNetshProfiles,
    buildWlanProfileXml,
    buildOpenWlanProfileXml,
} = require('../shared/wifiParse.js');
const { runCommand } = require('./runCommand.js');

const JOIN_POLL_MS = 1000;
const JOIN_TIMEOUT_MS = 20000;

// User-facing rejection messages for network kinds outside the supported scope
// (audit B3 / decision Q3). Kept short and locale-neutral; they are the
// controlled alternative to a raw netsh failure.
const WPA3_MSG = 'WPA3-only networks are not currently supported. Use a WPA2 network or start the W17 hotspot.';
const ENTERPRISE_MSG = 'Enterprise (802.1X) networks are not currently supported. Use a WPA2 network or start the W17 hotspot.';
const HIDDEN_MSG = 'Hidden or unnamed networks are not supported. Pick a listed network or start the W17 hotspot.';
// Byte-identical to shared/wifiView.mjs UNKNOWN_SECURITY_MESSAGE (kept in sync by
// test/wifiView.test.js + test/wifiManager.test.js pinning the exact wording).
const UNKNOWN_SECURITY_MSG = 'This network’s security type could not be identified. Use a known WPA2 network or start the W17 hotspot.';

// Failure reason for the UI: netsh writes errors to either stream; cap the
// length so a rambling localized message can't blow up a status line.
const failReason = (res) => String(res.stderr || res.stdout || '').trim().slice(0, 200) || 'command failed';

class WifiManager {
    constructor({ tmpDir = os.tmpdir(), run = runCommand, log = () => {}, platform = process.platform, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
        this._tmpDir = tmpDir;
        this._run = run;
        this._log = log;
        this._platform = platform;
        this._sleep = sleep;
    }

    capabilities() {
        const win = this._platform === 'win32';
        return { platform: this._platform, canScan: win, canJoin: win };
    }

    // All WLAN adapters on the machine (built-in + dongles) so the setup UI
    // can offer a picker when there is more than one. A netsh failure returns
    // ok:false WITH the reason — the UI must be able to tell "listing broke"
    // from "no adapters". Off-Windows is ok:true/empty (no capability is not
    // an error; the renderer shows guide mode).
    async listInterfaces() {
        if (this._platform !== 'win32') return { ok: true, ifaces: [] };
        const res = await this._run('netsh', ['wlan', 'show', 'interfaces']);
        if (!res.ok) {
            const error = failReason(res);
            this._log(`[wifi] interface list failed: ${error}`);
            return { ok: false, ifaces: [], error };
        }
        return { ok: true, ifaces: parseNetshInterfacesList(res.stdout) };
    }

    // `iface` (optional) pins the operation to one WLAN adapter; netsh uses
    // its default interface when omitted — the pre-picker behavior. Like
    // listInterfaces, a failed scan is ok:false WITH the reason — "SCAN
    // FAILED" and "no networks in the air" are different answers.
    async scan({ iface } = {}) {
        if (this._platform !== 'win32') return { ok: true, networks: [] };
        const ifaceArg = iface ? [`interface=${iface}`] : [];
        const [networksRes, profilesRes] = await Promise.all([
            this._run('netsh', ['wlan', 'show', 'networks', 'mode=bssid', ...ifaceArg]),
            this._run('netsh', ['wlan', 'show', 'profiles']),
        ]);
        if (!networksRes.ok) {
            const error = failReason(networksRes);
            this._log(`[wifi] scan failed: ${error}`);
            return { ok: false, networks: [], error };
        }
        const known = new Set(
            (profilesRes.ok ? parseNetshProfiles(profilesRes.stdout) : []).map((n) => n.toLowerCase()),
        );
        const networks = parseNetshNetworks(networksRes.stdout).map((n) => ({
            ...n,
            known: known.has(n.ssid.toLowerCase()),
        }));
        return { ok: true, networks };
    }

    // Join a network. Scope + profile handling depend on the normalized
    // `security` kind (audit B3 / decision Q3):
    //   - wpa3-only / enterprise → rejected BEFORE any OS call, with a
    //     controlled message and a stable `kind` (never a raw netsh error).
    //   - an empty/whitespace SSID (a hidden AP routed through an unsupported
    //     path) → `unsupported-hidden-network`.
    //   - open + not `known` → install a temp OPEN profile (no key) so
    //     `netsh wlan connect` has something to bind to.
    //   - a password → install a temp WPA2-PSK profile (deleted afterwards — it
    //     contains the key).
    //   - `known === false` + secured + no password → `password-required`
    //     (controlled), not a bare connect that netsh would reject.
    //   - otherwise (a saved profile) → connect directly.
    //
    // Verification is PINNED (audit M2): with `iface` given, success is judged
    // ONLY against that adapter's own interface block — a second adapter
    // holding another network (built-in on the home LAN while the RT5370
    // joins W17-GRID) can neither fake a success nor mask one, regardless of
    // netsh enumeration order. Connected means: the pinned block reports the
    // requested SSID (exact, case-sensitive — the target string comes from
    // the same netsh scan output, so real joins are byte-identical). An
    // adapter that vanishes mid-poll (USB re-enumeration) keeps being polled
    // until the deadline — it may come back — and the timeout error then
    // reports the LAST observed state honestly instead of a generic failure.
    async join({ ssid, password, iface, security, known } = {}) {
        if (this._platform !== 'win32') return { ok: false, error: 'wifi join is Windows-only' };
        if (typeof ssid !== 'string') return { ok: false, error: 'ssid required' };
        // An empty/whitespace SSID is a hidden or unnamed AP (the scan drops
        // these; this backstops any unsupported path that still routes one in).
        if (!ssid.trim()) return { ok: false, kind: 'unsupported-hidden-network', error: HIDDEN_MSG };
        if (security === 'wpa3-only') return { ok: false, kind: 'unsupported-wpa3', error: WPA3_MSG };
        if (security === 'enterprise') return { ok: false, kind: 'unsupported-enterprise', error: ENTERPRISE_MSG };
        // Unrecognized security: reject a NEW network conservatively — never build
        // a speculative WPA2 profile or attempt a connect. A network Windows
        // already has a saved profile for (known === true) is exempt: it connects
        // via that stored profile below, constructing nothing.
        if (security === 'unknown' && known !== true) {
            return { ok: false, kind: 'unsupported-unknown-security', error: UNKNOWN_SECURITY_MSG };
        }
        const ifaceArg = iface ? [`interface=${iface}`] : [];
        const isOpen = security === 'open';

        // Decide the temp profile to install (if any). An open network without a
        // saved profile needs an open-auth profile; a password means WPA2-PSK.
        let profileXml = null;
        if (isOpen && known !== true) profileXml = buildOpenWlanProfileXml(ssid);
        else if (password) profileXml = buildWlanProfileXml(ssid, password);
        else if (known === false && !isOpen) {
            // A secured network with no saved profile and no password can't be
            // built into a connectable profile — say so, rather than letting a
            // bare `connect` fail with a raw "profile not found".
            return { ok: false, kind: 'password-required', error: `${ssid} needs a Wi-Fi password.` };
        }

        if (profileXml) {
            // The WPA2 profile XML carries the passphrase, so the temp file it
            // rides in is created inside a PRIVATE per-join directory (mkdtemp,
            // 0700, unpredictable suffix) rather than a predictable name in the
            // shared tmpdir. This closes a symlink/pre-creation race on the
            // key-bearing file (CWE-377) and removes any same-millisecond
            // filename collision; a fixed inner name cannot escape the dir. The
            // WHOLE directory is removed in `finally` after success AND failure
            // (audit D4). An open-network profile has no key, but rides the same
            // safe path for consistency.
            const profileDir = fs.mkdtempSync(path.join(this._tmpDir, 'w17-wlan-'));
            const profilePath = path.join(profileDir, 'profile.xml');
            fs.writeFileSync(profilePath, profileXml, { encoding: 'utf8', mode: 0o600 });
            try {
                const add = await this._run('netsh', ['wlan', 'add', 'profile', `filename=${profilePath}`, ...ifaceArg]);
                if (!add.ok) {
                    return { ok: false, error: `add profile failed: ${failReason(add)}` };
                }
            } finally {
                try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* already gone */ }
            }
        }

        const connect = await this._run('netsh', ['wlan', 'connect', `name=${ssid}`, ...ifaceArg]);
        if (!connect.ok) {
            return { ok: false, error: `connect failed: ${failReason(connect)}` };
        }

        const deadline = Date.now() + JOIN_TIMEOUT_MS;
        let last = null; // most recent poll only — stale polls never shape the result
        while (Date.now() < deadline) {
            await this._sleep(JOIN_POLL_MS);
            last = await this.status({ iface });
            if (last.connected && last.ssid === ssid) {
                this._log(`[wifi] joined ${ssid}${iface ? ` on ${iface}` : ''}`);
                return { ok: true };
            }
        }
        return { ok: false, error: this._joinTimeoutError(ssid, iface, last) };
    }

    // Honest, adapter-specific timeout wording from the final poll. Never
    // blames the network for a vanished adapter or a broken status check,
    // and never suggests another adapter's connection counts.
    _joinTimeoutError(ssid, iface, last) {
        const secs = `${JOIN_TIMEOUT_MS / 1000}s`;
        if (last && last.ok === false) {
            return `could not verify the join to ${ssid}: ${last.error}`;
        }
        if (iface && last && last.present === false) {
            return `adapter "${iface}" not detected after ${secs} — reconnect it and RESCAN`;
        }
        const where = iface ? ` on adapter "${iface}"` : '';
        const state = last && last.connected
            ? ` (currently connected to ${last.ssid})`
            : ' (adapter is not connected)';
        return `not connected to ${ssid}${where} after ${secs}${state}`;
    }

    // Connection status + the machine's IPv4s (every platform — guide mode's
    // VERIFY button uses the address list even where netsh doesn't exist).
    //
    // With `iface` given, EVERY connection field (connected/ssid/signalPct)
    // comes from that adapter's own block — never merged across adapters
    // (audit M2) — and a missing adapter is its own explicit result
    // (present:false + error), never another adapter's status. Without
    // `iface`, the aggregate answer is the first CONNECTED adapter's block,
    // still coherent: ssid and signal always describe the same adapter.
    async status({ iface } = {}) {
        const adapterIps = [];
        const ifs = os.networkInterfaces();
        for (const [name, addrs] of Object.entries(ifs)) {
            for (const a of addrs || []) {
                if (a.family === 'IPv4' && !a.internal) adapterIps.push({ name, addr: a.address });
            }
        }
        const disconnected = { connected: false, ssid: '', signalPct: null };
        if (this._platform !== 'win32') {
            return { ok: true, ...disconnected, adapterIps };
        }
        const res = await this._run('netsh', ['wlan', 'show', 'interfaces']);
        if (!res.ok) {
            // A failed status check is NOT "not connected" — say what broke so
            // join verification and the guide-mode VERIFY can report honestly.
            const error = failReason(res);
            this._log(`[wifi] status check failed: ${error}`);
            return { ok: false, ...disconnected, adapterIps, error };
        }
        const ifaces = parseNetshInterfacesList(res.stdout);
        if (iface) {
            const found = ifaces.find((i) => i.name === iface);
            if (!found) {
                return {
                    ok: true, iface, present: false, ...disconnected, adapterIps,
                    error: `adapter "${iface}" not detected`,
                };
            }
            return {
                ok: true, iface: found.name, present: true,
                connected: found.connected, ssid: found.ssid, signalPct: found.signalPct,
                adapterIps,
            };
        }
        const active = ifaces.find((i) => i.connected);
        if (!active) return { ok: true, ...disconnected, adapterIps };
        return {
            ok: true, iface: active.name,
            connected: true, ssid: active.ssid, signalPct: active.signalPct,
            adapterIps,
        };
    }
}

module.exports = { WifiManager };
