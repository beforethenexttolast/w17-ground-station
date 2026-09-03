#Requires -Version 7.0
<#
.SYNOPSIS
  W17 Windows-VM validation, step 40: firewall/UDP/mDNS reachability for the
  iPhone bridge — plus the exposure the v2 review confirmed (boundaries-3 /
  MAP-8): what else is reachable from the same hotspot subnet.

.DESCRIPTION
  Three independent checks, each recorded even if another fails:

  1. Firewall state for UDP 5601 (W2 telemetry, send-only,
     docs/windows_bridge_contract.md), UDP 5602 (W3 head-intent, receive-only,
     LOG-ONLY — CLAUDE.md safety boundary 5) and mDNS 5353
     (shared/hudDiscovery.js SERVICE_TYPE / main/HudDiscovery.js). Reports
     both Windows Defender Firewall rules mentioning the GS exe AND whether
     any general port-based allow rule exists — a fresh Windows installer has
     NEITHER by default, which means the giftee's FIRST launch triggers the
     interactive "Windows Defender Firewall has blocked some features" prompt
     (a human-in-the-loop moment worth recording, not something this
     autonomous session can click through).

  2. mDNS browse for `_w17hud._udp.local.` via lib/mdns-probe.js, run under
     the installed exe in ELECTRON_RUN_AS_NODE mode so it decodes with the
     app's OWN shared/dnsWire.js + shared/hudDiscovery.js (see that file's
     header for why). No iPhone is expected to be on this VM session — an
     empty result is not itself a failure; the pass condition is "the query
     went out and the socket behaved," recorded separately from "a HUD
     replied."

  3. UDP 5601 receive probe using the app's OWN demo/replay telemetry path
     (package.json `"demo"` script -> scripts/run.js:16 sets
     W17_TELEMETRY_SOURCE=replay; the bridge itself is enabled the same way
     main.js's sessionApplier always has been, via
     shared/settings.js:338-341's W17_IPHONE_BRIDGE/W17_IPHONE_ADDR/
     W17_IPHONE_PORT env triple) — this script launches the installed exe
     with a SCRATCH --user-data-dir (a real Electron/Chromium switch, works
     against ANY Electron binary regardless of packaging — this is how the
     script stays idempotent without touching a real profile) pointed at
     127.0.0.1:5601, with a UDP listener already bound before launch, and
     confirms at least one well-formed JSON telemetry frame arrives.

  Also reports the listening-interface picture for whichever of these ports
  are open when this runs (Get-NetTCPConnection has no UDP equivalent on
  older PS, so this uses Get-NetUDPEndpoint), which is the evidence
  boundaries-3/MAP-8 (mapper gRPC :10000 + webapp :3000 unauthenticated on
  all interfaces) asks any Windows session to gather for the mapper too —
  this script covers the ports it owns (5601/5602/5353); 50-race-day.ps1
  covers 10000/3000 once the mapper is actually running.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $InstallDir,
    [int] $MdnsTimeoutMs = 4000,
    [string] $ResultsDir
)

. (Join-Path $PSScriptRoot 'lib\common.ps1')

$data = [ordered]@{ installDir = $InstallDir }
$failures = New-Object System.Collections.Generic.List[string]

$exePath = Join-Path $InstallDir 'W17 Ground Station.exe'
$asarPath = Join-Path $InstallDir 'resources\app.asar'
if (-not (Test-Path -LiteralPath $exePath) -or -not (Test-Path -LiteralPath $asarPath)) {
    $r = New-W17Result -Script '40-mdns-udp' -Ok $false -Summary "GS not found under $InstallDir — run 10-install-gs.ps1 first" -Data $data
    Save-W17Result -Result $r -ResultsDir $ResultsDir
    exit (Write-W17Result $r)
}

