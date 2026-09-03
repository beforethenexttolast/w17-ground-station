#Requires -Version 7.0
# Shared helpers for the W17 Windows-VM validation scripts (owner decision A4:
# a VMware Fusion VM on the owner's Apple Silicon Mac, driven autonomously from
# the Mac over SSH; a real Windows PC is the final proof only at handover).
#
# Dot-source this from every 0N-*.ps1 script:
#   . (Join-Path $PSScriptRoot 'lib\common.ps1')
#
# Contract every script in this folder follows (COMMON.md / B4 brief):
#  - idempotent — safe to re-run; never assumes a clean machine beyond what it
#    itself checks;
#  - one line of compact JSON on stdout per run, prefixed W17VAL_RESULT: (so a
#    human `Get-Content` and a machine `Select-String` both work without
#    parsing prose), PLUS a human-readable PASS/FAIL summary;
#  - exit 0 on PASS, exit 1 on FAIL — run-all.ps1 aggregates both;
#  - never asserts a hardware/Windows fact this session could not verify from
#    code or a real run — unverifiable values are reported as $null with an
#    explicit "unverified" note, never invented (workspace CLAUDE.md safety
#    rule: A2 NOT-EXECUTED / Phase B BLOCKED, no invented numbers).
#
# Nothing here flashes, uploads, or powers hardware, and nothing opens a
# serial port for control — the serial/HID inventory below is read-only
# enumeration (WMI/PnP queries), never a port open.
#
# POWERSHELL 7 IS REQUIRED (`#Requires -Version 7.0`, above and on every script
# in this directory). This is not a preference. Invoke-W17Command below uses
# System.Diagnostics.ProcessStartInfo.ArgumentList, which is .NET Core 2.1+ /
# .NET 5+ ONLY — it does not exist on the .NET Framework that Windows
# PowerShell 5.1 runs on, so under 5.1 the property access throws and every
# script that shells out dies. Windows 11 does NOT ship PowerShell 7: install
# it on the guest first (`winget install --id Microsoft.PowerShell --source
# winget`; workspace runbook §1.6). run-all.ps1's Resolve-W17Shell REFUSES to
# fall back to powershell.exe for the same reason — a loud refusal beats eight
# scripts failing one by one with .NET stack traces.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Result envelope
# ---------------------------------------------------------------------------

function New-W17Result {
    param(
        [Parameter(Mandatory)][string] $Script,
        [Parameter(Mandatory)][bool] $Ok,
        [Parameter(Mandatory)][string] $Summary,
        # [System.Collections.IDictionary], NOT [hashtable]: every caller
        # passes an [ordered]@{} built key-by-key in a deliberate reading
        # order. A [hashtable] cast silently rebuilds it as an unordered
        # System.Collections.Hashtable, and ConvertTo-Json then emits the keys
        # scrambled (measured under pwsh 7.7 with the real 16-key 50-race-day
        # $data: order preserved = False for [hashtable], True for
        # IDictionary). IDictionary binds [ordered]@{} AND plain @{}.
        [System.Collections.IDictionary] $Data = @{},
        [string[]] $Findings = @()   # confirmed review-seed ids this run bears on, e.g. 'MAP-1'
    )
    [pscustomobject]@{
        script    = $Script
        ok        = $Ok
        summary   = $Summary
        data      = $Data
        findings  = $Findings
        host      = $env:COMPUTERNAME
        utc       = (Get-Date).ToUniversalTime().ToString('o')
    }
}

# Compact, single-line JSON. -Depth is explicit because the default (2)
# silently truncates the nested `data` dictionaries every script below builds.
function ConvertTo-W17Json {
    param([Parameter(Mandatory)] $InputObject)
    $InputObject | ConvertTo-Json -Depth 12 -Compress
}

