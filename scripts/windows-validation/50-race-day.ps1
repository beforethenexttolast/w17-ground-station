#Requires -Version 5.1
<#
.SYNOPSIS
  W17 Windows-VM validation, step 50: exercise race day's mapper step end to
  end against the REAL installed build, to gather runtime evidence for
  CONFIRMED v2-review blockers/findings spanning BOTH repos' reports
  (w17-mapper.v2report.json's MAP-1/MAP-2/MAP-8, and
  w17-ground-station.v2report.json's own SYN-2/boundaries-3/boundaries-4/
  boundaries-5 — several of these are the SAME underlying defect confirmed
  independently from each repo's own review pass) — this step is EXPECTED
  TO FAIL against today's code; that failure IS the finding being exposed,
  not a bug in this script.

.DESCRIPTION
  MAP-1 (blocker, mapper repo) — `-config-file-path` double-wraps the
  committed profile: grpc_client.go:57-62 puts the WHOLE staged file into
  SetConfigReq.Config; server_grpc.go:103-104 re-marshals that into
  {"config": <file>}; configs/w17-ds4.json already carries that wrapper;
  pkg/config/schema.yaml then rejects the doubled document; grpc_client.go:63
  panics. The mapper race day spawns is therefore expected to crash shortly
  after launch.

  MAP-2 (blocker, mapper repo) / SYN-2 (blocker, GS repo — "RACE DAY starts
  the drive program but never its radio link") — race day's argv whitelist
  (MAPPER_ARG_WHITELIST, raceDayOrchestrator.js:44) is EXACTLY
  `-config-file-path`, and no GS code ever calls the mapper's StartLink RPC —
  so even a mapper that survives never drives the RF link, and the COM port
  is never opened by race day either (a structural consequence, not
  something this script probes directly — COMMON.md: never open a serial
  port). This is checked every run via the SAME exported
  mapperArgv()/MAPPER_ARG_WHITELIST the orchestrator itself uses
  (lib/race-day-probe.js), not re-derived — so it holds regardless of
  whether MAP-1 reproduces on a given run.

  MAP-8 (high, mapper repo) / boundaries-3 (medium, GS repo) — mapper gRPC
  :10000 (reflection on) and the grpc-web UI :3000 bind all interfaces,
  unauthenticated, reachable from the hotspot the ground station itself
  creates. This script is the one place in the suite that can observe those
  ports LIVE, because 20-mapper-stage.ps1 never starts the mapper (it only
  stages settings) and this script's own probe stops the mapper again before
  returning control — so port evidence is gathered by POLLING
  `Get-NetTCPConnection` on a background clock WHILE the probe process runs,
  not after it exits. 40-mdns-udp.ps1 covers 5601/5602/5353 (ports it owns
  before the mapper exists).

  boundaries-4 (medium, GS repo) — GRID's convenience launch
  (main/elrsLauncher.js) spawns the mapper with an UN-scrubbed environment,
  reopening the very env bypass race day's own managed launch closes.
  boundaries-5 (low, GS repo) — that scrub (both race day's real one and, if
  written naively, a validation script's own) is case-sensitive while
  Windows environment-variable names are not. Both are documented below as
  code facts (data.gridLaunchEnvScrubGap); see that section and
  .DESCRIPTION further down for why boundaries-4 is not live-exercised, and
  how boundaries-5 is avoided in THIS script's own launch env.

  How the mapper is driven: lib/race-day-probe.js, run under the installed
  exe in Node mode (ELECTRON_RUN_AS_NODE=1 — a plain node.exe cannot resolve
  paths inside app.asar), requires main/raceDayOrchestrator.js,
  main/mapperRunner.js and main/settingsStore.js directly and calls
  raceDay.start() for real against the settings.json 20-mapper-stage.ps1
  staged. See that file's header for the full mechanism and for why the
  hotspot/phone-bridge steps are refused rather than stubbed.

  Launch environment: scrubbed the same way scripts/electron-smoke.js scrubs
  its own child (SCRUB_ENV_EXACT plus a wholesale W17_* delete,
  electron-smoke.js's buildScenarioEnv) before adding back only
  ELECTRON_RUN_AS_NODE=1 — belt-and-suspenders under race day's OWN env scrub
  (main/mapperRunner.js's _childEnv(), which strips W17_* again before the
  mapper itself is spawned): proves a MAP-1 crash here is not an artifact of
  a stray host variable. This is NOT "the CI boot-smoke mechanism" verbatim
  (scripts/smokeMain.js is excluded from the packaged build by
  electron-builder.yml's `files:` allowlist, so it cannot run against the
  installed artifact this suite targets) — it is the same env-scrub and
  process-tree-kill DISCIPLINE that mechanism established
  (winTreeKillArgs, main/runCommand.js:14), applied to the real installed
  main/main.js entry point instead.

  GRID-launch env-scrub gap (brief callout: "GRID LAUNCH spawns with an
  un-scrubbed env"): documented below as a CODE fact
  (data.gridLaunchEnvScrubGap), not live-exercised. main/elrsLauncher.js's
  launchDetached() spawns the REAL control-path binary DETACHED, with stdio
  ignored and NO pid returned, and has no kill/stop/restart function by
  design (its own header: "this app will never stop it") — safe for a human
  operator to clean up by process name/launch time, not safe for an
  unattended VM session to clean up with confidence. Left as a
  human-supervised runbook step.

.PARAMETER InstallDir
  The GS install directory (from 10-install-gs.ps1's resolvedInstallDir).

.PARAMETER UserDataDir
  Where settings.json lives. MUST be the SAME directory 20-mapper-stage.ps1
  was run against (that is where the racePrep this script drives came from).
  Defaults to lib/common.ps1's Get-W17DefaultUserDataDir formula.

.PARAMETER MapperWaitMs
  How long to wait for the spawned mapper to either crash on its own (MAP-1)
  or keep running, before this script stops it itself. Default 8000 — the
  self-dialing client.Init() panic, when it reproduces, happens within a
  handful of localhost gRPC round trips, well under grpc_client.go's own 10s
  context timeout.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $InstallDir,
    [string] $UserDataDir,
    [int] $MapperWaitMs = 8000,
    [string] $ResultsDir
)

. (Join-Path $PSScriptRoot 'lib\common.ps1')

if (-not $UserDataDir) { $UserDataDir = Get-W17DefaultUserDataDir }

$data = [ordered]@{ installDir = $InstallDir; userDataDir = $UserDataDir; mapperWaitMs = $MapperWaitMs }
$findings = New-Object System.Collections.Generic.List[string]
$failures = New-Object System.Collections.Generic.List[string]

$exePath = Join-Path $InstallDir 'W17 Ground Station.exe'
$asarPath = Join-Path $InstallDir 'resources\app.asar'
$probeJs = Join-Path $PSScriptRoot 'lib\race-day-probe.js'
$settingsPath = Join-Path $UserDataDir 'settings.json'

if (-not (Test-Path -LiteralPath $exePath) -or -not (Test-Path -LiteralPath $asarPath)) {
    $r = New-W17Result -Script '50-race-day' -Ok $false -Summary "GS not found under $InstallDir — run 10-install-gs.ps1 first" -Data $data
    Save-W17Result -Result $r -ResultsDir $ResultsDir
    exit (Write-W17Result $r)
}
if (-not (Test-Path -LiteralPath $settingsPath)) {
    $r = New-W17Result -Script '50-race-day' -Ok $false -Summary "no settings.json at $settingsPath — run 20-mapper-stage.ps1 first, against this SAME -UserDataDir" -Data $data
    Save-W17Result -Result $r -ResultsDir $ResultsDir
    exit (Write-W17Result $r)
}

try {
    $settingsRaw = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
} catch {
    $r = New-W17Result -Script '50-race-day' -Ok $false -Summary "settings.json at $settingsPath did not parse: $($_.Exception.Message)" -Data $data
    Save-W17Result -Result $r -ResultsDir $ResultsDir
    exit (Write-W17Result $r)
}

$prepMapperPath = $null
$prepProfilePath = $null
if ($settingsRaw.PSObject.Properties.Name -contains 'racePrep') {
    $prepMapperPath = $settingsRaw.racePrep.mapperPath
    $prepProfilePath = $settingsRaw.racePrep.profilePath
}
$data.stagedMapperPath = $prepMapperPath
$data.stagedProfilePath = $prepProfilePath
if (-not $prepMapperPath -or -not $prepProfilePath) {
    $r = New-W17Result -Script '50-race-day' -Ok $false -Summary 'settings.json has no racePrep.mapperPath/profilePath staged — run 20-mapper-stage.ps1 first, against this SAME -UserDataDir' -Data $data
    Save-W17Result -Result $r -ResultsDir $ResultsDir
    exit (Write-W17Result $r)
}

# --- GRID-launch env-scrub gap: documented as a code fact, not live-exercised
# (see .DESCRIPTION for why). CONFIRMED findings boundaries-4 (the gap itself)
# and boundaries-5 (the scrub is ALSO case-sensitive, which Windows env names
# are not) from w17-ground-station.v2report.json. ---------------------------
$findings.Add('boundaries-4')
$findings.Add('boundaries-5')
$data.gridLaunchEnvScrubGap = [ordered]@{
    claim                  = 'GRID launch (main/elrsLauncher.js launchDetached()) inherits this app''s FULL, unscrubbed process.env; race day''s managed launch (main/mapperRunner.js _childEnv()) strips the entire W17_* class first — and even that strip is CASE-SENSITIVE (boundaries-5) while Windows environment-variable names are not, so a mixed-case w17_headtrack_ingest could survive race day''s own scrub too.'
    evidenceGridLaunch     = 'main/elrsLauncher.js:26-31 — spawn(elrsPath, [], {detached:true, stdio:"ignore", cwd:path.dirname(elrsPath), windowsHide:false}) — no env key at all, so Node child_process defaults to inheriting process.env verbatim, and no argv either (nothing here is even whitelisted, unlike race day). boundaries-4.'
    evidenceRaceDay        = 'main/mapperRunner.js _childEnv() — copies process.env but skips only keys whose name STARTS WITH the literal, uppercase "W17_" (ordinal StartsWith) before spawning — boundaries-5: a "w17_headtrack_ingest" would not match that check and would ride through even race day''s own scrub.'
    onlyKnownAffectedFlag  = 'w17-mapper cmd/elrs-joystick-control/main.go — the -headtrack-ingest flag defaults from env W17_HEADTRACK_INGEST (envTruthy helper) when no CLI flag is given; GRID launch passes NO CLI flags at all, so an ambient W17_HEADTRACK_INGEST on this machine silently changes GRID''s launch in a way race day''s launch never can (LOG-ONLY receiver, CLAUDE.md safety boundary 5 — enabling it changes nothing control-relevant, but the SILENT, ambient-environment nature of the toggle is the gap being flagged).'
    exercisedLive          = $false
    whyNotExercisedLive    = 'launchDetached() spawns the REAL control-path binary DETACHED, stdio ignored, no pid returned, and elrsLauncher.js has no kill/stop/restart function by design ("this app will never stop it") — an unattended VM session cannot reliably identify and clean up the resulting orphan; left as a human-supervised runbook step (see the workspace runbook).'
}

# --- scrubbed launch env for the probe, mirroring scripts/electron-smoke.js's
# SCRUB_ENV_EXACT + wholesale W17_* delete, layered UNDER race day's own scrub.
# Deliberately CASE-INSENSITIVE here (unlike the production scrub above,
# boundaries-5) — this is new code this script owns, so it is written
# correctly rather than reproducing a known gap; it does not paper over
# boundaries-5, which lives in main/mapperRunner.js and is documented above,
# not fixed by anything in this file.
$scrubExact = @('ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'NODE_OPTIONS')
$scrubbedEnv = @{}
foreach ($item in (Get-ChildItem Env:)) {
    if ($item.Name.ToUpperInvariant().StartsWith('W17_')) { continue }
    if ($scrubExact -contains $item.Name) { continue }
    $scrubbedEnv[$item.Name] = $item.Value
}
$scrubbedEnv['ELECTRON_RUN_AS_NODE'] = '1' # the one var this probe itself needs, added back deliberately
$data.launchEnvScrubbed = @('W17_* (wholesale, case-insensitive)') + $scrubExact

# --- launch the probe NON-BLOCKING so ports can be polled while it runs ----
# (a bespoke inline launch rather than lib/common.ps1's Invoke-W17Command,
# same reason 40-mdns-udp.ps1's UDP receive probe is bespoke too: this run
# needs concurrent HOST-SIDE observation while the child is alive, which a
# fire-and-collect helper cannot give — by the time a blocking wait returns,
# the probe's own stop()/dispose() calls have already ended the mapper.)
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $exePath
$psi.ArgumentList.Add($probeJs)
$psi.ArgumentList.Add($asarPath)
$psi.ArgumentList.Add($UserDataDir)
$psi.ArgumentList.Add("$MapperWaitMs")
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.EnvironmentVariables.Clear()
foreach ($k in $scrubbedEnv.Keys) { $psi.EnvironmentVariables[$k] = $scrubbedEnv[$k] }

$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $psi
$stdoutBuf = New-Object System.Text.StringBuilder
$stderrBuf = New-Object System.Text.StringBuilder
$outEvt = Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -Action { if ($null -ne $EventArgs.Data) { $Event.MessageData.AppendLine($EventArgs.Data) | Out-Null } } -MessageData $stdoutBuf
$errEvt = Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived -Action { if ($null -ne $EventArgs.Data) { $Event.MessageData.AppendLine($EventArgs.Data) | Out-Null } } -MessageData $stderrBuf

$hardTimeoutSec = [math]::Ceiling($MapperWaitMs / 1000) + 30
$portSamples = New-Object System.Collections.Generic.List[object]

$proc.Start() | Out-Null
$proc.BeginOutputReadLine()
$proc.BeginErrorReadLine()

# Concurrent host-side port observation (MAP-8 evidence) while the mapper is
# (potentially) alive.
$pollDeadline = (Get-Date).AddMilliseconds($MapperWaitMs + 2000)
while (-not $proc.HasExited -and (Get-Date) -lt $pollDeadline) {
    try {
        $conns = Get-NetTCPConnection -LocalPort 10000, 3000 -State Listen -ErrorAction SilentlyContinue
        if ($conns) {
            $portSamples.Add([pscustomobject]@{
                at        = (Get-Date).ToUniversalTime().ToString('o')
                listeners = @($conns | Select-Object LocalAddress, LocalPort, OwningProcess)
            })
        }
    } catch { }
    Start-Sleep -Milliseconds 500
}

$finished = $proc.WaitForExit($hardTimeoutSec * 1000)
if (-not $finished) {
    try { Start-Process -FilePath 'taskkill' -ArgumentList @('/pid', "$($proc.Id)", '/t', '/f') -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue } catch {}
}
Start-Sleep -Milliseconds 200 # let the async output events flush
Unregister-Event -SourceIdentifier $outEvt.Name -ErrorAction SilentlyContinue
Unregister-Event -SourceIdentifier $errEvt.Name -ErrorAction SilentlyContinue

$data.portListenersObservedWhileRunning = @($portSamples)
if ($portSamples.Count -gt 0) {
    $findings.Add('MAP-8')
    $findings.Add('boundaries-3')
    $data.portObservationNote = 'a LISTENING socket on 10000 and/or 3000 was observed while the probe ran — see portListenersObservedWhileRunning for the LocalAddress reported at each sample (0.0.0.0 confirms the all-interfaces bind boundaries-3/MAP-8 describes; 127.0.0.1 would not).'
} else {
    $data.portObservationNote = 'no LISTENING socket seen on 10000/3000 during the poll window — either the mapper crashed before binding them (consistent with MAP-1) or the poll missed a narrow window; NOT itself proof the ports are unreachable when the mapper does survive long enough to bind them.'
}

$probeOut = $stdoutBuf.ToString()
$probeErr = $stderrBuf.ToString()
$data.probeTimedOut = -not $finished
$data.probeExitCode = if ($finished) { $proc.ExitCode } else { $null }
$data.probeStderrTail = (($probeErr -split "`r`n|`n") | Select-Object -Last 40) -join "`n"

$resultLine = ($probeOut -split "`r`n|`n") | Where-Object { $_ -like 'RACEDAY_PROBE_RESULT:*' } | Select-Object -Last 1
$probe = $null
if ($resultLine) {
    try { $probe = ($resultLine -replace '^RACEDAY_PROBE_RESULT:\s*', '') | ConvertFrom-Json } catch { }
}

if (-not $probe) {
    $failures.Add("race-day-probe.js produced no parseable result (timed out: $(-not $finished); exit code: $($data.probeExitCode)) — see probeStderrTail")
} else {
    $data.probe = $probe

    if ($probe.crashSuspected) {
        $findings.Add('MAP-1')
        $tail = @($probe.mapperLogTail) | Select-Object -Last 5
        $failures.Add("the mapper CRASHED after race day launched it with the staged profile (MAP-1: -config-file-path double-wraps the profile against pkg/config/schema.yaml, SetConfig is rejected, grpc_client.go panics) — exitCode=$($probe.mapperStatusAfterWait.exitCode); log tail: $($tail -join ' | ')")
    } elseif (-not $probe.mapperSurvivedWaitWindow) {
        # Exited, but stoppedByUs / clean — not itself MAP-1, still worth a note.
        $data.mapperExitedCleanNote = 'mapper exited during the wait window but not flagged as a crash (stoppedByUs or exitCode 0) — see probe.mapperStatusAfterWait'
    }

    # MAP-2: a STRUCTURAL fact, checked every run via the orchestrator's own
    # exported constant + pure builder (captured by the probe, not
    # re-derived here) — true regardless of whether MAP-1 reproduced above.
    $whitelistIsExactlyConfigFlag = @($probe.mapperArgWhitelist).Count -eq 1 -and $probe.mapperArgWhitelist[0] -eq '-config-file-path'
    $argvMatchesExpected = $probe.argvCheck.ok -and (@($probe.argvCheck.argv) -join '|') -eq "-config-file-path|$prepProfilePath"
    $data.mapperArgvIsWhitelistOnly = ($whitelistIsExactlyConfigFlag -and $argvMatchesExpected)
    if (-not $data.mapperArgvIsWhitelistOnly) {
        $failures.Add("unexpected: the captured argv/whitelist did not match the expected shape (whitelist=$($probe.mapperArgWhitelist -join ','); argvCheck=$($probe.argvCheck | ConvertTo-Json -Compress)) — re-check this script against raceDayOrchestrator.js, something moved")
    }
    $findings.Add('MAP-2')
    $findings.Add('SYN-2')
    $failures.Add('MAP-2/SYN-2 (structural, every run): MAPPER_ARG_WHITELIST is exactly ["-config-file-path"] (raceDayOrchestrator.js) and no GS code path ever calls the mapper''s StartLink RPC (main/*.js has no JoystickControl gRPC client) — so even a mapper that survives race day''s launch never drives the RF link, and the COM port is never opened by race day either. This will keep failing until the mapper/GS fix wave (owner decision D1 first, per the review) lands the remediation.')

    if ($null -ne $probe.stopResult) {
        $data.stopResult = $probe.stopResult
        if (-not ($probe.finalMapperStatus -and -not $probe.finalMapperStatus.running)) {
            $failures.Add('race day stop()/dispose() did not leave the mapper stopped per its own status() — possible stop-failed / orphan risk')
        }
    }

    # Orphan check: whatever pid the probe reports must be gone from the OS
    # process table by the time we look, independent of what the app itself
    # claims about it.
    if ($probe.mapperPidAtStart) {
        Start-Sleep -Milliseconds 500
        $still = Get-Process -Id $probe.mapperPidAtStart -ErrorAction SilentlyContinue
        $data.mapperOrphanCheck = [ordered]@{ pid = $probe.mapperPidAtStart; stillRunning = [bool]$still }
        if ($still) {
            $failures.Add("mapper pid $($probe.mapperPidAtStart) is STILL RUNNING at the OS level after this script finished — orphan; clean up by hand: taskkill /pid $($probe.mapperPidAtStart) /t /f")
        }
    }
}

$ok = $failures.Count -eq 0
$summary = if ($ok) {
    "race day's mapper step ran clean, no crash, no orphan — UNEXPECTED against MAP-1/MAP-2's CONFIRMED status; re-verify against w17-mapper.v2report.json before trusting this (either the code changed, or this run's evidence is incomplete)"
} else {
    ($failures -join '; ')
}

$result = New-W17Result -Script '50-race-day' -Ok $ok -Summary $summary -Data $data -Findings ($findings | Select-Object -Unique)
Save-W17Result -Result $result -ResultsDir $ResultsDir
exit (Write-W17Result $result)
