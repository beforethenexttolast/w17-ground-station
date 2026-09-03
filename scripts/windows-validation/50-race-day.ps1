#Requires -Version 7.0
<#
.SYNOPSIS
  W17 Windows-VM validation, step 50: exercise race day's mapper step end to
  end against the REAL installed build, to gather runtime evidence for
  CONFIRMED v2-review blockers/findings spanning BOTH repos' reports
  (w17-mapper.v2report.json's MAP-1/MAP-2/MAP-8, and
  w17-ground-station.v2report.json's own SYN-2/boundaries-3/boundaries-4/
  boundaries-5 — several of these are the SAME underlying defect confirmed
  independently from each repo's own review pass).

  HOW TO READ THIS STEP'S PASS/FAIL (review finding N3). The structural
  findings below reproduce on EVERY run until the fix wave lands, so they no
  longer set the exit code: they are recorded in data.expectedFindingsReproduced
  and in the result's `findings` list, and the step still reports ok. Only an
  UNEXPECTED result — a mapper crash, an argv/whitelist shape that no longer
  matches the orchestrator's own exported constant, a stop() that leaves the
  mapper running, an orphaned pid, a probe that refuses — turns this step red.
  Before this change every run was red, which made the "ran clean" branch dead
  code and, worse, made a genuine new regression indistinguishable from the
  finding the suite already knows about.

.DESCRIPTION
  MAP-1 (blocker, mapper repo) — `-config-file-path` double-wraps the
  committed profile: grpc_client.go:57-62 puts the WHOLE staged file into
  SetConfigReq.Config; server_grpc.go:103-104 re-marshals that into
  {"config": <file>}; configs/w17-ds4.json already carries that wrapper;
  pkg/config/schema.yaml then rejects the doubled document; grpc_client.go:64
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
  creates.

  WHAT THAT EXPOSURE MEANS WHILE THIS SCRIPT RUNS (stated plainly rather than
  left implicit, per the B4 review's safety note): for the seconds the mapper
  is alive here, an unauthenticated gRPC server is listening on all
  interfaces, and StartLink — the ONE RPC that opens the COM port and starts
  transmitting CRSF (pkg/serial/port.go Open() is reachable only from
  pkg/server/server_grpc.go's StartLink handler) — is among the RPCs it
  exposes, with reflection on. NOTHING in this suite calls it, and nothing in
  the ground station has a client that could: main/HeadIntentDiagnosticsClient
  .js is this app's only gRPC client and speaks a different, one-way, W3
  diagnostics-only channel. So the suite's "no serial port is ever opened"
  claim holds by construction. But the window is real, it is what MAP-8
  describes, and it is a reason to run this step on a NAT'd VM with the car
  unpowered and the RX unbound — not on a shared network with a live car. This script is the one place in the suite that can observe those
  ports LIVE, because 20-mapper-stage.ps1 never starts the mapper (it only
  stages settings) and this script's own probe stops the mapper again before
  returning control — so port evidence is gathered by POLLING
  `Get-NetTCPConnection` on a background clock WHILE the probe process runs,
  not after it exits. 40-mdns-udp.ps1 covers 5601/5602/5353 (ports it owns
  before the mapper exists).

  boundaries-4 / boundaries-5 — BOTH FIXED ON MAIN by the GS fix wave, and
  this script no longer claims otherwise (it previously described them as
  live gaps). Verified at HEAD: main/elrsLauncher.js:55 now spawns with
  `env: scrubW17Env(this._env)` — the GRID convenience launch is scrubbed,
  closing boundaries-4 — and the scrub itself moved into
  shared/childEnv.js:32-35, where it matches the prefix case-INSENSITIVELY
  (`String(k).toUpperCase().startsWith(...)`), closing boundaries-5. Race
  day's managed launch uses the same shared helper
  (main/mapperRunner.js:68-70 `_childEnv() { return scrubW17Env(this._env) }`),
  so there is now ONE scrub at BOTH spawn sites. What remains recorded below
  (data.gridLaunchEnvScrubGap) is the CLOSED state plus the one residual the
  review left open.

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

  GRID-launch env scrub: still not live-exercised here, and now for a
  different reason. The GAP is closed (see above), so there is nothing left
  to reproduce; but the launch itself is still the one thing an unattended
  session must not start. main/elrsLauncher.js's launchDetached() spawns the
  REAL control-path binary DETACHED, with stdio ignored and NO pid returned,
  and has no kill/stop/restart function by design (its own header: "this app
  will never stop it") — safe for a human operator to clean up by process
  name/launch time, not safe for an unattended VM session. It stays a
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
# N3: findings this suite EXPECTS to reproduce until the fix wave lands. They
# are recorded and printed, but they do NOT set ok=$false — otherwise a real
# regression looks exactly like the known one.
$expected = New-Object System.Collections.Generic.List[string]

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

# --- GRID-launch env scrub: CLOSED on main, recorded here as closed. -------
# boundaries-4 (the GRID launch inherited an unscrubbed env) was CONFIRMED in
# w17-ground-station.v2report.json; boundaries-5 (the scrub was case-sensitive
# while Windows env names are not) was UNVERIFIED-LOW there, NOT confirmed —
# review finding N4. Both are now fixed at HEAD by one shared helper
# (shared/childEnv.js) used at BOTH spawn sites. The ids stay tagged so the
# finding-to-evidence trail survives, with the state recorded, not asserted.
#
# ONE RESIDUAL SURVIVES THE FIX, and this VM is where it could be settled: the
# JS side is now case-insensitive, but whether the MAPPER's Go-side
# os.LookupEnv is case-insensitive on Windows
# (w17-mapper/cmd/elrs-joystick-control/main.go:30-36) was always reasoned
# from the platform, never observed — that was boundaries-5's own stated
# residual. It no longer changes the GS's behaviour (nothing W17_-ish reaches
# the child by either door now), so it is a curiosity rather than a risk; on
# the guest, `setx w17_headtrack_ingest 1` + a new shell + a re-run would
# answer it. A supervised experiment, not something this script does on its
# own — it would leave a persistent user env var behind. [win-TBD]; written
# up in the workspace runbook §5.1.
$findings.Add('boundaries-4')
$findings.Add('boundaries-5')
$data.gridLaunchEnvScrubGap = [ordered]@{
    claim                  = 'CLOSED at HEAD. Both spawn sites now scrub the whole W17_* class through ONE shared, case-INSENSITIVE helper, so neither the GRID convenience launch (boundaries-4) nor a mixed-case spelling (boundaries-5) can carry a W17_* variable into the mapper any more.'
    boundaries4Status      = 'was CONFIRMED (w17-ground-station.v2report.json); FIXED on main — main/elrsLauncher.js:55 now passes `env: scrubW17Env(this._env)` to the detached spawn.'
    boundaries5Status      = 'was UNVERIFIED-LOW (w17-ground-station.v2report.json), NOT confirmed; the JS half is FIXED on main — shared/childEnv.js:35 matches with `String(k).toUpperCase().startsWith(...)`. RESIDUAL, unchanged and now harmless: whether the mapper''s Go-side os.LookupEnv is case-insensitive on Windows (w17-mapper/cmd/elrs-joystick-control/main.go:30-36) was reasoned from the platform, never observed. `setx w17_headtrack_ingest 1` on the guest + a re-run would settle it. [win-TBD]'
    evidenceGridLaunch     = 'main/elrsLauncher.js:43-56 — spawn(elrsPath, [], {detached:true, stdio:"ignore", cwd:path.dirname(elrsPath), env: scrubW17Env(this._env), windowsHide:false}). Still no argv (nothing is whitelisted here, unlike race day) and still detached with no pid returned — but the environment is no longer inherited verbatim.'
    evidenceRaceDay        = 'main/mapperRunner.js:68-70 — `_childEnv() { return scrubW17Env(this._env) }`, the SAME helper elrsLauncher uses; shared/childEnv.js:32-35 does the case-insensitive prefix match.'
    onlyKnownAffectedFlag  = 'w17-mapper cmd/elrs-joystick-control/main.go — the -headtrack-ingest flag defaults from env W17_HEADTRACK_INGEST (envTruthy helper) when no CLI flag is given, and the GRID launch passes NO CLI flags at all. Before the fix an ambient W17_HEADTRACK_INGEST silently changed GRID''s launch; with the scrub at both sites it no longer can. (Even then it changed nothing control-relevant — W3 is LOG-ONLY, workspace CLAUDE.md safety boundary 5 — the SILENT, ambient nature of the toggle was the point.)'
    exercisedLive          = $false
    whyNotExercisedLive    = 'nothing left to reproduce (the gap is closed), and starting it anyway is unsafe for an unattended session: launchDetached() spawns the REAL control-path binary DETACHED, stdio ignored, no pid returned, and elrsLauncher.js has no kill/stop/restart function by design ("this app will never stop it"). Left as a human-supervised runbook step.'
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

$hardTimeoutSec = [math]::Ceiling($MapperWaitMs / 1000) + 30
# NOTE on List[object] and @(): this is a List[object], and `@($portSamples)`
# THROWS "Argument types do not match" on pwsh 7.7.0-preview.4 (measured; the
# same expression is fine for List[string] and List[int], and .ToArray(),
# foreach, the pipeline and an [object[]] cast all work on the very same
# List[object] — so it is a regression in the array-subexpression operator in
# that preview build, not a defect in this logic). Whether it reproduces on
# the 7.4/7.5 a guest gets from `winget install Microsoft.PowerShell` is
# [win-TBD]. .ToArray() is used below instead: it is version-independent,
# costs nothing, and keeps the suite off a construct that has proven
# version-sensitive in at least one shipping PowerShell 7.
$portSamples = New-Object System.Collections.Generic.List[object]

$proc.Start() | Out-Null
# B7 — .NET's own async readers, started immediately after Start() and BEFORE
# any blocking wait, exactly as in lib/common.ps1's Invoke-W17Command. This
# file used to do its own Register-ObjectEvent -Action + BeginOutputReadLine
# capture, which measurably captures NOTHING while the pipeline thread is
# blocked (the -Action blocks are dispatched by the PowerShell event queue,
# which cannot pump then): with a child printing two lines it returned 0
# characters, and with a post-exit flush sleep it returned both lines in the
# WRONG ORDER. The 200 ms "let the async output events flush" sleep below was
# reaching for that second, still-broken behaviour and is gone. An empty
# stdout here would have meant no RACEDAY_PROBE_RESULT line and therefore a
# wrong FAIL on every single run of this step, whatever the mapper actually
# did. Reading concurrently also removes the pipe-buffer deadlock risk, which
# matters more here than anywhere else in the suite: this child prints the
# mapper's own log tail.
$outTask = $proc.StandardOutput.ReadToEndAsync()
$errTask = $proc.StandardError.ReadToEndAsync()

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
    try { if (-not $proc.HasExited) { $proc.Kill($true) } } catch {}
}

$data.portListenersObservedWhileRunning = $portSamples.ToArray()
if ($portSamples.Count -gt 0) {
    $findings.Add('MAP-8')
    $findings.Add('boundaries-3')
    $data.portObservationNote = 'a LISTENING socket on 10000 and/or 3000 was observed while the probe ran — see portListenersObservedWhileRunning for the LocalAddress reported at each sample (0.0.0.0 confirms the all-interfaces bind boundaries-3/MAP-8 describes; 127.0.0.1 would not).'
} else {
    $data.portObservationNote = 'no LISTENING socket seen on 10000/3000 during the poll window — either the mapper crashed before binding them (consistent with MAP-1) or the poll missed a narrow window; NOT itself proof the ports are unreachable when the mapper does survive long enough to bind them.'
}

# Bounded waits, then whatever the child managed to write: an incomplete task
# yields '' rather than blocking on .Result forever.
$probeOut = if ($outTask.Wait(5000)) { $outTask.Result } else { '' }
$probeErr = if ($errTask.Wait(5000)) { $errTask.Result } else { '' }
$data.probeTimedOut = -not $finished
$data.probeExitCode = if ($finished) { $proc.ExitCode } else { $null }
$data.probeStderrTail = (($probeErr -split "`r`n|`n") | Select-Object -Last 40) -join "`n"

$resultLine = ($probeOut -split "`r`n|`n") | Where-Object { $_ -like 'RACEDAY_PROBE_RESULT:*' } | Select-Object -Last 1
$probe = $null
if ($resultLine) {
    try { $probe = ($resultLine -replace '^RACEDAY_PROBE_RESULT:\s*', '') | ConvertFrom-Json } catch { }
}

# B2 — the guard is `-not $probe -OR -not $probe.ok`, and every dereference
# below goes through Get-W17Prop. lib/race-day-probe.js's refusal path emits a
# PARSEABLE `RACEDAY_PROBE_RESULT: {"ok":false,"kind":…,"error":…}` line with
# no `crashSuspected` key, so `if (-not $probe)` was FALSE for it and the very
# next line dereferenced a property that does not exist — which throws under
# `Set-StrictMode -Version Latest` (measured). The result was a raw PowerShell
# stack trace with no W17VAL_RESULT envelope and no Save-W17Result, and
# run-all reporting "no result JSON written" instead of the reason. This fired
# on the MOST LIKELY outcomes: not-staged, module-load-failed, and both
# out-of-scope guards.
$data.probe = $probe
if (-not $probe -or -not (Get-W17Prop $probe 'ok' $false)) {
    $failures.Add("race-day-probe.js did not return a usable result: $(Get-W17ProbeReason $probe) (timed out: $(-not $finished); exit code: $($data.probeExitCode)) — see probeStderrTail")
} else {

    if (Get-W17Prop $probe 'crashSuspected' $false) {
        $findings.Add('MAP-1')
        $tail = @(Get-W17Prop $probe 'mapperLogTail' @()) | Select-Object -Last 5
        $exitCode = Get-W17Prop (Get-W17Prop $probe 'mapperStatusAfterWait') 'exitCode' '(not reported)'
        $failures.Add("the mapper CRASHED after race day launched it with the staged profile (MAP-1: -config-file-path double-wraps the profile against pkg/config/schema.yaml, SetConfig is rejected, grpc_client.go panics) — exitCode=$exitCode; log tail: $($tail -join ' | ')")
    } elseif (-not (Get-W17Prop $probe 'mapperSurvivedWaitWindow' $false)) {
        # Exited, but stoppedByUs / clean — not itself MAP-1, still worth a note.
        $data.mapperExitedCleanNote = 'mapper exited during the wait window but not flagged as a crash (stoppedByUs or exitCode 0) — see probe.mapperStatusAfterWait'
    }

    # MAP-2: a STRUCTURAL fact, checked every run via the orchestrator's own
    # exported constant + pure builder (captured by the probe, not
    # re-derived here) — true regardless of whether MAP-1 reproduced above.
    $whitelist = @(Get-W17Prop $probe 'mapperArgWhitelist' @())
    $argvCheck = Get-W17Prop $probe 'argvCheck'
    $whitelistIsExactlyConfigFlag = $whitelist.Count -eq 1 -and $whitelist[0] -eq '-config-file-path'
    $argvMatchesExpected = (Get-W17Prop $argvCheck 'ok' $false) -and ((@(Get-W17Prop $argvCheck 'argv' @()) -join '|') -eq "-config-file-path|$prepProfilePath")
    $data.mapperArgvIsWhitelistOnly = ($whitelistIsExactlyConfigFlag -and $argvMatchesExpected)
    if (-not $data.mapperArgvIsWhitelistOnly) {
        $failures.Add("unexpected: the captured argv/whitelist did not match the expected shape (whitelist=$($whitelist -join ','); argvCheck=$(if ($argvCheck) { $argvCheck | ConvertTo-Json -Compress -Depth 6 } else { '(absent)' })) — re-check this script against raceDayOrchestrator.js, something moved")
    }
    # N3 — MAP-2/SYN-2 is a STRUCTURAL fact that reproduces on EVERY run until
    # the fix wave lands. It used to go into $failures unconditionally, which
    # made three things wrong at once: this script could never report ok, the
    # "ran clean" summary below was dead code, and — worst — a genuine NEW
    # regression was indistinguishable from the expected structural finding,
    # because both showed up as the same red [FAIL] line. It now goes into a
    # separate expectedFindings channel that does NOT set the exit code, so a
    # red line from this step again means "something is wrong that we did not
    # already know about".
    $findings.Add('MAP-2')
    $findings.Add('SYN-2')
    $expected.Add('MAP-2/SYN-2 (structural, reproduces every run until the fix wave lands): MAPPER_ARG_WHITELIST is exactly ["-config-file-path"] (raceDayOrchestrator.js:44) and no GS code path ever calls the mapper''s StartLink RPC (main/*.js has no JoystickControl gRPC client) — so even a mapper that survives race day''s launch never drives the RF link, and the COM port is never opened by race day either. Owner decision D1 first, per the review.')

    $stopResult = Get-W17Prop $probe 'stopResult'
    if ($null -ne $stopResult) {
        $data.stopResult = $stopResult
        $finalStatus = Get-W17Prop $probe 'finalMapperStatus'
        if (-not ($finalStatus -and -not (Get-W17Prop $finalStatus 'running' $false))) {
            $failures.Add('race day stop()/dispose() did not leave the mapper stopped per its own status() — possible stop-failed / orphan risk')
        }
    }

    # Orphan check: whatever pid the probe reports must be gone from the OS
    # process table by the time we look, independent of what the app itself
    # claims about it.
    $mapperPid = Get-W17Prop $probe 'mapperPidAtStart'
    if ($mapperPid) {
        Start-Sleep -Milliseconds 500
        $still = Get-Process -Id $mapperPid -ErrorAction SilentlyContinue
        $data.mapperOrphanCheck = [ordered]@{ pid = $mapperPid; stillRunning = [bool]$still }
        if ($still) {
            $failures.Add("mapper pid $mapperPid is STILL RUNNING at the OS level after this script finished — orphan; clean up by hand: taskkill /pid $mapperPid /t /f")
        }
    }
}

$data.expectedFindingsReproduced = @($expected)
$ok = $failures.Count -eq 0
$summary = if ($ok) {
    if ($expected.Count -gt 0) {
        "no UNEXPECTED failure: the only findings reproduced are the ones this suite already knows about ($($expected.Count)) — see data.expectedFindingsReproduced. A red line from this step means something NEW."
    } else {
        "race day's mapper step ran clean, no crash, no orphan, and not even the expected structural findings reproduced — UNEXPECTED against MAP-1/MAP-2's CONFIRMED status; re-verify against w17-mapper.v2report.json before trusting this (either the code changed, or this run's evidence is incomplete)"
    }
} else {
    ($failures -join '; ')
}

$result = New-W17Result -Script '50-race-day' -Ok $ok -Summary $summary -Data $data -Findings @($findings | Select-Object -Unique)
Save-W17Result -Result $result -ResultsDir $ResultsDir
exit (Write-W17Result $result)