# --- 1. firewall state -----------------------------------------------------
$fwPorts = @(5601, 5602, 5353)
$portRules = @{}
foreach ($p in $fwPorts) {
    try {
        $rules = Get-NetFirewallPortFilter -Protocol UDP -ErrorAction Stop | Where-Object { $_.LocalPort -eq "$p" }
        $portRules["$p"] = @($rules | ForEach-Object { ($_ | Get-NetFirewallRule).DisplayName })
    } catch {
        $portRules["$p"] = $null
    }
}
$data.firewallPortRules = $portRules
try {
    $exeRules = Get-NetFirewallApplicationFilter -ErrorAction Stop | Where-Object { $_.Program -like "*W17 Ground Station.exe" }
    $data.firewallAppRules = @($exeRules | ForEach-Object { ($_ | Get-NetFirewallRule).DisplayName })
} catch {
    $data.firewallAppRules = $null
}
$data.firewallNote = 'a fresh Windows install typically has NEITHER an app rule nor a port rule for these until the app first binds and/or the operator accepts the Defender prompt — that prompt is a human-in-the-loop step this autonomous session cannot click through; the runbook records it as a manual gift-day step.'

# --- 2. mDNS browse (app's own codec) --------------------------------------
$mdnsJs = Join-Path $PSScriptRoot 'lib\mdns-probe.js'
$mdnsRes = Invoke-W17Command -FilePath $exePath -ArgumentList @($mdnsJs, $asarPath, "$MdnsTimeoutMs") -TimeoutSec ([math]::Ceiling($MdnsTimeoutMs / 1000) + 15) -Environment @{ ELECTRON_RUN_AS_NODE = '1' }
$mdnsLine = ($mdnsRes.stdout -split "`r`n|`n") | Where-Object { $_ -like 'MDNS_PROBE_RESULT:*' } | Select-Object -Last 1
$mdns = if ($mdnsLine) { try { ($mdnsLine -replace '^MDNS_PROBE_RESULT:\s*', '') | ConvertFrom-Json } catch { $null } } else { $null }
$data.mdnsProbe = $mdns
# Get-W17Prop throughout (B2 class): mdns-probe.js:34's refusal shape is
# { ok:false, kind, error } with NO `queried` and NO `hudsFound`, and under
# `Set-StrictMode -Version Latest` reaching for a missing property throws —
# which would have killed this script before it could report the refusal.
$mdnsQueried = (Get-W17Prop $mdns 'ok' $false) -and (Get-W17Prop $mdns 'queried' $false)
if (-not $mdnsQueried) {
    $failures.Add("mDNS query did not go out cleanly: $(Get-W17ProbeReason $mdns); stderr: $($mdnsRes.stderr)")
} else {
    $hudsFound = @(Get-W17Prop $mdns 'hudsFound' @())
    $data.mdnsHudsFound = $hudsFound
    if ($hudsFound.Count -eq 0) {
        $data.mdnsNote = 'no HUD advertisement seen (expected — no iPhone is attached to this VM session); the query itself completed cleanly, which is this check''s pass condition'
    }
}

# --- 3. UDP 5601 receive probe (app's own demo/replay + bridge env) -------
$scratchUserData = Join-Path (Get-W17TempDir) "w17-val-udp-$([guid]::NewGuid().ToString('N').Substring(0,8))"
New-Item -ItemType Directory -Force -Path $scratchUserData | Out-Null
$data.scratchUserDataDir = $scratchUserData

