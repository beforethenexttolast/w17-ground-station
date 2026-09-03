#Requires -Version 7.0
<#
.SYNOPSIS
  Run the W17 Windows-VM validation suite (00-50 automated; 60 opt-in and
  human-in-the-loop) and print one PASS/FAIL table, plus a combined
  results/<timestamp>.json.

  REQUIRES POWERSHELL 7 on the guest. Windows 11 does not ship it — install it
  first with `winget install --id Microsoft.PowerShell --source winget`. This
  driver refuses to fall back to powershell.exe and says so, rather than
  letting each script fail separately with a .NET stack trace.

.DESCRIPTION
  Each 0N-*.ps1 script is invoked as its OWN process (via pwsh/powershell,
  never dot-sourced — several set Set-StrictMode/$ErrorActionPreference
  globally in lib/common.ps1, and running eight of them in one process risks
  one script's terminating-error mode leaking into the next), exactly the
  way the workspace runbook describes the Mac driving them over SSH
  (`ssh w17vm 'pwsh -File 10-install-gs.ps1 ...'`) — this script is the
  local (on-guest) equivalent of that same one-script-per-call pattern, nice
  to have for a single `ssh w17vm 'pwsh -File run-all.ps1 ...'` invocation.

  A script that needs a parameter this driver was not given (an installer
  path for 10, a hotspot password for 30, a mapper/profile pair for 20 and
  therefore 50) is SKIPPED, not failed — this driver never invents a value
  COMMON.md would call a guess. 60 is skipped unless -IncludeHidTransition is
  passed explicitly: it blocks for a human physically at the machine, and
  should not silently hang an automated sweep. It is also the ONLY step that
  involves an operator-started mapper with a live TX — read its safety
  precondition (car unpowered / RX unbound) before passing that switch. It
  measures Windows HID transitions and mapper-process continuity; it is NOT an
  R15 test and NOTHING in this suite discharges R15, which remains NO-GO
  (CURRENT_STATUS.md:1375).

  50-race-day.ps1 is no longer expected to come back red. The structural
  MAP-2/SYN-2 finding it reproduces on every run is recorded in its own
  expectedFindings channel instead of its exit code, so a FAIL from 50 in this
  table again means something the suite did NOT already know about.

  Each script keeps writing its own per-script JSON via -ResultsDir (a
  subdirectory of $ResultsRoot named for this run's timestamp); this script
  additionally writes ONE combined file, <ResultsRoot>\<timestamp>.json,
  with every result plus the run's own parameters.

.PARAMETER InstallerPath
  NSIS installer .exe for 10-install-gs.ps1. Omit to skip 10 (then
  -InstallDir must point at an already-installed build for 30/40/50).

.PARAMETER InstallDir
  Install directory for 30/40/50. Defaults to 10's resolvedInstallDir when
  10 ran; required if 10 was skipped.

.PARAMETER UserDataDir
  Shared by 20/50. Defaults to lib/common.ps1's Get-W17DefaultUserDataDir.

.PARAMETER MapperExe / .PARAMETER Profile
  For 20-mapper-stage.ps1 (and, via the settings it stages, 50). Omit either
  to skip both 20 and 50.

.PARAMETER Ssid / .PARAMETER Password
  For 30-hotspot.ps1. Omit -Password to skip 30 (never defaulted — the
  owner's real password is not this script's to guess).

.PARAMETER MdnsTimeoutMs / .PARAMETER MapperWaitMs
  Passed through to 40 / 50.

.PARAMETER IncludeHidTransition
  Also run 60-hid-transition.ps1 (human-in-the-loop; see its own docs).

.PARAMETER HidTransitionNonInteractive
  Passed through to 60 as -NonInteractive when -IncludeHidTransition is set.

.PARAMETER MapperExeForHidTransition
  -MapperExe value for 60, if different from the -MapperExe used to stage
  20 (60 tracks an ALREADY-RUNNING mapper by process name, which need not be
  the same build). Defaults to -MapperExe.

.PARAMETER Shell
  'auto' (default, prefers pwsh, falls back to powershell.exe),
  'pwsh', or 'powershell'.

.PARAMETER ResultsRoot
  Root directory for per-run result folders/files. Defaults to
  <this script's directory>\results.
#>
[CmdletBinding()]
param(
    [string] $InstallerPath,
    [string] $InstallDir,
    [string] $UserDataDir,
    [string] $MapperExe,
    [string] $Profile,
    [string] $Ssid = 'W17-GRID',
    [string] $Password,
    [int] $MdnsTimeoutMs = 4000,
    [int] $MapperWaitMs = 8000,
    [switch] $IncludeHidTransition,
    [switch] $HidTransitionNonInteractive,
    [string] $MapperExeForHidTransition,
    [ValidateSet('auto', 'pwsh')][string] $Shell = 'auto',
    [string] $ResultsRoot
)

. (Join-Path $PSScriptRoot 'lib\common.ps1')

if (-not $ResultsRoot) { $ResultsRoot = Join-Path $PSScriptRoot 'results' }
if (-not $UserDataDir) { $UserDataDir = Get-W17DefaultUserDataDir }
if (-not $MapperExeForHidTransition) { $MapperExeForHidTransition = $MapperExe }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$runResultsDir = Join-Path $ResultsRoot $stamp
New-Item -ItemType Directory -Force -Path $runResultsDir | Out-Null

# --- resolve the shell to re-invoke each script under ----------------------
# FAILS LOUDLY; never falls back to powershell.exe (ruling 2026-09-03b, review
# finding B3). Every script here carries `#Requires -Version 7.0` and means it:
# ProcessStartInfo.ArgumentList — used by lib/common.ps1's Invoke-W17Command
# and by 50-race-day.ps1 directly — is .NET Core 2.1+ / .NET 5+ only and does
# not exist on the .NET Framework that Windows PowerShell 5.1 runs on. Windows
# 11 does NOT ship PowerShell 7. The old code preferred pwsh but fell back to
# powershell.exe, which on a fresh guest meant every script that shells out
# died one at a time with .NET stack traces instead of one clear message here.
# The version is checked too, not just the name: a `pwsh` on PATH that is
# somehow 6.x would fail the same way.
function Resolve-W17Shell {
    param([string] $Requested)
    $cmd = Get-Command 'pwsh' -ErrorAction SilentlyContinue
    if (-not $cmd) {
        throw @'
PowerShell 7 (pwsh) was not found on PATH, and this suite REQUIRES it.

Windows 11 ships only Windows PowerShell 5.1, which cannot run these scripts:
they use System.Diagnostics.ProcessStartInfo.ArgumentList, which exists only
on .NET Core 2.1+ / .NET 5+, not on the .NET Framework 5.1 runs on.

Install it on the guest, then re-run:
    winget install --id Microsoft.PowerShell --source winget
(then open a NEW shell so PATH picks up pwsh)

Refusing to fall back to powershell.exe: the fallback does not work, it just
fails later and less clearly. See the workspace Windows-VM runbook.
'@
    }
    $ver = & $cmd.Source -NoProfile -Command '$PSVersionTable.PSVersion.Major'
    if ([int]$ver -lt 7) {
        throw "pwsh was found at $($cmd.Source) but reports major version $ver; this suite requires 7.0 or later (winget install --id Microsoft.PowerShell --source winget)."
    }
    return $cmd.Source
}
$shellExe = Resolve-W17Shell -Requested $Shell
Write-Host "[run-all] using shell: $shellExe"

# NOTE on List[object] and @(): this is a List[object], and `@($rows)`
# THROWS "Argument types do not match" on pwsh 7.7.0-preview.4 (measured; the
# same expression is fine for List[string] and List[int], and .ToArray(),
# foreach, the pipeline and an [object[]] cast all work on the very same
# List[object] — so it is a regression in the array-subexpression operator in
# that preview build, not a defect in this logic). Whether it reproduces on
# the 7.4/7.5 a guest gets from `winget install Microsoft.PowerShell` is
# [win-TBD]. .ToArray() is used below instead: it is version-independent,
# costs nothing, and keeps the suite off a construct that has proven
# version-sensitive in at least one shipping PowerShell 7.
$rows = New-Object System.Collections.Generic.List[object]

function Invoke-W17Script {
    param(
        [Parameter(Mandatory)][string] $Name,
        [string[]] $ScriptArgs = @(),
        [switch] $Skip,
        [string] $SkipReason
    )
    $scriptPath = Join-Path $PSScriptRoot "$Name.ps1"
    if ($Skip) {
        Write-Host "[run-all] SKIP  $Name — $SkipReason"
        $rows.Add([pscustomobject]@{ script = $Name; skipped = $true; ok = $null; summary = $SkipReason; durationSec = 0 })
        return
    }
    Write-Host "[run-all] RUN   $Name"
    $started = Get-Date
    $fullArgs = @('-NoProfile', '-File', $scriptPath) + $ScriptArgs + @('-ResultsDir', $runResultsDir)
    $out = & $shellExe @fullArgs 2>&1
    $exitCode = $LASTEXITCODE
    $durationSec = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
    $out | ForEach-Object { Write-Host "  $_" }

    $jsonPath = Join-Path $runResultsDir "$Name.json"
    $parsed = $null
    if (Test-Path -LiteralPath $jsonPath) {
        try { $parsed = Get-Content -LiteralPath $jsonPath -Raw | ConvertFrom-Json } catch { }
    }
    $ok = if ($parsed) { [bool]$parsed.ok } else { $exitCode -eq 0 }
    $summary = if ($parsed) { $parsed.summary } else { "no result JSON written (exit code $exitCode) — see console output above" }
    $rows.Add([pscustomobject]@{ script = $Name; skipped = $false; ok = $ok; summary = $summary; durationSec = $durationSec; exitCode = $exitCode })
}

# --- 00: always runs, no required params -----------------------------------
Invoke-W17Script -Name '00-inventory'

# --- 10: needs an installer -------------------------------------------------
if ($InstallerPath) {
    Invoke-W17Script -Name '10-install-gs' -ScriptArgs @('-InstallerPath', $InstallerPath)
    $tenJson = Join-Path $runResultsDir '10-install-gs.json'
    if ((Test-Path -LiteralPath $tenJson) -and -not $InstallDir) {
        try {
            $tenResult = Get-Content -LiteralPath $tenJson -Raw | ConvertFrom-Json
            if ($tenResult.data.resolvedInstallDir) { $InstallDir = $tenResult.data.resolvedInstallDir }
        } catch { }
    }
} else {
    Invoke-W17Script -Name '10-install-gs' -Skip -SkipReason '-InstallerPath not given'
}

$haveInstall = [bool]$InstallDir

# --- 20: needs mapper + profile ---------------------------------------------
$haveMapperStage = [bool]($MapperExe -and $Profile)
if ($haveMapperStage) {
    Invoke-W17Script -Name '20-mapper-stage' -ScriptArgs @('-MapperExe', $MapperExe, '-Profile', $Profile, '-UserDataDir', $UserDataDir)
} else {
    Invoke-W17Script -Name '20-mapper-stage' -Skip -SkipReason '-MapperExe and/or -Profile not given'
}

# --- 30: needs an install dir + hotspot password ----------------------------
if ($haveInstall -and $Password) {
    Invoke-W17Script -Name '30-hotspot' -ScriptArgs @('-InstallDir', $InstallDir, '-Ssid', $Ssid, '-Password', $Password)
} else {
    $reason = if (-not $haveInstall) { 'no -InstallDir (and 10 did not run / did not resolve one)' } else { '-Password not given (never defaulted or invented)' }
    Invoke-W17Script -Name '30-hotspot' -Skip -SkipReason $reason
}

# --- 40: needs an install dir ------------------------------------------------
if ($haveInstall) {
    Invoke-W17Script -Name '40-mdns-udp' -ScriptArgs @('-InstallDir', $InstallDir, '-MdnsTimeoutMs', "$MdnsTimeoutMs")
} else {
    Invoke-W17Script -Name '40-mdns-udp' -Skip -SkipReason 'no -InstallDir (and 10 did not run / did not resolve one)'
}

# --- 50: needs an install dir + a completed 20 stage ------------------------
if ($haveInstall -and $haveMapperStage) {
    Invoke-W17Script -Name '50-race-day' -ScriptArgs @('-InstallDir', $InstallDir, '-UserDataDir', $UserDataDir, '-MapperWaitMs', "$MapperWaitMs")
} else {
    $reason = if (-not $haveInstall) { 'no -InstallDir (and 10 did not run / did not resolve one)' } else { '20-mapper-stage was skipped, so no racePrep is staged to drive' }
    Invoke-W17Script -Name '50-race-day' -Skip -SkipReason $reason
}

# --- 60: opt-in, human-in-the-loop ------------------------------------------
if ($IncludeHidTransition) {
    $sixtyArgs = @()
    if ($MapperExeForHidTransition) { $sixtyArgs += @('-MapperExe', $MapperExeForHidTransition) }
    if ($HidTransitionNonInteractive) { $sixtyArgs += '-NonInteractive' }
    Invoke-W17Script -Name '60-hid-transition' -ScriptArgs $sixtyArgs
} else {
    Invoke-W17Script -Name '60-hid-transition' -Skip -SkipReason 'not requested (-IncludeHidTransition not set) — physical unplug is human-in-the-loop, never run silently as part of an automated sweep'
}

# --- combined result file + console table -----------------------------------
$combined = [ordered]@{
    timestamp = $stamp
    utc       = (Get-Date).ToUniversalTime().ToString('o')
    params    = [ordered]@{
        installerPath = $InstallerPath; installDir = $InstallDir; userDataDir = $UserDataDir
        mapperExe = $MapperExe; profile = $Profile; ssid = $Ssid
        mdnsTimeoutMs = $MdnsTimeoutMs; mapperWaitMs = $MapperWaitMs
        includeHidTransition = [bool]$IncludeHidTransition
    }
    results   = $rows.ToArray()
}
$combinedPath = Join-Path $ResultsRoot "$stamp.json"
# BOM-less UTF-8, explicitly, for the same reason Save-W17Result is
# (lib/common.ps1): any JS/jq consumer of this file would choke on a BOM, and
# `Set-Content -Encoding utf8` writes one on Windows PowerShell 5.1.
[System.IO.File]::WriteAllText($combinedPath, ($combined | ConvertTo-Json -Depth 12) + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding $false))

Write-Host ''
Write-Host '=== W17 Windows-VM validation — results ==='
$rows | ForEach-Object {
    $mark = if ($_.skipped) { 'SKIP' } elseif ($_.ok) { 'PASS' } else { 'FAIL' }
    Write-Host ("  [{0,-4}] {1,-20} {2}" -f $mark, $_.script, $_.summary)
}
Write-Host ''
Write-Host "per-script JSON: $runResultsDir"
Write-Host "combined JSON:   $combinedPath"

$anyFail = @($rows.ToArray() | Where-Object { -not $_.skipped -and -not $_.ok }).Count -gt 0
exit ([int]$anyFail)
