#Requires -Version 7.0
<#
.SYNOPSIS
  W17 Windows-VM validation, step 30: hotspot up/verify/teardown, driven
  through the SAME mechanism the ground station itself uses.

.DESCRIPTION
  Rather than re-implementing the WinRT Mobile-Hotspot / netsh hostednetwork
  calls in PowerShell (a second copy that would drift from the shipped app),
  this step runs the installed app's OWN main/hotspot.js (HotspotManager) and
  main/hotspotVerify.js (createHotspotVerifier) — the exact modules
  main/appWiring.js:49-79 (createNetworkServices) wires into the running app
  — via lib/hotspot-probe.js, executed under the installed Electron binary in
  Node mode (`ELECTRON_RUN_AS_NODE=1`, which still resolves paths inside
  app.asar transparently; a plain node.exe cannot).

  Sequence: probeBackends() (AP-capability: mobile Mobile-Hotspot vs legacy
  hostednetwork, per hotspot.js:199-224) -> start({ssid,password})
  (hotspot.js:233-257) -> verify() (hotspotVerify.js's local readiness
  checks: WinRT tethering state, ICS gateway 192.168.137.x, SharedAccess /
  icssvc service state) -> best-effort SSID/band/client-count read via netsh
  (Windows exposes none of that through the WinRT API the app itself calls,
  so this is read SEPARATELY and is [win-TBD] until observed live) -> stop()
  (hotspot.js:346-365, always attempted, even on a prior failure, so this
  step never leaves a hotspot running behind it).

  A CLEAN FAIL (not a crash) when probeBackends() reports no usable backend
  at all (`preferred: null`) — exactly the "no adapter" case the brief calls
  out; the message names it plainly rather than surfacing a raw PowerShell
  exception, matching the app's own philosophy at hotspot.js:256
  ("no hotspot backend available on this machine").

  WHAT THIS STEP DOES NOT COVER (review finding N6, stated here rather than
  left implied): it drives HotspotManager and createHotspotVerifier DIRECTLY.
  It does NOT go through main/hotspotLifecycle.js, which is the module race
  day itself calls (main/raceDayOrchestrator.js:85 `this._lifecycle =
  hotspotLifecycle`, used by `_hotspotStep` at :182 and reached from the
  sequence at :161-163). So the retry/refresh/teardown POLICY in
  hotspotLifecycle.js — the ordering, the re-verify loop, the failure
  escalation — is exercised by nothing here, and step 50 stubs it out too.
  Whether hotspot.js and hotspotVerify.js work on this guest is what this
  step answers; whether race day sequences them correctly is [win-TBD] and
  needs a separate step, or a real race-day run on hardware.

  PREREQUISITE, NOT ASSUMED: an AP-capable adapter. The 5 GHz USB Wi-Fi
  adapter this step's PASS depends on is still on the owner's shopping list
  (CURRENT_STATUS.md, "Owner residue: shopping only"); the RT5370 recorded on
  hand in HARDWARE_INVENTORY.md is 2.4 GHz and its AP mode is unverified.
  Until that adapter exists and has an ARM64 driver, this step and step 40's
  hotspot-interface path can only report the clean no-backend FAIL above.

.PARAMETER InstallDir
  The GS install directory (from 10-install-gs.ps1's resolvedInstallDir).

.PARAMETER Ssid
  Hotspot SSID to request. Defaults to the app's own default
  (shared/settings.js:40 `network.hotspot.ssid: 'W17-GRID'`).

.PARAMETER Password
  Hotspot password (WPA2, 8+ chars — hotspot.js:235-237 enforces the same
  floor). MANDATORY: never defaulted or invented — the owner supplies the
  real one for the VM session; this script never logs it (hotspot-probe.js
  passes it via environment variable, never argv, matching hotspot.js:100-
  101's own $env: convention, and strips any `password` key an unexpected
  result object might carry before printing).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $InstallDir,
    [string] $Ssid = 'W17-GRID',
    [Parameter(Mandatory)][string] $Password,
    [string] $ResultsDir
)

. (Join-Path $PSScriptRoot 'lib\common.ps1')

$data = [ordered]@{ installDir = $InstallDir; ssid = $Ssid }
$findings = @()
$failures = New-Object System.Collections.Generic.List[string]

$exePath = Join-Path $InstallDir 'W17 Ground Station.exe'
$asarPath = Join-Path $InstallDir 'resources\app.asar'
$probeJs = Join-Path $PSScriptRoot 'lib\hotspot-probe.js'

