// Local hotspot for the PIT WALL "dongle" path: the ground station creates the
// network and the iPhone joins it. Two Windows backends behind one interface:
//
//  1. `mobile`  — Windows Mobile Hotspot (WinRT NetworkOperatorTetheringManager
//     via PowerShell). The supported modern path, but it tethers an existing
//     connection profile and may refuse when none exists.
//  2. `hosted`  — legacy `netsh wlan hostednetwork`. Deprecated, but the
//     RT5370 USB dongle's driver family still supports it, making it the
//     credible offline fallback. Needs elevation; detected and surfaced.
//
// probeBackends() picks at PIT WALL entry; start() tries the chosen backend
// and falls back. Everything soft-fails with a reason string — the GRID
// reachability check is the ground truth, never this module's optimism.
//
// SECURITY: SSID/password are user input. They reach PowerShell via process
// ENVIRONMENT VARIABLES (read as $env:… inside a fixed script) and netsh via
// argv elements — never interpolated into any command/script text.

const os = require('node:os');
const { parseNetshDrivers } = require('../shared/wifiParse.js');
const { runCommand } = require('./runCommand.js');

// Fixed PowerShell scripts (no user input in the text — see header).
const PS_AWAIT_HELPER = `
$code = [Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime]
$profile = [Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile()
if ($profile -eq $null) { Write-Output 'NO_PROFILE'; exit 2 }
$manager = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager,Windows.Networking.NetworkOperators,ContentType=WindowsRuntime]::CreateFromConnectionProfile($profile)
function Await($WinRtTask, $ResultType) {
    $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
    $netTask = $asTask.MakeGenericMethod($ResultType).Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}
`;

const PS_PROBE = `${PS_AWAIT_HELPER}
Write-Output 'TETHER_OK'
`;

const PS_START = `${PS_AWAIT_HELPER}
$config = $manager.GetCurrentAccessPointConfiguration()
$config.Ssid = $env:W17_HOTSPOT_SSID
$config.Passphrase = $env:W17_HOTSPOT_PASS
Await ($manager.ConfigureAccessPointAsync($config)) ([Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult]) | Out-Null
$result = Await ($manager.StartTetheringAsync()) ([Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult])
Write-Output ("START_" + $result.Status)
`;

const PS_STOP = `${PS_AWAIT_HELPER}
$result = Await ($manager.StopTetheringAsync()) ([Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult])
Write-Output ("STOP_" + $result.Status)
`;

const psArgs = (script) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];

// Both backends end up on the ICS subnet in practice; report the host address
// the iPhone should expect to see as the gateway.
function icsHostIp() {
    for (const addrs of Object.values(os.networkInterfaces())) {
        for (const a of addrs || []) {
            if (a.family === 'IPv4' && !a.internal && a.address.startsWith('192.168.137.')) {
                return a.address;
            }
        }
    }
    return null;
}

class HotspotManager {
    constructor({ run = runCommand, log = () => {}, platform = process.platform } = {}) {
        this._run = run;
        this._log = log;
        this._platform = platform;
        this._activeBackend = null;
    }

    async probeBackends() {
        if (this._platform !== 'win32') {
            return { canHotspot: false, mobile: false, hosted: false, preferred: null };
        }
        const [psRes, driversRes] = await Promise.all([
            this._run('powershell', psArgs(PS_PROBE), { timeoutMs: 20000 }),
            this._run('netsh', ['wlan', 'show', 'drivers']),
        ]);
        const mobile = psRes.ok && psRes.stdout.includes('TETHER_OK');
        const hostedSupport = driversRes.ok
            ? parseNetshDrivers(driversRes.stdout).hostedNetworkSupported
            : null;
        const hosted = hostedSupport !== false; // null = unknown -> still worth trying
        const preferred = mobile ? 'mobile' : hosted ? 'hosted' : null;
        this._log(`[hotspot] probe: mobile=${mobile} hosted=${String(hostedSupport)} -> ${preferred || 'none'}`);
        return { canHotspot: !!preferred, mobile, hosted, preferred };
    }

    async start({ ssid, password } = {}) {
        if (this._platform !== 'win32') return { ok: false, error: 'hotspot is Windows-only' };
        if (!ssid || !password || password.length < 8) {
            return { ok: false, error: 'hotspot needs an SSID and a password of 8+ chars (WPA2)' };
        }
        const probe = await this.probeBackends();
        if (probe.mobile) {
            const res = await this._start_mobile(ssid, password);
            if (res.ok) return res;
            this._log(`[hotspot] mobile backend failed (${res.error}); trying hostednetwork`);
        }
        if (probe.hosted) return this._start_hosted(ssid, password);
        return { ok: false, error: 'no hotspot backend available on this machine (join a network instead)' };
    }

    async _start_mobile(ssid, password) {
        const res = await this._run('powershell', psArgs(PS_START), {
            timeoutMs: 30000,
            env: { W17_HOTSPOT_SSID: ssid, W17_HOTSPOT_PASS: password },
        });
        if (res.stdout.includes('START_Success') || res.stdout.includes('START_0')) {
            this._activeBackend = 'mobile';
            return { ok: true, method: 'mobile', ssid, hostIp: icsHostIp() };
        }
        return { ok: false, error: (res.stdout + res.stderr).trim().slice(0, 300) || 'mobile hotspot refused' };
    }

    async _start_hosted(ssid, password) {
        const set = await this._run('netsh', [
            'wlan', 'set', 'hostednetwork', 'mode=allow', `ssid=${ssid}`, `key=${password}`,
        ]);
        if (!set.ok) {
            return { ok: false, error: `hostednetwork config failed: ${(set.stderr || set.stdout).trim()}` };
        }
        const start = await this._run('netsh', ['wlan', 'start', 'hostednetwork']);
        if (!start.ok) {
            const text = (start.stderr || start.stdout).toLowerCase();
            const needsElevation = /denied|elevat|administrator/.test(text);
            return {
                ok: false,
                needsElevation,
                error: needsElevation
                    ? 'hostednetwork needs elevation — run the ground station as administrator'
                    : `hostednetwork start failed: ${(start.stderr || start.stdout).trim()}`,
            };
        }
        this._activeBackend = 'hosted';
        return { ok: true, method: 'hosted', ssid, hostIp: icsHostIp() };
    }

    async stop() {
        if (this._platform !== 'win32' || !this._activeBackend) return { ok: true };
        const backend = this._activeBackend;
        this._activeBackend = null;
        if (backend === 'mobile') {
            const res = await this._run('powershell', psArgs(PS_STOP), { timeoutMs: 20000 });
            return { ok: res.ok };
        }
        const res = await this._run('netsh', ['wlan', 'stop', 'hostednetwork']);
        return { ok: res.ok };
    }
}

module.exports = { HotspotManager };
