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
    parseNetshInterfaces,
    parseNetshInterfacesList,
    parseNetshProfiles,
    buildWlanProfileXml,
} = require('../shared/wifiParse.js');
const { runCommand } = require('./runCommand.js');

const JOIN_POLL_MS = 1000;
const JOIN_TIMEOUT_MS = 20000;

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
    // can offer a picker when there is more than one. Empty off-Windows.
    async listInterfaces() {
        if (this._platform !== 'win32') return [];
        const res = await this._run('netsh', ['wlan', 'show', 'interfaces']);
        if (!res.ok) {
            this._log(`[wifi] interface list failed: ${res.stderr || res.stdout}`);
            return [];
        }
        return parseNetshInterfacesList(res.stdout);
    }

    // `iface` (optional) pins the operation to one WLAN adapter; netsh uses
    // its default interface when omitted — the pre-picker behavior.
    async scan({ iface } = {}) {
        if (this._platform !== 'win32') return [];
        const ifaceArg = iface ? [`interface=${iface}`] : [];
        const [networksRes, profilesRes] = await Promise.all([
            this._run('netsh', ['wlan', 'show', 'networks', 'mode=bssid', ...ifaceArg]),
            this._run('netsh', ['wlan', 'show', 'profiles']),
        ]);
        if (!networksRes.ok) {
            this._log(`[wifi] scan failed: ${networksRes.stderr || networksRes.stdout}`);
            return [];
        }
        const known = new Set(
            (profilesRes.ok ? parseNetshProfiles(profilesRes.stdout) : []).map((n) => n.toLowerCase()),
        );
        return parseNetshNetworks(networksRes.stdout).map((n) => ({
            ...n,
            known: known.has(n.ssid.toLowerCase()),
        }));
    }

    // Join a network. With a password, install a WPA2-PSK profile first via a
    // temp XML file (deleted afterwards — it contains the key). Then connect
    // and poll `show interfaces` until the SSID is up or we time out.
    async join({ ssid, password, iface } = {}) {
        if (this._platform !== 'win32') return { ok: false, error: 'wifi join is Windows-only' };
        if (!ssid || typeof ssid !== 'string') return { ok: false, error: 'ssid required' };
        const ifaceArg = iface ? [`interface=${iface}`] : [];

        if (password) {
            const profilePath = path.join(this._tmpDir, `w17-wlan-${Date.now()}.xml`);
            fs.writeFileSync(profilePath, buildWlanProfileXml(ssid, password), 'utf8');
            try {
                const add = await this._run('netsh', ['wlan', 'add', 'profile', `filename=${profilePath}`, ...ifaceArg]);
                if (!add.ok) {
                    return { ok: false, error: `add profile failed: ${(add.stderr || add.stdout).trim()}` };
                }
            } finally {
                try { fs.unlinkSync(profilePath); } catch { /* already gone */ }
            }
        }

        const connect = await this._run('netsh', ['wlan', 'connect', `name=${ssid}`, ...ifaceArg]);
        if (!connect.ok) {
            return { ok: false, error: `connect failed: ${(connect.stderr || connect.stdout).trim()}` };
        }

        const deadline = Date.now() + JOIN_TIMEOUT_MS;
        while (Date.now() < deadline) {
            await this._sleep(JOIN_POLL_MS);
            const status = await this.status();
            if (status.connected && status.ssid === ssid) {
                this._log(`[wifi] joined ${ssid}`);
                return { ok: true };
            }
        }
        return { ok: false, error: `not connected to ${ssid} after ${JOIN_TIMEOUT_MS / 1000}s` };
    }

    // Connection status + the machine's IPv4s (every platform — guide mode's
    // VERIFY button uses the address list even where netsh doesn't exist).
    async status() {
        const adapterIps = [];
        const ifs = os.networkInterfaces();
        for (const [name, addrs] of Object.entries(ifs)) {
            for (const a of addrs || []) {
                if (a.family === 'IPv4' && !a.internal) adapterIps.push({ name, addr: a.address });
            }
        }
        if (this._platform !== 'win32') {
            return { connected: false, ssid: '', signalPct: null, adapterIps };
        }
        const res = await this._run('netsh', ['wlan', 'show', 'interfaces']);
        const parsed = res.ok
            ? parseNetshInterfaces(res.stdout)
            : { connected: false, ssid: '', signalPct: null };
        return { ...parsed, adapterIps };
    }
}

module.exports = { WifiManager };