if (-not (Test-Path -LiteralPath $exePath)) {
    $r = New-W17Result -Script '30-hotspot' -Ok $false -Summary "GS exe not found at $exePath — run 10-install-gs.ps1 first" -Data $data
    Save-W17Result -Result $r -ResultsDir $ResultsDir
    exit (Write-W17Result $r)
}
if (-not (Test-Path -LiteralPath $asarPath)) {
    $r = New-W17Result -Script '30-hotspot' -Ok $false -Summary "app.asar not found at $asarPath" -Data $data
    Save-W17Result -Result $r -ResultsDir $ResultsDir
    exit (Write-W17Result $r)
}

# The extra-environment parameter is $EnvExtra, and the local it merges into is
# $childEnv. NEITHER may be called `Env`/`env`: PowerShell variable names are
# case-INsensitive, so a `[hashtable] $Env` parameter and a `$env = @{...}`
# local are ONE variable. The original code did exactly that, and it is not a
# silent mis-merge — it is a hard crash. Measured under pwsh 7.7.0-preview.4
# with the original three lines: the assignment rebinds $Env to the fresh
# hashtable, `foreach ($k in $Env.Keys)` then enumerates that same hashtable
# while the loop body writes into it, and .NET throws
#   "Collection was modified; enumeration operation may not execute."
# So `start` (the only caller that passes -Env, carrying W17_VAL_HOTSPOT_SSID/
# _PASS) died before it ever reached the probe, and script 30 could never pass.
# Note a Parser::ParseFile check does NOT catch this — it parses clean; only
# executing it does. Verified again after the rename: all three keys survive
# (ELECTRON_RUN_AS_NODE, W17_VAL_HOTSPOT_PASS, W17_VAL_HOTSPOT_SSID).
function Invoke-W17HotspotProbe {
    param([string] $Action, [hashtable] $EnvExtra = $null)
    $childEnv = @{ ELECTRON_RUN_AS_NODE = '1' }
    if ($EnvExtra) { foreach ($k in $EnvExtra.Keys) { $childEnv[$k] = $EnvExtra[$k] } }
    $res = Invoke-W17Command -FilePath $exePath -ArgumentList @($probeJs, $asarPath, $Action) -TimeoutSec 45 -Environment $childEnv
    $line = ($res.stdout -split "`r`n|`n") | Where-Object { $_ -like 'HOTSPOT_PROBE_RESULT:*' } | Select-Object -Last 1
    if (-not $line) {
        return [pscustomobject]@{ ok = $false; kind = 'no-result-line'; raw = $res }
    }
    try {
        return ($line -replace '^HOTSPOT_PROBE_RESULT:\s*', '') | ConvertFrom-Json
    } catch {
        return [pscustomobject]@{ ok = $false; kind = 'unparseable-result'; raw = $line }
    }
}

# Every dereference below goes through Get-W17Prop / Get-W17ProbeReason
# (lib/common.ps1). hotspot-probe.js returns { ok:true, action, result } on
# success but { ok:false, kind, error } on every refusal (bad-args,
# module-load-failed, threw), and the wrapper above synthesises two more
# shapes with neither `result` nor `error`. Under `Set-StrictMode -Version
# Latest` a missing property THROWS, so reaching straight for `$probe.result`
# or `$start.result.kind` on the LIKELY paths killed the script with a raw
# stack trace — no W17VAL_RESULT envelope, no Save-W17Result, and run-all
# reporting "no result JSON written" instead of the real reason.

# --- probe -----------------------------------------------------------------
$probe = Invoke-W17HotspotProbe -Action 'probe'
$data.probe = $probe

$probeResult = Get-W17Prop $probe 'result'
$canHotspot = (Get-W17Prop $probe 'ok' $false) -and $probeResult -and (Get-W17Prop $probeResult 'canHotspot' $false)
if (-not $canHotspot) {
    $data.clearFailReason = 'no-adapter-or-backend'
    $summary = if (Get-W17Prop $probe 'ok' $false) {
        'probeBackends() reports no usable hotspot backend on this VM (no adapter, or neither Mobile Hotspot nor hostednetwork is available) — clean FAIL, not a crash; attach/enable the AP-capable 5 GHz USB Wi-Fi adapter (still on the owner shopping list — CURRENT_STATUS.md "Owner residue: shopping only"; the RT5370 on hand is 2.4 GHz with AP mode unverified) and re-run'
    } else {
        "hotspot probe itself refused: $(Get-W17ProbeReason $probe)"
    }
    $result = New-W17Result -Script '30-hotspot' -Ok $false -Summary $summary -Data $data
    Save-W17Result -Result $result -ResultsDir $ResultsDir
    exit (Write-W17Result $result)
}

