#Requires -Version 5.1
<#
.SYNOPSIS
  W17 Windows-VM validation, step 10: install the ground station and verify
  the deliverable — including CONFIRMED review finding boundaries-1 (the CI
  NSIS installer ships without mediamtx.exe, so the giftee build has no video
  relay).

.DESCRIPTION
  Runs the NSIS installer silently, then inventories the install directory
  against what electron-builder.yml actually promises to ship:
    - files: main/**, renderer/**, shared/**, package.json
      (electron-builder.yml:5-9) -> everything else, INCLUDING proto/, is
      absent from app.asar by construction. This script reports whether
      proto/ is packaged from that static fact (a build-config read, not a
      guess) and, when 7z.exe/asar tooling is available on the guest, backs
      it with a real peek inside app.asar.
    - extraResources: mediamtx -> mediamtx (electron-builder.yml:12-15) is
      the ONLY way mediamtx.exe reaches the install directory. CI
      (.github/workflows/ci.yml) never runs `node scripts/fetch-mediamtx.js`
      before packaging, so mediamtx/ is empty at build time and the shipped
      installer's resources\mediamtx\ directory is EMPTY. This step FAILS
      LOUDLY on that — boundaries-1's exact failure mode — instead of the
      silent "video just doesn't work" the giftee would otherwise hit.

  Verifies: install directory exists, the main exe exists
  ("W17 Ground Station.exe" — electron-builder.yml:2 productName), an
  Uninstall registry entry was created, and reports the installed
  DisplayVersion.

.PARAMETER InstallerPath
  Path to the NSIS installer .exe (the CI artifact `w17-ground-station-nsis-
  unsigned`, or a local `npm run build` output under dist\).

.PARAMETER Silent
  Attempt a silent install (`/S`). electron-builder's default NSIS target is
  "oneClick" (no `oneClick: false` in electron-builder.yml), which normally
  runs unattended anyway and installs per-user under
  `%LOCALAPPDATA%\Programs\<productName>`; `/S` is the documented NSIS
  convention electron-builder honors on top of that. Neither the oneClick
  default nor the exact install path has been observed against a REAL built
  installer in this session (no Windows box available) — [win-TBD] until a
  script here runs against a real artifact; -InstallDir lets the caller pin
  it once that is known.

.PARAMETER InstallDir
  Optional explicit install directory override (NSIS `/D=` convention — must
  be the LAST argument, unquoted, no trailing backslash, per NSIS's own rule;
  this script enforces that ordering).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $InstallerPath,
    [switch] $Silent = $true,
    [string] $InstallDir,
    [string] $ResultsDir
)

. (Join-Path $PSScriptRoot 'lib\common.ps1')

$data = [ordered]@{ installerPath = $InstallerPath }
$findings = @()

if (-not (Test-Path -LiteralPath $InstallerPath)) {
    $r = New-W17Result -Script '10-install-gs' -Ok $false -Summary "installer not found: $InstallerPath" -Data $data
    Save-W17Result -Result $r -ResultsDir $ResultsDir
    exit (Write-W17Result $r)
}

try {
    $hash = Get-FileHash -LiteralPath $InstallerPath -Algorithm SHA256
    $data.installerSha256 = $hash.Hash
} catch { $data.installerSha256 = $null }

# --- run the installer --------------------------------------------------
$argList = @()
if ($Silent) { $argList += '/S' }
if ($InstallDir) { $argList += "/D=$InstallDir" } # must stay last per NSIS convention

$data.installerArgs = $argList
$installRes = Invoke-W17Command -FilePath $InstallerPath -ArgumentList $argList -TimeoutSec 180
$data.installExitCode = $installRes.exitCode
$data.installTimedOut = $installRes.timedOut
$data.installStderr = $installRes.stderr

if ($installRes.timedOut) {
    $r = New-W17Result -Script '10-install-gs' -Ok $false -Summary 'installer timed out after 180s (a oneClick NSIS installer should be near-instant; a non-silent stall usually means /S was not honored — verify against a real artifact, [win-TBD])' -Data $data
    Save-W17Result -Result $r -ResultsDir $ResultsDir
    exit (Write-W17Result $r)
}

# --- resolve the install directory --------------------------------------
$apps = Get-W17InstalledApps -NamePattern 'W17 Ground Station'
$data.uninstallRegistryEntries = $apps

$resolvedDir = $null
if ($InstallDir) {
    $resolvedDir = $InstallDir
} elseif ($apps -and $apps.Count -gt 0 -and $apps[0].InstallLocation) {
    $resolvedDir = $apps[0].InstallLocation
} else {
    # Fallback formula for electron-builder's default oneClick NSIS target
    # (per-user, %LOCALAPPDATA%\Programs\<productName>) — NOT yet confirmed
    # against a real installer in this session. [win-TBD]
    $resolvedDir = Join-Path $env:LOCALAPPDATA 'Programs\W17 Ground Station'
    $data.installDirIsFallbackGuess = $true
}
$data.resolvedInstallDir = $resolvedDir

$exePath = Join-Path $resolvedDir 'W17 Ground Station.exe'
$resourcesDir = Join-Path $resolvedDir 'resources'
$asarPath = Join-Path $resourcesDir 'app.asar'
$mediamtxDir = Join-Path $resourcesDir 'mediamtx'
$mediamtxExe = Join-Path $mediamtxDir 'mediamtx.exe'

$data.exeExists = Test-Path -LiteralPath $exePath
$data.asarExists = Test-Path -LiteralPath $asarPath
$data.mediamtxDirExists = Test-Path -LiteralPath $mediamtxDir
$data.mediamtxExeExists = Test-Path -LiteralPath $mediamtxExe
$data.mediamtxDirListing = if ($data.mediamtxDirExists) { @(Get-ChildItem -LiteralPath $mediamtxDir -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name) } else { @() }

# boundaries-1: the confirmed failure mode — installer ships, mediamtx does not.
if (-not $data.mediamtxExeExists) {
    $findings += 'boundaries-1'
}

# --- proto/ packaging check --------------------------------------------
# Static fact from electron-builder.yml:5-9's `files:` allowlist: proto/ is
# not listed, so it is never asar-packed, independent of anything on disk.
$data.protoPackagedByBuildConfig = $false
$data.protoPackagingBasis = 'electron-builder.yml:5-9 files: allowlist (main/**, renderer/**, shared/**, package.json) does not include proto/'

# Best-effort real peek inside app.asar, only if tooling exists on the guest
# (never installed by this script — COMMON.md: no software installs on this
# Mac, and this runs on the guest anyway, but still: never silently fetches
# a tool over the network).
$data.protoPackagedObserved = $null
if ($data.asarExists) {
    $asarCli = Get-Command 'asar' -ErrorAction SilentlyContinue
    if ($asarCli) {
        try {
            $listing = & $asarCli.Source list $asarPath 2>$null
            $data.protoPackagedObserved = ($listing -match '(^|/)proto/') -is [array] -and (($listing -match '(^|/)proto/').Count -gt 0)
        } catch { $data.protoPackagedObserved = $null }
    } else {
        $data.protoObservationNote = 'no `asar` CLI on the guest — relying on the static files: allowlist fact above (documented, not guessed)'
    }
}

$ok = $data.exeExists -and $data.asarExists -and $data.mediamtxExeExists -and ($apps -and $apps.Count -gt 0)
$summaryBits = @()
if (-not $data.exeExists) { $summaryBits += 'main exe missing' }
if (-not $data.asarExists) { $summaryBits += 'app.asar missing' }
if (-not $data.mediamtxExeExists) { $summaryBits += 'mediamtx.exe MISSING (boundaries-1: CI never runs fetch-mediamtx.js before packaging — video relay is absent by construction)' }
if (-not ($apps -and $apps.Count -gt 0)) { $summaryBits += 'no Uninstall registry entry found' }
$summary = if ($ok) { "installed at $resolvedDir; mediamtx present; proto/ correctly absent (files: allowlist)" } else { $summaryBits -join '; ' }

$result = New-W17Result -Script '10-install-gs' -Ok $ok -Summary $summary -Data $data -Findings $findings
Save-W17Result -Result $result -ResultsDir $ResultsDir
exit (Write-W17Result $result)
