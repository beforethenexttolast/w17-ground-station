#Requires -Version 7.0
<#
.SYNOPSIS
  W17 Windows-VM validation, step 10: install the ground station and verify
  that the installed tree really contains what the build config promises —
  the video relay (mediamtx) and the runtime-loaded proto/.

.DESCRIPTION
  WHAT CHANGED, AND WHY THIS SCRIPT'S MEANING FLIPPED. When this script was
  written, boundaries-1 was live: CI packaged without ever running
  `scripts/fetch-mediamtx.js`, so the shipped installer's
  resources\mediamtx\ was EMPTY and the giftee build had no video relay;
  and proto/ was excluded from the `files:` allowlist. BOTH ARE FIXED ON
  MAIN as of the GS fix wave, verified here at HEAD:
    - .github/workflows/ci.yml:79 now runs `node scripts/fetch-mediamtx.js`
      BEFORE `npx electron-builder --dir` (:80), and :85 runs
      `node scripts/assert-packaged.js dist/win-unpacked`, which asserts the
      mediamtx executable, its mediamtx.yml, and the packaged proto/ —
      "rather than trusting that the step above did its job".
    - electron-builder.yml:14 now lists `proto/**` in `files:` (review
      boundaries-6: main/headIntentGrpcConnect.js:23 loads it at RUNTIME).
  So this step is NO LONGER a reproduction of a known defect. It is now a
  REGRESSION CHECK on the guest, against the real installed tree rather than
  against `dist\win-unpacked` in CI: if mediamtx.exe or proto/ is missing
  here, either CI's assertion was bypassed or the NSIS packaging step drops
  something `--dir` keeps. A FAIL from this script now means something NEW.

  It still inventories the install directory against what
  electron-builder.yml promises:
    - files: main/**, renderer/**, shared/**, proto/**, package.json
      (electron-builder.yml:5-15). This script reports whether proto/ is
      packaged from that static fact (a build-config read, not a guess) and,
      when asar tooling is available on the guest, backs it with a real peek
      inside app.asar.
    - extraResources: mediamtx -> mediamtx (electron-builder.yml:18-21) is
      the ONLY way mediamtx.exe reaches the install directory.

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
  Optional explicit install directory override, passed with the NSIS `/D=`
  convention. NSIS's rule has THREE parts and this script now honours all
  three (review finding N8 — it previously honoured only the first):
    1. `/D=` must be the LAST argument. Enforced by argument order below.
    2. The path must NOT be quoted. `/D=` swallows the rest of the command
       line verbatim, so quotes become part of the directory name. This is
       why the argument is handed to Invoke-W17Command as -RawArguments and
       not -ArgumentList: .NET's ArgumentList quotes any element containing a
       space, and electron-builder's own default install path
       (`%LOCALAPPDATA%\Programs\W17 Ground Station`) contains one — so the
       previous -ArgumentList form would have produced `/D="C:\...\W17 Ground
       Station"` and NSIS would have created a directory whose name included
       the quote characters.
    3. No trailing backslash. Trimmed below.
  Everything about how a REAL electron-builder NSIS artifact responds to `/S`
  and `/D=` is [win-TBD]: no Windows and no built installer were available to
  this session.
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
# N8: when -InstallDir is given the whole command line goes through
# -RawArguments UNQUOTED, because NSIS's `/D=` takes the rest of the line
# verbatim (see .PARAMETER InstallDir above). With no -InstallDir there is
# nothing that must stay unquoted, so the safer quoted -ArgumentList path is
# used. `/D=` is always last, and a trailing backslash is stripped.
$argList = @()
if ($Silent) { $argList += '/S' }

if ($InstallDir) {
    $dirForNsis = $InstallDir.TrimEnd('\', '/')
    $rawArgs = (@($argList) + @("/D=$dirForNsis")) -join ' '
    $data.installerArgs = $rawArgs
    $data.installerArgStyle = 'raw (unquoted) — NSIS /D= must not be quoted'
    $installRes = Invoke-W17Command -FilePath $InstallerPath -RawArguments $rawArgs -TimeoutSec 180
} else {
    $data.installerArgs = $argList
    $data.installerArgStyle = 'argument array (each element quoted by .NET)'
    $installRes = Invoke-W17Command -FilePath $InstallerPath -ArgumentList $argList -TimeoutSec 180
}
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

# @($apps) throughout: Get-W17InstalledApps returns an array, but PowerShell
# unrolls a one-element array on return, so a single matching registry entry
# arrives here as a bare PSCustomObject (the same unrolling that caused N7).
$appList = @($apps)
$resolvedDir = $null
if ($InstallDir) {
    $resolvedDir = $InstallDir
} elseif ($appList.Count -gt 0 -and $appList[0].InstallLocation) {
    $resolvedDir = $appList[0].InstallLocation
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

# boundaries-1 was FIXED on main (ci.yml:79 fetches, :85 asserts). A missing
# mediamtx.exe here is therefore no longer the expected outcome — it is a
# REGRESSION, or a difference between what CI asserts on dist\win-unpacked and
# what the NSIS installer actually lays down on a guest. The id is still tagged
# so the trail from finding to evidence stays intact, but the note says which
# reading applies.
if (-not $data.mediamtxExeExists) {
    $findings += 'boundaries-1'
    $data.boundaries1Reading = 'boundaries-1 was FIXED on main (ci.yml:79 runs fetch-mediamtx.js before packaging; ci.yml:85 runs assert-packaged.js). Seeing mediamtx.exe missing HERE is not the old known defect reproducing — it is either a regression, or something the NSIS installer drops that CI''s dist\win-unpacked assertion does not catch. Investigate; do not file it as "expected".'
}

# --- proto/ packaging check --------------------------------------------
# Static fact from electron-builder.yml's `files:` allowlist. This flipped
# with the GS fix wave: proto/** is now LISTED (electron-builder.yml:14), so
# it IS asar-packed, and CI asserts its presence (ci.yml:85 ->
# scripts/assert-packaged.js). The earlier version of this script recorded
# $false here and called proto/ "absent by construction"; that was true when
# it was written and is false now.
$data.protoPackagedByBuildConfig = $true
$data.protoPackagingBasis = 'electron-builder.yml:5-15 files: allowlist now includes proto/** (added for review boundaries-6: main/headIntentGrpcConnect.js:23 loads it at RUNTIME, so a build without it throws when the head-intent diagnostics consumer connects). CI asserts it at .github/workflows/ci.yml:85 via scripts/assert-packaged.js.'

# Best-effort real peek inside app.asar, only if tooling exists on the guest
# (never installed by this script — COMMON.md: no software installs on this
# Mac, and this runs on the guest anyway, but still: never silently fetches
# a tool over the network).
$data.protoPackagedObserved = $null
if ($data.asarExists) {
    $asarCli = Get-Command 'asar' -ErrorAction SilentlyContinue
    if ($asarCli) {
        try {
            # N7, with the diagnosis corrected by measurement. The old test was
            #   ($listing -match '…') -is [array] -and (… ).Count -gt 0
            # The array that unrolls is $listing, NOT the match result: `& cmd`
            # yields a STRING when the command prints exactly one line and an
            # object[] when it prints more. Over an array, `-match` returns the
            # matching ELEMENTS (an array even for one match — measured, so the
            # review's "single match" reading is not the trigger); over a
            # scalar string it returns a BOOLEAN, and `$true -is [array]` is
            # $false. So the old form reported "proto/ absent" whenever the
            # listing was a single line that WAS proto/.
            # The `@(...)` must therefore go around $listing, before -match.
            # Wrapping only the result is worse than the bug: `@($false).Count`
            # is 1, so it would report proto/ PRESENT for any one-line listing.
            # Measured over all six shapes (array 1/2/0 matches, scalar match,
            # scalar non-match, empty): old wrong on 1 of 6, result-only wrap
            # wrong on 1 of 6, this form correct on 6 of 6.
            $listing = & $asarCli.Source list $asarPath 2>$null
            $data.protoPackagedObserved = (@(@($listing) -match '(^|/)proto/').Count -gt 0)
        } catch { $data.protoPackagedObserved = $null }
    } else {
        $data.protoObservationNote = 'no `asar` CLI on the guest — relying on the static files: allowlist fact above (documented, not guessed)'
    }
}

$ok = $data.exeExists -and $data.asarExists -and $data.mediamtxExeExists -and ($appList.Count -gt 0)
$summaryBits = @()
if (-not $data.exeExists) { $summaryBits += 'main exe missing' }
if (-not $data.asarExists) { $summaryBits += 'app.asar missing' }
if (-not $data.mediamtxExeExists) { $summaryBits += 'mediamtx.exe MISSING — this is now a REGRESSION, not the known boundaries-1 defect: ci.yml:79 fetches it before packaging and ci.yml:85 asserts it is packaged. Either CI was bypassed for this artifact, or NSIS drops what --dir keeps' }
if ($appList.Count -eq 0) { $summaryBits += 'no Uninstall registry entry found' }
# proto/ is now EXPECTED to be present; flag its absence, and flag a mismatch
# between the build config and what asar actually shows.
if ($null -ne $data.protoPackagedObserved -and -not $data.protoPackagedObserved) {
    $summaryBits += 'proto/ NOT found inside app.asar although electron-builder.yml:14 lists proto/** and ci.yml:85 asserts it — packaging regression'
    $ok = $false
}
$summary = if ($ok) { "installed at $resolvedDir; mediamtx present; proto/ packaged as electron-builder.yml:14 requires" } else { $summaryBits -join '; ' }

$result = New-W17Result -Script '10-install-gs' -Ok $ok -Summary $summary -Data $data -Findings $findings
Save-W17Result -Result $result -ResultsDir $ResultsDir
exit (Write-W17Result $result)
