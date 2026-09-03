#Requires -Version 5.1
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

function Invoke-W17HotspotProbe {
    param([string] $Action, [hashtable] $Env = $null)
    $env = @{ ELECTRON_RUN_AS_NODE = '1' }
    if ($Env) { foreach ($k in $Env.Keys) { $env[$k] = $Env[$k] } }
    $res = Invoke-W17Command -FilePath $exePath -ArgumentList @($probeJs, $asarPath, $Action) -TimeoutSec 45 -Environment $env
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

# --- probe -----------------------------------------------------------------
$probe = Invoke-W17HotspotProbe -Action 'probe'
$data.probe = $probe

$canHotspot = $probe.ok -and $probe.result -and $probe.result.canHotspot
if (-not $canHotspot) {
    $data.clearFailReason = 'no-adapter-or-backend'
    $summary = if ($probe.ok) {
        'probeBackends() reports no usable hotspot backend on this VM (no adapter, or neither Mobile Hotspot nor hostednetwork is available) — clean FAIL, not a crash; attach/enable the 5.8 GHz USB Wi-Fi adapter (owner decision A4) and re-run'
    } else {
        "hotspot probe itself failed: $($probe.error)"
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
$start = Invoke-W17HotspotProbe -Action 'start' -Env $startEnv
$data.start = $start
$started = $start.ok -and $start.result -and $start.result.ok
if (-not $started) {
    $failures.Add("hotspot start failed: kind=$($start.result.kind) error=$($start.result.error)")
}

# --- verify --------------------------------------------------------------
$verify = $null
if ($started) {
    $backend = $start.result.method
    $verify = Invoke-W17HotspotProbe -Action 'verify' -Env @{}
    # verify action ignores the backend arg passed via argv in hotspot-probe.js
    # today (it reads manager.active()); still record what the app itself
    # believes started so a mismatch is visible.
    $data.verify = $verify
    $data.startedBackend = $backend
    if (-not ($verify.ok -and $verify.result -and $verify.result.status -eq 'verified')) {
        $reasons = if ($verify.ok) { $verify.result.reasons } else { @($verify.error) }
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
if (-not ($stop.ok -and $stop.result -and $stop.result.ok)) {
    $failures.Add("teardown (stop()) did not report success — a hotspot may still be live; check manually: $($stop.error)")
}

$ok = $failures.Count -eq 0
$summary = if ($ok) {
    "hotspot started ($($start.result.method)), verified '$($verify.result.status)', torn down cleanly"
} else {
    ($failures -join '; ')
}

$result = New-W17Result -Script '30-hotspot' -Ok $ok -Summary $summary -Data $data -Findings $findings
Save-W17Result -Result $result -ResultsDir $ResultsDir
exit (Write-W17Result $result)
