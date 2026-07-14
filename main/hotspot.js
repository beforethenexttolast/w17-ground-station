// Local hotspot for the PIT WALL "dongle" path: the ground station creates the
// network and the iPhone joins it. Two Windows backends behind one interface:
//
//  1. `mobile`  — Windows Mobile Hotspot (WinRT NetworkOperatorTetheringManager
//     via PowerShell). The supported modern path, but it tethers an existing
//     connection profile and may refuse when none exists.
//  2. `hosted`  — legacy `netsh wlan hostednetwork`. Deprecated, but the
//     RT5370 USB dongle's driver family still supports it, making it the
//     credible offline fallback. Often needs elevation; when a start fails we
//     surface an administrator SUGGESTION from a locale-neutral elevation
//     token (never asserted as the cause — see the B2 note below).
//
// probeBackends() picks at PIT WALL entry; start() tries the chosen backend
// and falls back where that cannot mask a distinct failure. Everything
// soft-fails with a structured reason — the GRID reachability check is the
// ground truth, never this module's optimism.
//
// FAIL-CLOSED POWERSHELL (audit H1). The WinRT scripts are written for a stock
// `powershell.exe -NoProfile` (Windows PowerShell 5.1) environment:
//  - `$ErrorActionPreference = 'Stop'` + try/catch around every stage;
//  - `Add-Type -AssemblyName System.Runtime.WindowsRuntime` is loaded
//    explicitly (the AsTask extension methods live there and are NOT loaded
//    by default in a fresh session);
//  - `Await` handles IAsyncOperation<T>; `AwaitAction` handles IAsyncAction —
//    ConfigureAccessPointAsync returns IAsyncAction and must never be fed to
//    the generic awaiter;
//  - configuration failure exits BEFORE StartTetheringAsync is ever invoked,
//    so a failed configure can never start tethering with the OLD
//    Windows-configured SSID/password;
//  - the success token (START_OK) is printed only after the started SSID is
//    read back and matches the requested one;
//  - scripts contain NO double-quote characters, so argv quoting across
//    spawn() cannot corrupt them.
// Token vocabulary (stdout): RESULT_NO_PROFILE, RESULT_SETUP_ERROR, PROBE_OK,
// PROBE_STATE_<state>, START_ALREADY_ON, START_CONFIG_FAILED, START_ERROR,
// START_FAILED_<status>, START_CONFIG_MISMATCH, START_OK, STOP_ERROR,
// STOP_FAILED_<status>, STOP_OK, ELEV_ADMIN, ELEV_LIMITED, ELEV_ERROR.
// Mocked tests pin the script structure and the token handling; the WinRT
// behavior itself is bench-verified only (docs/setup_flow_bench_checklist.md §3).
//
// LOCALE-NEUTRAL ERRORS (audit B2). No branch in this module matches
// localized netsh/PowerShell prose (the old English-keyword elevation sniff
// broke on non-English Windows). Classification uses exit state and
// fixed stdout tokens only; where Windows exposes no locale-neutral cause
// (hostednetwork start failure), the result is a generic 'start-failed' plus
// a structured elevation FACT (the process token, via PS_ELEV) that drives a
// troubleshooting SUGGESTION — never an asserted diagnosis. Raw localized
// text is retained (sanitized, capped) as diagnostic detail only.
//
// SECURITY: SSID/password are user input. They reach PowerShell via process
// ENVIRONMENT VARIABLES (read as $env:… inside a fixed script) and netsh via
// argv elements — never interpolated into any command/script text, and never
// echoed into logs or error strings by this module.

const os = require('node:os');
const { parseNetshDrivers } = require('../shared/wifiParse.js');
const { runCommand } = require('./runCommand.js');

