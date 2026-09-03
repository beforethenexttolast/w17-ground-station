#Requires -Version 5.1
<#
.SYNOPSIS
  W17 Windows-VM validation, step 20: stage the drive program (the mapper)
  and its saved profile exactly where the ground station's race-day
  orchestrator will look for them — and catch what it would otherwise miss.

.DESCRIPTION
  Path resolution (never guessed — read from the code that will run):
    - main/raceDayOrchestrator.js:159-160 reads `settingsStore.load()` then
      `normalizeRacePrep(settings.racePrep)` at race-day start;
    - shared/settings.js:220 DEFAULT_RACE_PREP / :223-230 normalizeRacePrep
      define the persisted shape: { mapperPath, profilePath, autoBridge };
      the subtree is admitted into settings.json ONLY when present
      (shared/settings.js:306-314) and is NOT env-overridable
      (shared/settings.js:217-219 — race day reads the persisted store
      directly, "the elrs pattern");
    - main/raceDayOrchestrator.js:50-71 `mapperArgv()` is the ONLY place an
      argv gets built from that profile path: it requires an ABSOLUTE path
      (win32 OR posix form) that does not start with `-`, or it refuses
      with kind 'bad-profile-path' — this script runs the identical check
      before staging, so a bad path is caught here, not at race-day time;
    - main/raceDayOrchestrator.js:44 MAPPER_ARG_WHITELIST is exactly
      ['-config-file-path'] TODAY — no flag for a serial port ever reaches
      the mapper through race day (this is CONFIRMED finding SYN-2 / MAP-2:
      "race day never starts the RF link"). This script does not paper over
      that; 50-race-day.ps1 is where it gets exercised end-to-end.

  Mapper flag introspection: this script runs `<mapper> -h` (Go's flag
  package prints usage and exits 2; this happens BEFORE flag.Parse() hands
  control to client.Init, so no serial port opens and no gRPC calls fire —
  see cmd/elrs-joystick-control/main.go:39-70 for the full flag set as
  written: webapp-port, grpc-port, tx-serial-port-name,
  tx-serial-port-baud-rate, config-file-path, disable-web-ui,
  headtrack-ingest, headtrack-port). It greps the REAL usage text for
  anything validate/lint/dry-run/check-shaped rather than assuming one
  exists or doesn't — MAP-5's proposed profile-unfilled refusal is not
  implemented as of w17-mapper HEAD, so this is expected to find nothing,
  but the check runs live in case a future mapper build adds one.

  Placeholder check (exposes MAP-5 "unfilled REPLACE-WITH-* placeholders
  pass schema, lint, the profile test and the GS pre-launch checks —
  nothing says a word"): greps the staged profile JSON for `REPLACE-WITH-`
  and FAILS this step when found, rather than letting a bench-unfilled
  profile silently reach race day.

  Finally writes (merges into) the GS's own settings.json with a validated
  `racePrep` subtree, using the exact on-disk shape main/settingsStore.js
  writes (JSON.stringify(obj, null, 2) + trailing newline —
  main/settingsStore.js:144), so race day (50-race-day.ps1) reads it
  through the real settingsStore.load() path unmodified.

.PARAMETER MapperExe
  Absolute path to the staged elrs-joystick-control.exe (win32 form).

.PARAMETER Profile
  Absolute path to the staged w17-ds4.json (or a bench copy of it).

.PARAMETER UserDataDir
  Where the GS's settings.json lives. Defaults to the formula in
  lib/common.ps1's Get-W17DefaultUserDataDir (derived from package.json +
  main/main.js:201 + main/settingsStore.js:51) — override once a real
  install's userData path is confirmed on the guest, or to target the same
  scratch profile 50-race-day.ps1 will use (`--user-data-dir`).

.PARAMETER AutoBridge
  Value written to racePrep.autoBridge (default true, matching
  shared/settings.js:220's DEFAULT_RACE_PREP).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $MapperExe,
    [Parameter(Mandatory)][string] $Profile,
    [string] $UserDataDir,
    [bool] $AutoBridge = $true,
    [string] $ResultsDir
)

. (Join-Path $PSScriptRoot 'lib\common.ps1')

if (-not $UserDataDir) { $UserDataDir = Get-W17DefaultUserDataDir }

$data = [ordered]@{
    mapperExe   = $MapperExe
    profile     = $Profile
    userDataDir = $UserDataDir
}
$findings = @()
$failures = New-Object System.Collections.Generic.List[string]

# --- existence -----------------------------------------------------------
$mapperExists = Test-Path -LiteralPath $MapperExe
$profileExists = Test-Path -LiteralPath $Profile
$data.mapperExeExists = $mapperExists
$data.profileExists = $profileExists
if (-not $mapperExists) { $failures.Add("mapper exe not found: $MapperExe") }
if (-not $profileExists) { $failures.Add("profile not found: $Profile") }