# Prints the JSON line + a human summary, and returns the process exit code
# the caller should use (`exit (Write-W17Result $r)`).
#
# The JSON line goes out through [Console]::Out.WriteLine, NOT Write-Output.
# This is load-bearing, not style. Every caller writes `exit (Write-W17Result
# $r)`; a parenthesised call CAPTURES the function's success stream, so a
# Write-Output line would never reach stdout at all — it would become element
# [0] of the returned array. Measured under pwsh 7.7.0-preview.4 with the
# original Write-Output form: the W17VAL_RESULT line was absent from stdout,
# the function returned System.Object[] (Count 2: the string, then the int),
# and `exit <array>` set the process exit code to **0 even for a FAIL result**
# — so run-all's PASS/FAIL aggregation silently inverted too. Two failures
# from one line. [Console]::Out bypasses the PowerShell success stream
# entirely: it is the process's real stdout handle, so it survives `exit (…)`,
# survives `6>$null` (which would suppress Write-Host), and is captured by a
# parent's RedirectStandardOutput exactly like any other child output
# (measured: a child's Write-Host, [Console]::Out and Write-Output lines all
# arrive on the parent's redirected stdout, in order).
function Write-W17Result {
    param([Parameter(Mandatory)] $Result)
    $json = ConvertTo-W17Json $Result
    [Console]::Out.WriteLine("W17VAL_RESULT: $json")
    $mark = if ($Result.ok) { 'PASS' } else { 'FAIL' }
    Write-Host ''
    Write-Host "[$mark] $($Result.script) — $($Result.summary)"
    if ($Result.findings -and $Result.findings.Count -gt 0) {
        Write-Host ("  known findings exercised: {0}" -f ($Result.findings -join ', '))
    }
    if ($Result.ok) { return 0 } else { return 1 }
}

# StrictMode-safe property read. `Set-StrictMode -Version Latest` (above) makes
# a missing property on a PSCustomObject THROW rather than return $null
# (measured: "The property 'result' cannot be found on this object"), and every
# probe in this suite returns one of several differently-shaped objects: the
# happy `{ok,result}` shape, and the `{ok,kind,raw}` shapes the wrappers
# synthesise for `no-result-line` / `unparseable-result`. Reaching straight for
# `$probe.result.kind` on a refusal therefore kills the script with a raw
# PowerShell stack trace BEFORE it can print a W17VAL_RESULT envelope or call
# Save-W17Result — which is exactly the outcome a validation suite must never
# have, since the refusal shapes (`not-staged`, `module-load-failed`, the
# out-of-scope guards, `bad-args`) are the MOST likely ones on a real guest.
# Use this everywhere a probe result is dereferenced; it is null-safe on the
# object, the property, and the value.
function Get-W17Prop {
    param($Object, [Parameter(Mandatory)][string] $Name, $Default = $null)
    if ($null -eq $Object) { return $Default }
    $prop = $Object.PSObject.Properties[$Name]
    if ($null -eq $prop) { return $Default }
    if ($null -eq $prop.Value) { return $Default }
    return $prop.Value
}

# The one-line "why did the probe refuse?" string, built from whichever of
# kind/error/status the actual shape carries. Never throws.
function Get-W17ProbeReason {
    param($Probe)
    if ($null -eq $Probe) { return 'probe returned nothing (script did not run, or produced no output at all)' }
    $inner  = Get-W17Prop $Probe 'result'
    $kind   = Get-W17Prop $inner 'kind'   (Get-W17Prop $Probe 'kind' '(no kind)')
    $err    = Get-W17Prop $inner 'error'  (Get-W17Prop $Probe 'error' '(no error text)')
    return "kind=$kind error=$err"
}

# Also writes the JSON line to <ResultsDir>\<Script>.json when -ResultsDir is
# supplied by the caller (run-all.ps1 always supplies one; a lone script run
# by hand over SSH may not, and stdout capture alone is enough for that case).
function Save-W17Result {
    param([Parameter(Mandatory)] $Result, [string] $ResultsDir)
    if (-not $ResultsDir) { return }
    try {
        New-Item -ItemType Directory -Force -Path $ResultsDir | Out-Null
        $path = Join-Path $ResultsDir "$($Result.script).json"
        # BOM-less UTF-8, explicitly. Node's JSON.parse REFUSES a leading BOM
        # ("Unexpected token") and nothing downstream strips one, so a BOM here
        # would turn a readable result file into an unreadable one for any JS
        # consumer. Written through WriteAllText rather than Set-Content so the
        # encoding is stated in the code and cannot drift with a host default.
        [System.IO.File]::WriteAllText($path, (ConvertTo-W17Json $Result) + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding $false))
    } catch {
        Write-Host "  (could not write result file: $($_.Exception.Message))"
    }
}