// Shared prologue: strict errors, WinRT awaiters, tethering manager. Every
// script is single-quote-only (see header). `$connProfile` deliberately does
// not shadow PowerShell's automatic $PROFILE.
const PS_COMMON = `$ErrorActionPreference = 'Stop'
function Await($WinRtTask, $ResultType) {
    $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
    $netTask = $asTask.MakeGenericMethod($ResultType).Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}
function AwaitAction($WinRtAction) {
    $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and (-not $_.IsGenericMethod) -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
    $netTask = $asTask.Invoke($null, @($WinRtAction))
    $netTask.Wait(-1) | Out-Null
}
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime]
    $null = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager,Windows.Networking.NetworkOperators,ContentType=WindowsRuntime]
    $connProfile = [Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile()
    if ($connProfile -eq $null) { Write-Output 'RESULT_NO_PROFILE'; exit 2 }
    $manager = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]::CreateFromConnectionProfile($connProfile)
} catch {
    Write-Output ('RESULT_SETUP_ERROR ' + $_.Exception.Message)
    exit 1
}
`;

const PS_PROBE = `${PS_COMMON}
Write-Output ('PROBE_STATE_' + $manager.TetheringOperationalState)
Write-Output 'PROBE_OK'
`;

const PS_START = `${PS_COMMON}
if ($manager.TetheringOperationalState.ToString() -eq 'On') {
    Write-Output 'START_ALREADY_ON'
    exit 5
}
try {
    $config = $manager.GetCurrentAccessPointConfiguration()
    $config.Ssid = $env:W17_HOTSPOT_SSID
    $config.Passphrase = $env:W17_HOTSPOT_PASS
    AwaitAction ($manager.ConfigureAccessPointAsync($config))
} catch {
    Write-Output ('START_CONFIG_FAILED ' + $_.Exception.Message)
    exit 3
}
try {
    $result = Await ($manager.StartTetheringAsync()) ([Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult])
} catch {
    Write-Output ('START_ERROR ' + $_.Exception.Message)
    exit 1
}
if ($result.Status.ToString() -ne 'Success') {
    Write-Output ('START_FAILED_' + $result.Status + ' ' + $result.AdditionalErrorMessage)
    exit 4
}
$applied = $manager.GetCurrentAccessPointConfiguration()
if ($applied.Ssid -ne $env:W17_HOTSPOT_SSID) {
    Write-Output 'START_CONFIG_MISMATCH'
    exit 6
}
Write-Output 'START_OK'
`;

const PS_STOP = `${PS_COMMON}
try {
    $result = Await ($manager.StopTetheringAsync()) ([Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult])
} catch {
    Write-Output ('STOP_ERROR ' + $_.Exception.Message)
    exit 1
}
if ($result.Status.ToString() -ne 'Success') {
    Write-Output ('STOP_FAILED_' + $result.Status)
    exit 4
}
Write-Output 'STOP_OK'
`;

// Locale-neutral elevation FACT (audit B2): the process token, not localized
// error prose. Standalone (no WinRT prologue needed) and single-quote-only
// like the others. Consulted only after a hostednetwork start failure to
// decide whether the administrator SUGGESTION is worth showing — an elevated
// process that still failed must not be told to elevate.
const PS_ELEV = `$ErrorActionPreference = 'Stop'
try {
    $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object System.Security.Principal.WindowsPrincipal($id)
    if ($principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Output 'ELEV_ADMIN'
    } else {
        Write-Output 'ELEV_LIMITED'
    }
} catch {
    Write-Output ('ELEV_ERROR ' + $_.Exception.Message)
    exit 1
}
`;

// Exported for the static structure tests (test/hotspot.test.js) and the
// bench diagnostic (scripts/hotspot-diag.js). Not part of the manager API.
const PS_SCRIPTS = Object.freeze({ probe: PS_PROBE, start: PS_START, stop: PS_STOP, elev: PS_ELEV });

const psArgs = (script) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];

