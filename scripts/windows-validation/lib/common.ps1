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
        [hashtable] $Data = @{},
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

# Compact, single-line JSON — PS 5.1-safe (no -Compress-only PS7 assumptions;
# -Compress exists in 5.1 too, but Depth needs to be explicit because the
# default (2) silently truncates the nested `data` hashtables every script
# below builds).
function ConvertTo-W17Json {
    param([Parameter(Mandatory)] $InputObject)
    $InputObject | ConvertTo-Json -Depth 12 -Compress
}

# Prints the JSON line + a human summary, and returns the process exit code
# the caller should use (`exit (Write-W17Result $r)`).
function Write-W17Result {
    param([Parameter(Mandatory)] $Result)
    $json = ConvertTo-W17Json $Result
    Write-Output "W17VAL_RESULT: $json"
    $mark = if ($Result.ok) { 'PASS' } else { 'FAIL' }
    Write-Host ''
    Write-Host "[$mark] $($Result.script) — $($Result.summary)"
    if ($Result.findings -and $Result.findings.Count -gt 0) {
        Write-Host ("  known findings exercised: {0}" -f ($Result.findings -join ', '))
    }
    if ($Result.ok) { return 0 } else { return 1 }
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
        ConvertTo-W17Json $Result | Set-Content -Path $path -Encoding utf8
    } catch {
        Write-Host "  (could not write result file: $($_.Exception.Message))"
    }
}

# ---------------------------------------------------------------------------
# External command execution — mirrors the app's OWN safety rules so a
# validation run cannot wedge a VM the way a naive script could:
#  - shell:false-equivalent (argument array, never a concatenated string);
#  - a hard timeout with a taskkill /T tree-kill, the exact argv the app uses
#    at main/runCommand.js:14 (`taskkill /pid <pid> /t /f`) and
#    scripts/electron-smoke.js:69-77 (killTree) — a hung PowerShell/WinRT
#    child (the same class of hang hotspot.js's own PS scripts guard against)
#    must not orphan and block run-all.ps1.
# ---------------------------------------------------------------------------

function Invoke-W17Command {
    param(
        [Parameter(Mandatory)][string] $FilePath,
        [string[]] $ArgumentList = @(),
        [int] $TimeoutSec = 30,
        [hashtable] $Environment = $null
    )
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    foreach ($a in $ArgumentList) { $psi.ArgumentList.Add($a) }
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

# This file is dot-sourced (not imported as a .psm1 module), so every function
# above is already in the caller's scope — no Export-ModuleMember here.