# ---------------------------------------------------------------------------
# External command execution — mirrors the app's OWN safety rules so a
# validation run cannot wedge a VM the way a naive script could:
#  - shell:false-equivalent (argument array, never a concatenated string);
#  - a hard timeout with a taskkill /T tree-kill, the exact argv the app uses
#    at main/runCommand.js:14 (`winTreeKillArgs` -> `/pid <pid> /t /f`) and
#    scripts/electron-smoke.js:59-73 (killTree) — a hung PowerShell/WinRT
#    child (the same class of hang hotspot.js's own PS scripts guard against)
#    must not orphan and block run-all.ps1.
#
# -ArgumentList is the default and the right choice everywhere: .NET quotes
# each element for the child, so nothing goes through a shell. -RawArguments is
# the deliberate escape hatch for the ONE caller that must NOT be quoted (NSIS
# `/D=`, 10-install-gs.ps1 — see there). The two are mutually exclusive: .NET
# throws "Only one of Arguments or ArgumentList may be used." if both are set,
# so this function refuses that combination up front with a clearer message.
# ---------------------------------------------------------------------------

function Invoke-W17Command {
    param(
        [Parameter(Mandatory)][string] $FilePath,
        [string[]] $ArgumentList = @(),
        [int] $TimeoutSec = 30,
        [hashtable] $Environment = $null,
        [string] $RawArguments
    )
    if ($RawArguments -and $ArgumentList.Count -gt 0) {
        throw 'Invoke-W17Command: pass -ArgumentList OR -RawArguments, never both (.NET allows only one).'
    }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    if ($RawArguments) { $psi.Arguments = $RawArguments }
    else { foreach ($a in $ArgumentList) { $psi.ArgumentList.Add($a) } }
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    if ($Environment) {
        foreach ($k in $Environment.Keys) { $psi.Environment[$k] = [string]$Environment[$k] }
    }
    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    $stdout = New-Object System.Text.StringBuilder
    $stderr = New-Object System.Text.StringBuilder
    # KNOWN-UNCERTAIN (not yet observed on a real guest): -Action script blocks
    # run on the PowerShell event queue, which this function then blocks on in
    # WaitForExit. If a runspace-scheduling stall ever swallows output, the
    # worst case is an EMPTY stdout -> a false FAIL that the caller reports
    # cleanly, never a crash or a false PASS. 50-race-day.ps1's post-exit flush
    # sleep exists for the same reason. [win-TBD] until a real run confirms it.
    $outEvt = Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -Action { if ($EventArgs.Data -ne $null) { $Event.MessageData.AppendLine($EventArgs.Data) | Out-Null } } -MessageData $stdout
    $errEvt = Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived -Action { if ($EventArgs.Data -ne $null) { $Event.MessageData.AppendLine($EventArgs.Data) | Out-Null } } -MessageData $stderr
    try {
        $proc.Start() | Out-Null
        $proc.BeginOutputReadLine()
        $proc.BeginErrorReadLine()
        $finished = $proc.WaitForExit($TimeoutSec * 1000)
        if (-not $finished) {
            try { Start-Process -FilePath 'taskkill' -ArgumentList @('/pid', "$($proc.Id)", '/t', '/f') -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue } catch {}
            return [pscustomobject]@{ ok = $false; exitCode = $null; stdout = $stdout.ToString(); stderr = $stderr.ToString(); timedOut = $true }
        }
        return [pscustomobject]@{ ok = ($proc.ExitCode -eq 0); exitCode = $proc.ExitCode; stdout = $stdout.ToString(); stderr = $stderr.ToString(); timedOut = $false }
    } finally {
        Unregister-Event -SourceIdentifier $outEvt.Name -ErrorAction SilentlyContinue
        Unregister-Event -SourceIdentifier $errEvt.Name -ErrorAction SilentlyContinue
        $proc.Dispose()
    }
}

# ---------------------------------------------------------------------------
# Environment facts
# ---------------------------------------------------------------------------