# --- path validity, mirroring raceDayOrchestrator.js:50-71 mapperArgv() --
function Test-W17RaceDayProfilePath {
    param([string] $Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return @{ ok = $false; kind = 'no-profile' } }
    $trimmed = $Path.Trim()
    if ($trimmed.StartsWith('-')) { return @{ ok = $false; kind = 'bad-profile-path' } }
    # win32 absolute: drive-letter (C:\...) or UNC (\\...); posix absolute: /...
    $isWin32Abs = $trimmed -match '^[a-zA-Z]:[\\/]' -or $trimmed.StartsWith('\\')
    $isPosixAbs = $trimmed.StartsWith('/')
    if (-not $isWin32Abs -and -not $isPosixAbs) { return @{ ok = $false; kind = 'bad-profile-path' } }
    return @{ ok = $true; argv = @('-config-file-path', $trimmed) }
}

$pathCheck = Test-W17RaceDayProfilePath -Path $Profile
$data.raceDayPathCheck = $pathCheck
if (-not $pathCheck.ok) {
    $failures.Add("profile path would be REFUSED by raceDayOrchestrator.js's mapperArgv(): $($pathCheck.kind)")
}

# --- placeholder check (MAP-5) --------------------------------------------
$placeholders = @()
if ($profileExists) {
    try {
        $lines = Get-Content -LiteralPath $Profile
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match 'REPLACE-WITH-[A-Z0-9-]*') {
                $placeholders += [pscustomobject]@{ line = $i + 1; text = $lines[$i].Trim(); token = $Matches[0] }
            }
        }
    } catch {
        $failures.Add("could not read profile for placeholder check: $($_.Exception.Message)")
    }
}
$data.placeholdersFound = $placeholders
if ($placeholders.Count -gt 0) {
    $findings += 'MAP-5'
    $failures.Add("profile still carries $($placeholders.Count) unfilled REPLACE-WITH- placeholder(s) — MAP-5: this passes the mapper's schema/lint/profile-test today; nothing downstream refuses it")
}

# --- mapper flag introspection (never guessed) ----------------------------
if ($mapperExists) {
    $helpRes = Invoke-W17Command -FilePath $MapperExe -ArgumentList @('-h') -TimeoutSec 10
    $helpText = "$($helpRes.stdout)`n$($helpRes.stderr)"
    $data.mapperHelpText = $helpText.Trim()
    $validationLike = [regex]::Matches($helpText, '(?im)^\s*-([a-z0-9-]*(validate|lint|dry-run|check|list-devices)[a-z0-9-]*)') |
        ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique
    $data.mapperValidationFlagsFound = @($validationLike)
    if ($validationLike.Count -eq 0) {
        $data.mapperValidationFlagNote = 'no validate/lint/dry-run/check/list-devices flag in the live -h output — confirms MAP-5/MAP-9''s "not implemented today" rather than assuming it from source alone'
    }
} else {
    $data.mapperHelpText = $null
}

# --- stage racePrep into settings.json ------------------------------------
# Mirrors main/settingsStore.js's on-disk shape exactly (JSON.stringify(obj,
# null, 2) + trailing newline, settingsStore.js:144) so settingsStore.load()
# reads this back through normalizeSettings() unmodified. A merge, not an
# overwrite: any settings.json already on disk keeps every other key.
$settingsPath = Join-Path $UserDataDir 'settings.json'
$data.settingsPath = $settingsPath

$racePrep = [ordered]@{
    mapperPath  = $MapperExe
    profilePath = $Profile
    autoBridge  = $AutoBridge
}
$data.stagedRacePrep = $racePrep

$stageOk = $true
if ($pathCheck.ok -and $mapperExists -and $profileExists) {
    try {
        New-Item -ItemType Directory -Force -Path $UserDataDir | Out-Null
        $existing = @{}
        if (Test-Path -LiteralPath $settingsPath) {
            # -AsHashtable is PS 6+ only; on 5.1 fall back to a manual
            # PSCustomObject -> ordered-hashtable walk so an existing
            # settings.json's OTHER keys are never dropped on a 5.1 host.
            if ($PSVersionTable.PSVersion.Major -ge 6) {
                try { $existing = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json -AsHashtable } catch { $existing = @{} }
            } else {
                try {
                    $obj = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
                    $existing = @{}
                    foreach ($p in $obj.PSObject.Properties) { $existing[$p.Name] = $p.Value }
                } catch { $existing = @{} }
            }
        }
        if ($null -eq $existing) { $existing = @{} }
        $existing['racePrep'] = $racePrep
        ($existing | ConvertTo-Json -Depth 12) + "`n" | Set-Content -LiteralPath $settingsPath -Encoding utf8 -NoNewline
        $data.settingsWritten = $true
    } catch {
        $stageOk = $false
        $failures.Add("could not write settings.json: $($_.Exception.Message)")
    }
} else {
    $stageOk = $false
    $data.settingsWritten = $false
}

$ok = ($failures.Count -eq 0) -and $stageOk
$summary = if ($ok) {
    "staged mapper + profile; racePrep written to $settingsPath; no placeholders"
} else {
    ($failures -join '; ')
}

$result = New-W17Result -Script '20-mapper-stage' -Ok $ok -Summary $summary -Data $data -Findings $findings
Save-W17Result -Result $result -ResultsDir $ResultsDir
exit (Write-W17Result $result)