# --- pre-start netsh snapshot (best-effort band/channel context) ----------
$preIf = (Invoke-W17Command -FilePath 'netsh' -ArgumentList @('wlan', 'show', 'interfaces') -TimeoutSec 10).stdout
$data.wifiInterfacesBeforeStart = $preIf

# --- start -------------------------------------------------------------
$startEnv = @{ W17_VAL_HOTSPOT_SSID = $Ssid; W17_VAL_HOTSPOT_PASS = $Password }
$start = Invoke-W17HotspotProbe -Action 'start' -EnvExtra $startEnv
$data.start = $start
$startResult = Get-W17Prop $start 'result'
$started = (Get-W17Prop $start 'ok' $false) -and $startResult -and (Get-W17Prop $startResult 'ok' $false)
$startedBackend = $null
if (-not $started) {
    $failures.Add("hotspot start failed: $(Get-W17ProbeReason $start)")
}

# --- verify --------------------------------------------------------------
$verify = $null
$verifyStatus = $null
if ($started) {
    $startedBackend = Get-W17Prop $startResult 'method' '(method not reported)'
    $verify = Invoke-W17HotspotProbe -Action 'verify' -EnvExtra @{}
    # verify action ignores the backend arg passed via argv in hotspot-probe.js
    # today (it reads manager.active()); still record what the app itself
    # believes started so a mismatch is visible.
    $data.verify = $verify
    $data.startedBackend = $startedBackend
    $verifyResult = Get-W17Prop $verify 'result'
    $verifyStatus = Get-W17Prop $verifyResult 'status' '(status not reported)'
    if (-not ((Get-W17Prop $verify 'ok' $false) -and $verifyResult -and $verifyStatus -eq 'verified')) {
        $reasons = Get-W17Prop $verifyResult 'reasons' @(Get-W17ProbeReason $verify)
        $failures.Add("readiness verify did not reach 'verified': $($reasons -join ' | ')")
    }
}

# --- best-effort SSID/band/client-count read (Windows-side, not the app's) -
# The WinRT tethering API the app calls exposes no band/channel/client-count
# accessor; this reads what Windows itself will show, on a best-effort basis.
# [win-TBD]: not yet observed against a live hotspot in this session.
$postIf = (Invoke-W17Command -FilePath 'netsh' -ArgumentList @('wlan', 'show', 'interfaces') -TimeoutSec 10).stdout
$hostedNet = (Invoke-W17Command -FilePath 'netsh' -ArgumentList @('wlan', 'show', 'hostednetwork') -TimeoutSec 10).stdout
$data.wifiInterfacesAfterStart = $postIf
$data.hostedNetworkStatus = $hostedNet
if ($hostedNet -match 'Number of clients\s*:\s*(\d+)') { $data.hostedNetworkClientCount = [int]$Matches[1] } else { $data.hostedNetworkClientCount = $null }
if ($postIf -match 'Radio type\s*:\s*(.+)') { $data.observedRadioType = $Matches[1].Trim() } else { $data.observedRadioType = $null }
if ($postIf -match 'Channel\s*:\s*(\d+)') {
    $ch = [int]$Matches[1]
    $data.observedChannel = $ch
    $data.observedBandGuess = if ($ch -ge 36) { '5 GHz (channel >= 36)' } elseif ($ch -ge 1 -and $ch -le 14) { '2.4 GHz' } else { 'unknown' }
}

# --- teardown (always attempted) ------------------------------------------
$stop = Invoke-W17HotspotProbe -Action 'stop'
$data.stop = $stop
$stopResult = Get-W17Prop $stop 'result'
if (-not ((Get-W17Prop $stop 'ok' $false) -and $stopResult -and (Get-W17Prop $stopResult 'ok' $false))) {
    $failures.Add("teardown (stop()) did not report success — a hotspot may still be live; check manually (netsh wlan show hostednetwork): $(Get-W17ProbeReason $stop)")
}

$ok = $failures.Count -eq 0
$summary = if ($ok) {
    "hotspot started ($startedBackend), verified '$verifyStatus', torn down cleanly"
} else {
    ($failures -join '; ')
}

$result = New-W17Result -Script '30-hotspot' -Ok $ok -Summary $summary -Data $data -Findings $findings
Save-W17Result -Result $result -ResultsDir $ResultsDir
exit (Write-W17Result $result)