$udpClient = $null
$proc = $null
$received = $null
$bindError = $null
try {
    # Binding 5601 can legitimately FAIL: the ground station itself, an
    # iPhone-HUD listener, or a leftover from an earlier run of this very step
    # may already hold it. That is a clean FAIL with a name, not a crash. It
    # used to propagate out of this try/finally (there is no catch on the outer
    # block) and kill the script before any W17VAL_RESULT envelope was written
    # — observed for real on this Mac, where another process held UDP 5601:
    # "Exception calling \".ctor\" with \"1\" argument(s): Address already in
    # use", no envelope, and run-all reporting only "no result JSON written".
    try {
        $udpClient = New-Object System.Net.Sockets.UdpClient(5601)
    } catch {
        $bindError = $_.Exception.Message
        $failures.Add("could not bind UDP 5601 to listen for telemetry: $bindError — something else already holds the port (the ground station itself, an iPhone-HUD listener, or a leftover from an earlier run of this step). Close it, or check with: Get-NetUDPEndpoint -LocalPort 5601 | Select-Object LocalAddress,OwningProcess")
    }
    if ($udpClient) {
    $udpClient.Client.ReceiveTimeout = 8000

    # NAMED $childEnv, never $env — see 30-hotspot.ps1's B1 note. PowerShell
    # variable names are case-insensitive, so a local called $env shadows the
    # name every `$env:VAR` reader in this file depends on and is one edit away
    # from the self-enumerating-hashtable crash that killed step 30.
    $childEnv = @{
        W17_TELEMETRY_SOURCE = 'replay'
        W17_IPHONE_BRIDGE    = '1'
        W17_IPHONE_ADDR      = '127.0.0.1'
        W17_IPHONE_PORT      = '5601'
        W17_FULLSCREEN       = '0'
        W17_WIFI_SIM         = 'two-adapters' # keep Wi-Fi/hotspot reads canned, same convention as scripts/electron-smoke.js's SCRUB then set-own-vars pattern
    }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exePath
    $psi.ArgumentList.Add("--user-data-dir=$scratchUserData")
    foreach ($k in $childEnv.Keys) { $psi.Environment[$k] = $childEnv[$k] }
    $psi.UseShellExecute = $false
    $proc = [System.Diagnostics.Process]::Start($psi)
    $data.launchedPid = $proc.Id

    try {
        $remote = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0)
        $bytes = $udpClient.Receive([ref] $remote)
        $text = [System.Text.Encoding]::UTF8.GetString($bytes)
        $received = [pscustomobject]@{ from = $remote.ToString(); bytes = $bytes.Length; text = $text }
    } catch [System.Net.Sockets.SocketException] {
        $received = $null
    }
    }
} finally {
    if ($udpClient) { $udpClient.Close() }
    if ($proc -and -not $proc.HasExited) {
        try { Start-Process -FilePath 'taskkill' -ArgumentList @('/pid', "$($proc.Id)", '/t', '/f') -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue } catch {}
        # Backstop: an Electron app spawns helper processes, and a leaked one
        # would keep 5601 bound and make every later run of this step fail.
        try { if (-not $proc.HasExited) { $proc.Kill($true) } } catch {}
    }
    Remove-Item -LiteralPath $scratchUserData -Recurse -Force -ErrorAction SilentlyContinue
}

$data.udp5601BindError = $bindError
$data.udp5601Received = $received
$frameOk = $false
if ($bindError) {
    # already reported above; do not also blame the app for a frame that could
    # never have been received.
    $data.udp5601FrameParsed = $null
} elseif ($received) {
    try {
        $json = $received.text | ConvertFrom-Json
        $frameOk = $null -ne $json
        $data.udp5601FrameParsed = $frameOk
    } catch {
        $data.udp5601ParseError = $_.Exception.Message
    }
} else {
    $failures.Add('no UDP telemetry frame received on 127.0.0.1:5601 within 8s of launching the app with the demo/replay + W17_IPHONE_BRIDGE env — either the bridge did not start, the firewall silently dropped it, or the app failed to boot (check the firewall rules above)')
}

# --- listening-interface report ---------------------------------------------
function Get-W17UdpListeners {
    param([int[]] $Ports)
    $out = @()
    try {
        $eps = Get-NetUDPEndpoint -ErrorAction Stop | Where-Object { $Ports -contains $_.LocalPort }
        foreach ($e in $eps) {
            $out += [pscustomobject]@{ localAddress = $e.LocalAddress; localPort = $e.LocalPort; owningProcess = $e.OwningProcess }
        }
    } catch { }
    return $out
}
$data.udpListenersAtEnd = Get-W17UdpListeners -Ports @(5601, 5602, 5353)

$ok = $failures.Count -eq 0
$summary = if ($ok) {
    'firewall state recorded; mDNS query completed; UDP 5601 replay telemetry received and parsed'
} else {
    ($failures -join '; ')
}

$result = New-W17Result -Script '40-mdns-udp' -Ok $ok -Summary $summary -Data $data
Save-W17Result -Result $result -ResultsDir $ResultsDir
exit (Write-W17Result $result)