# Same locale-neutral technique as main/hotspot.js's PS_ELEV block (hotspot.js:
# 144-156): the process token, never localized whoami/net.exe prose.
function Test-W17IsAdministrator {
    $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object System.Security.Principal.WindowsPrincipal($id)
    return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Best-effort VMware guest detection (owner decision A4: VMware Fusion host).
# Never fails the caller — returns $false/'unknown' honestly when the checks
# themselves cannot run (e.g. WMI blocked).
function Get-W17VirtualizationInfo {
    $result = [ordered]@{ isVMware = $false; manufacturer = $null; model = $null; vmwareToolsService = $null }
    try {
        $cs = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop
        $result.manufacturer = $cs.Manufacturer
        $result.model = $cs.Model
        if ($cs.Manufacturer -match 'VMware' -or $cs.Model -match 'VMware') { $result.isVMware = $true }
    } catch { }
    try {
        $svc = Get-Service -Name 'VMTools' -ErrorAction SilentlyContinue
        if ($svc) { $result.vmwareToolsService = $svc.Status.ToString() }
    } catch { }
    return $result
}

# Registry Uninstall-key search across both native and Wow6432Node hives plus
# the per-user hive, matching on DisplayName. Returns an array (possibly
# empty) — never throws when a hive is missing.
function Get-W17InstalledApps {
    param([string] $NamePattern = 'W17')
    $roots = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    $found = @()
    foreach ($root in $roots) {
        try {
            $found += Get-ItemProperty -Path $root -ErrorAction SilentlyContinue |
                Where-Object { $_.DisplayName -and $_.DisplayName -match $NamePattern } |
                Select-Object DisplayName, DisplayVersion, InstallLocation, UninstallString, Publisher
        } catch { }
    }
    return $found
}

# The GS's own userData directory formula (NOT a guess — derived from the
# shipped files): package.json (repo root; shipped verbatim into app.asar per
# electron-builder.yml `files:`) carries no top-level `productName`, only
# `"name": "w17-ground-station"`, so Electron's default app.getName() (and
# therefore app.getPath('userData') = <roaming appdata>\<app name>) resolves
# to that name — see main/main.js:201 (`app.getPath('userData')` fed straight
# into createSettingsStore) and main/settingsStore.js:51
# (`path.join(dir, 'settings.json')`). Overridable because this is a formula,
# not something this (non-Windows) session could execute and confirm —
# [win-TBD] until a script here actually observes it on the VM.
function Get-W17DefaultUserDataDir {
    return (Join-Path $env:APPDATA 'w17-ground-station')
}

# HID: DualShock 4 (VID 054C, PID 05C4 or 09CC). Shared between 00-inventory.ps1
# (one-shot baseline survey) and 60-r15-pad-unplug.ps1 (polled before/during/
# after an operator-driven physical unplug/replug, R15). Returns a result
# object rather than throwing or touching an outer $notes list, so both
# callers can decide for themselves how to surface a WMI failure — mirrors
# the error-in-the-return-value shape of Get-W17WlanDrivers, which lives in
# 00-inventory.ps1 (its only caller), not in this file.
#
# What this can and cannot prove (read before trusting a "PASS" from either
# caller): this reports what WINDOWS sees on the USB/HID bus. CONFIRMED
# finding MAP-6 (w17-mapper/pkg/devices/controller.go:43 — the mapper's own
# SDL gamepad registry is built once at process boot via EnumerateDevices()
# and the poll loop discards every add/remove event body, controller.go:
# 139-149) lives one layer up, inside the mapper's own process — Windows
# re-enumerating the HID device fine tells you nothing about whether the
# mapper's internal registry ever resolves the id again. Neither script here
# closes that gap (no gRPC/control-path probe is built for it, by design —
# COMMON.md: never open a serial port, and the GS itself has no read-only
# gamepad-registry query to the mapper either — main/HeadIntentDiagnosticsClient.js
# is the only gRPC client this app has, and it is a different, one-way, W3
# diagnostics-only channel).
function Get-W17Ds4Devices {
    $devices = @()
    try {
        $entities = Get-CimInstance -ClassName Win32_PnPEntity -ErrorAction Stop |
            Where-Object { $_.PNPDeviceID -match 'VID_054C&PID_(05C4|09CC)' }
        foreach ($e in $entities) {
            $devices += [pscustomobject]@{
                name = $e.Name
                pnpDeviceId = $e.PNPDeviceID
                status = $e.Status
                generation = if ($e.PNPDeviceID -match 'PID_05C4') { 'CUH-ZCT1x (v1)' } else { 'CUH-ZCT2x (v2)' }
            }
        }
        return @{ devices = $devices; error = $null }
    } catch {
        return @{ devices = @(); error = $_.Exception.Message }
    }
}

# This file is dot-sourced (not imported as a .psm1 module), so every function
# above is already in the caller's scope — no Export-ModuleMember here.