// Failure detail for the UI: cap length; both streams (PowerShell writes its
// errors to stderr, our tokens to stdout).
const failDetail = (res, fallback = 'command failed') =>
    `${res.stdout || ''}${res.stderr || ''}`.trim().slice(0, 300) || fallback;

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

    // The backend WE started, or null. Ownership is the quit-dialog gate: a
    // hotspot this app did not start is never this app's to stop.
    active() {
        return this._activeBackend;
    }

    async probeBackends() {
        if (this._platform !== 'win32') {
            return { canHotspot: false, mobile: false, hosted: false, preferred: null };
        }
        const [psRes, driversRes] = await Promise.all([
            this._run('powershell', psArgs(PS_PROBE), { timeoutMs: 20000 }),
            this._run('netsh', ['wlan', 'show', 'drivers']),
        ]);
        const mobile = psRes.stdout.includes('PROBE_OK');
        const stateMatch = psRes.stdout.match(/PROBE_STATE_(\w+)/);
        const hostedSupport = driversRes.ok
            ? parseNetshDrivers(driversRes.stdout).hostedNetworkSupported
            : null;
        const hosted = hostedSupport !== false; // null = unknown -> still worth trying
        const preferred = mobile ? 'mobile' : hosted ? 'hosted' : null;
        this._log(`[hotspot] probe: mobile=${mobile} hosted=${String(hostedSupport)} -> ${preferred || 'none'}`);
        return {
            canHotspot: !!preferred,
            mobile,
            hosted,
            preferred,
            // WinRT tethering state at probe time (On/Off/InTransition/Unknown),
            // null when the probe could not reach the manager. Diagnostic only.
            mobileState: stateMatch ? stateMatch[1] : null,
        };
    }

    // Failure results carry `kind` so the UI can act on the class, not the
    // text: 'config-failed' | 'start-failed' | 'already-on' | 'config-mismatch'
    // | 'no-profile' | 'ps-error' | 'unsupported' | 'stop-failed' — plus
    // `backend` ('mobile'/'hosted') so the two backends' failures stay
    // distinguishable (audit B2). `fallback:false` marks mobile failures the
    // hosted backend must NOT paper over (someone else's hotspot is running;
    // or ours started in a wrong state and needs an explicit stop).
    async start({ ssid, password } = {}) {
        if (this._platform !== 'win32') return { ok: false, kind: 'unsupported', error: 'hotspot is Windows-only' };
        if (!ssid || !password || password.length < 8) {
            return { ok: false, kind: 'config-failed', error: 'hotspot needs an SSID and a password of 8+ chars (WPA2)' };
        }
        const probe = await this.probeBackends();
        if (probe.mobile) {
            const res = await this._start_mobile(ssid, password);
            if (res.ok || res.fallback === false) return res;
            this._log(`[hotspot] mobile backend failed (${res.kind}); trying hostednetwork`);
            if (probe.hosted) {
                const hosted = await this._start_hosted(ssid, password);
                if (!hosted.ok) {
                    // The fallback was legitimately attempted, so the hosted
                    // failure is authoritative — but the mobile failure it
                    // papered over stays attached for diagnostics (audit B2).
                    hosted.fallbackFrom = { kind: res.kind, error: res.error };
                }
                return hosted;
            }
            return res; // no fallback available: surface the real mobile failure
        }
        if (probe.hosted) return this._start_hosted(ssid, password);
        return { ok: false, kind: 'unsupported', error: 'no hotspot backend available on this machine (join a network instead)' };
    }

    async _start_mobile(ssid, password) {
        const res = await this._run('powershell', psArgs(PS_START), {
            timeoutMs: 30000,
            env: { W17_HOTSPOT_SSID: ssid, W17_HOTSPOT_PASS: password },
        });
        const out = res.stdout || '';
        if (out.includes('START_OK')) {
            this._activeBackend = 'mobile';
            return { ok: true, method: 'mobile', ssid, hostIp: icsHostIp() };
        }
        if (out.includes('START_ALREADY_ON')) {
            // Someone else's hotspot (Windows Settings, another tool). Not ours
            // to reconfigure or stop — and the hosted backend must not pile a
            // second network on top.
            return {
                ok: false, kind: 'already-on', backend: 'mobile', fallback: false,
                error: 'a hotspot is already running on this machine (not started by this app) — use it as-is, or stop it in Windows Settings first',
            };
        }
        if (out.includes('START_CONFIG_MISMATCH')) {
            // Fail-closed readback tripped: tethering started but the SSID did
            // not apply. WE started it, so keep ownership for STOP/retry.
            this._activeBackend = 'mobile';
            return {
                ok: false, kind: 'config-mismatch', backend: 'mobile', fallback: false,
                error: 'mobile hotspot started but the requested SSID was not applied — press STOP HOTSPOT and retry',
            };
        }
        if (out.includes('START_CONFIG_FAILED')) {
            return { ok: false, kind: 'config-failed', backend: 'mobile', fallback: true, error: `mobile hotspot configuration failed: ${failDetail(res)}` };
        }
        if (out.includes('RESULT_NO_PROFILE')) {
            return { ok: false, kind: 'no-profile', backend: 'mobile', fallback: true, error: 'no tetherable internet connection profile' };
        }
        if (out.includes('START_FAILED_')) {
            return { ok: false, kind: 'start-failed', backend: 'mobile', fallback: true, error: `mobile hotspot refused: ${failDetail(res)}` };
        }
        return { ok: false, kind: 'ps-error', backend: 'mobile', fallback: true, error: failDetail(res, 'mobile hotspot refused') };
    }

    // The process elevation FACT via a fixed PowerShell token (audit B2):
    // true = elevated, false = not elevated, null = the check itself failed
    // (elevation unknown). Locale-independent — no output prose is matched.
    async _checkElevated() {
        const res = await this._run('powershell', psArgs(PS_ELEV), { timeoutMs: 10000 });
        const out = res.stdout || '';
        if (out.includes('ELEV_ADMIN')) return true;
        if (out.includes('ELEV_LIMITED')) return false;
        return null;
    }

    async _start_hosted(ssid, password) {
        const set = await this._run('netsh', [
            'wlan', 'set', 'hostednetwork', 'mode=allow', `ssid=${ssid}`, `key=${password}`,
        ]);
        if (!set.ok) {
            return { ok: false, kind: 'config-failed', backend: 'hosted', error: `hostednetwork config failed: ${failDetail(set)}` };
        }
        const start = await this._run('netsh', ['wlan', 'start', 'hostednetwork']);
        if (!start.ok) {
            // netsh exposes no locale-neutral CAUSE for a hostednetwork start
            // failure (only localized prose), so the classification stays a
            // generic 'start-failed' (audit B2). The elevation token adds the
            // one structured fact we can get: when the process is NOT known to
            // be elevated, offer the administrator hint as a SUGGESTION —
            // elevation may or may not be the cause, and the raw (sanitized)
            // netsh detail is retained for diagnostics either way.
            const elevated = await this._checkElevated();
            const result = {
                ok: false,
                kind: 'start-failed',
                backend: 'hosted',
                elevated,
                error: `hostednetwork start failed: ${failDetail(start)}`,
            };
            if (elevated !== true) {
                result.suggestion = 'The legacy hotspot backend may require administrator privileges — restarting the ground station as administrator may help.';
            }
            return result;
        }
        this._activeBackend = 'hosted';
        return { ok: true, method: 'hosted', ssid, hostIp: icsHostIp() };
    }

    // Stops only a hotspot WE started. Ownership (`_activeBackend`) is cleared
    // strictly AFTER a successful stop (audit N2): a failed stop keeps the
    // state so the UI can stay honest (LIVE + error) and retry.
    async stop() {
        if (this._platform !== 'win32' || !this._activeBackend) return { ok: true };
        const backend = this._activeBackend;
        let ok;
        let res;
        if (backend === 'mobile') {
            res = await this._run('powershell', psArgs(PS_STOP), { timeoutMs: 20000 });
            ok = (res.stdout || '').includes('STOP_OK');
        } else {
            res = await this._run('netsh', ['wlan', 'stop', 'hostednetwork']);
            ok = res.ok;
        }
        if (!ok) {
            const error = failDetail(res, 'hotspot stop failed');
            this._log(`[hotspot] stop failed (${backend}): ${error}`);
            return { ok: false, kind: 'stop-failed', backend, error };
        }
        this._activeBackend = null;
        return { ok: true };
    }
}

module.exports = { HotspotManager, PS_SCRIPTS };
