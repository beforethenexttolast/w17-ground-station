#Requires -Version 7.0
<#
.SYNOPSIS
  W17 Windows-VM validation, step 60: HID TRANSITION + MAPPER-PROCESS
  CONTINUITY across an operator-driven DualShock 4 unplug/replug. Records what
  WINDOWS sees on the USB/HID bus and whether the already-running mapper
  process survived it, unchanged, throughout. PHYSICAL UNPLUG IS
  HUMAN-IN-THE-LOOP: nothing in this suite can automate a hand pulling a USB
  cable, so this script blocks for an operator action by design (or, with
  -NonInteractive, opens a fixed timed window instead of a keypress — see
  below).

  THIS SCRIPT DOES NOT TEST R15, AND NOTHING IN THIS SUITE DISCHARGES R15.
  (Review finding B5; ruling 2026-09-03b. The file was previously named
  60-r15-pad-unplug.ps1 and called R1–R16 a "bench-gate checklist", which was
  wrong on both counts and could have been read as an unlock gate passing.)
  R1–R16 is the **FIRST_ACTIVE unlock checklist** — CURRENT_STATUS.md
  §2.3.11.6, the head-tracked-gimbal arbiter parked on the `u4-arbiter`
  branch — not a bench-gate list. R15 specifically is defined at
  CURRENT_STATUS.md:1356 as *device loss ⇒ ARBITER DISARM*: "demonstrated by
  physically unplugging, from ARMING/ACTIVE/OVERRIDDEN, reconnect proves no
  restore". Those are arbiter states, in arbiter code that is parked and
  unmerged. CURRENT_STATUS.md:1375 records the standing verdict in as many
  words: **"R15 remains NO-GO"**, and :1418 keeps it on the open list beside
  R13 and R16.
  What THIS script measures is Windows HID presence and mapper-process
  liveness. That is a real, externally observable fact and worth having — it
  is simply not R15 evidence, and a PASS here moves no gate. R15 stays NO-GO
  after a green run of this script, exactly as before it.

.DESCRIPTION
  SAFETY PRECONDITION — READ BEFORE RUNNING (review finding W1). This step is
  the ONLY one in the suite that involves a mapper the operator started BY
  HAND, and a hand-started mapper that is actually driving was started with
  `-tx-serial-port-name`, which means the COM port IS open and CRSF IS being
  transmitted. That is outside the suite's "no script here opens a serial
  port" claim: the claim remains true of every script (this one included —
  it only reads the OS process table and the HID bus), and it was never a
  claim about the operator's own mapper.
  Therefore, before running this step:
    - the CAR MUST BE UNPOWERED, or its RX UNBOUND;
    - treat it as a bench procedure under FIRST_ACTIVE, which is NO-GO;
    - it discharges nothing and unlocks nothing.
  Why this matters concretely: CURRENT_STATUS.md:1373-1376 records that on
  gamepad loss the mapper "still transmits at full rate … fail-to-neutral,
  not fail-silent, so the firmware's radio-loss failsafe still does not fire"
  — and switch channels latch downstream (RESIDUAL A). Pulling the pad on a
  live transmitter with a powered car is exactly the situation that residual
  describes.

  This does NOT launch the mapper itself (unlike 50-race-day.ps1's crash
  test): a meaningful transition test needs a mapper that is actually running
  and driving, which today's -config-file-path path cannot reliably provide
  (MAP-1 — see 50-race-day.ps1). Point -MapperExe at whatever mapper build the
  operator started by hand for the bench (configs/README.md's documented direct
  invocation, or a build with MAP-1 already fixed); this script only
  DETECTS and TRACKS that already-running process by image name, exactly
  like main/elrsLauncher.js's own detectRunning() does (tasklist by image
  name — shared/processList.js:imageNameFromPath) — it never spawns or
  stops anything mapper-side.

  What this proves, and what it cannot (read before trusting a "PASS"):
  it reports what WINDOWS sees on the USB/HID bus (Get-W17Ds4Devices,
  lib/common.ps1) across an operator-driven unplug then replug, plus whether
  the mapper PROCESS stayed the same pid throughout (i.e. it did not crash
  or get restarted by the unplug — a real, externally observable fact).

  It does NOT and cannot prove whether CONTROL resumes after the replug.
  CONFIRMED finding MAP-6 (w17-mapper.v2report.json; w17-mapper/pkg/devices/
  controller.go:43) says it should NOT: the mapper's SDL gamepad registry is
  built exactly once at process boot (EnumerateDevices(), controller.go:43)
  and the poll loop discards every add/remove event body without ever
  reopening the joystick (controller.go:139-149 — "fmt.Println('(devices):
  exiting polling loop')" is the ONLY log line anywhere near this path; there
  is no add/remove log line to grep for today, which is itself confirming
  evidence for MAP-6, not a gap in this script). Closing that gap would need
  a read-only query into the mapper's OWN gamepad registry (its gRPC
  getGamepads RPC) — deliberately NOT built here: it would mean vendoring
  the mapper's GPL-licensed .proto into this MIT-licensed script tree for a
  check this suite does not strictly need, when the OS-level evidence below
  plus the code citation above already establish the claim. If -MapperLogPath
  is given, its tail is captured across the window as a hook for when
  logging IS added — expected to show nothing related to the pad transition
  today, per controller.go:139-149.

.PARAMETER MapperExe
  Path to (or just the filename of) the mapper binary the operator already
  started by hand — used only to derive the Windows process name to track
  (Get-Process strips the .exe extension shared/processList.js's
  imageNameFromPath convention keeps).

.PARAMETER MapperLogPath
  Optional path to a log file the operator redirected the mapper's own
  console output into when starting it (the mapper prints nothing
  distinctive on its own — see .DESCRIPTION). If given, its tail is
  captured before and after the unplug/replug window.

.PARAMETER NonInteractive
  Skip the Read-Host prompts (which need a live, interactive SSH session —
  `ssh -t w17vm pwsh -File ...`, not a one-shot `ssh w17vm 'pwsh -File ...'`)
  and instead print the instruction to stdout and open a fixed
  -ActionWindowSec window for the operator to act, polling for the
  transition throughout. Either way this script needs a human physically at
  the machine to move the cable — that part is never automatable.

.PARAMETER ActionWindowSec
  With -NonInteractive, how long to wait for each requested physical action
  before giving up on that transition (default 25s).

.PARAMETER PollMs
  HID-poll interval while waiting for a transition (default 500ms).
#>
[CmdletBinding()]
param(
    [string] $MapperExe = 'elrs-joystick-control.exe',
    [string] $MapperLogPath,
    [switch] $NonInteractive,
    [int] $ActionWindowSec = 25,
    [int] $PollMs = 500,
    [string] $ResultsDir
)

. (Join-Path $PSScriptRoot 'lib\common.ps1')

function Get-W17MapperProcessName {
    param([string] $Exe)
    $base = Split-Path -Leaf $Exe
    if ($base -match '\.exe$') { $base = $base.Substring(0, $base.Length - 4) }
    return $base
}

function Wait-W17Ds4Transition {
    # Polls Get-W17Ds4Devices until presence matches -Present, or the window
    # elapses. Returns @{ reached; at (ISO8601 UTC or $null); elapsedMs }.
    param([bool] $Present, [int] $TimeoutSec, [int] $PollMs)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $started = Get-Date
    while ((Get-Date) -lt $deadline) {
        $now = (Get-W17Ds4Devices).devices.Count -gt 0
        if ($now -eq $Present) {
            return @{ reached = $true; at = (Get-Date).ToUniversalTime().ToString('o'); elapsedMs = [int](((Get-Date) - $started).TotalMilliseconds) }
        }
        Start-Sleep -Milliseconds $PollMs
    }
    return @{ reached = $false; at = $null; elapsedMs = [int](((Get-Date) - $started).TotalMilliseconds) }
}

function Get-W17LogTail {
    param([string] $Path, [int] $Lines = 40)
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $null }
    try { return @(Get-Content -LiteralPath $Path -Tail $Lines -ErrorAction Stop) } catch { return $null }
}

# r15Status is set HERE, not near the end, so it rides in EVERY result this
# script can emit — including the early-exit FAILs. The whole point of B5 is
# that a reader must never take a line from this script as an R15 verdict, and
# the early exits are the results most likely to be skimmed.
$data = [ordered]@{
    r15Status       = 'R15 is NOT tested here and is NOT discharged by anything in this suite. It is a FIRST_ACTIVE unlock-checklist item (CURRENT_STATUS.md §2.3.11.6, defined at :1356 as device loss => ARBITER disarm from ARMING/ACTIVE/OVERRIDDEN with reconnect proving no restore), against arbiter code parked on the u4-arbiter branch. CURRENT_STATUS.md:1375: "R15 remains NO-GO". It remains NO-GO after a green run of this script.'
    safetyPrecondition = 'Run only with the CAR UNPOWERED or its RX UNBOUND. This step tracks a mapper the OPERATOR started by hand; a mapper that is actually driving was started with -tx-serial-port-name, so the COM port is open and CRSF is transmitting. That is outside this suite''s "no script opens a serial port" claim (still true of every script, this one included), and CURRENT_STATUS.md:1373-1376 records that on gamepad loss the mapper keeps transmitting at full rate — fail-to-neutral, not fail-silent — so the firmware radio-loss failsafe does not fire (RESIDUAL A).'
    mapperExe       = $MapperExe
    mapperProcessName = (Get-W17MapperProcessName -Exe $MapperExe)
    nonInteractive  = [bool]$NonInteractive
    actionWindowSec = $ActionWindowSec
    mapperLogPath   = $MapperLogPath
}
$findings = New-Object System.Collections.Generic.List[string]
$failures = New-Object System.Collections.Generic.List[string]

# --- prerequisites: a running mapper (exactly one), a connected pad --------
$procName = $data.mapperProcessName
$procs = @(Get-Process -Name $procName -ErrorAction SilentlyContinue)
$data.mapperProcessesFound = @($procs | Select-Object Id, StartTime, Path)

if ($procs.Count -eq 0) {
    $r = New-W17Result -Script '60-hid-transition' -Ok $false -Summary "no running '$procName' process found — start the mapper by hand first (configs/README.md), then re-run. This script never launches the mapper itself." -Data $data
    Save-W17Result -Result $r -ResultsDir $ResultsDir
    exit (Write-W17Result $r)
}
if ($procs.Count -gt 1) {
    $r = New-W17Result -Script '60-hid-transition' -Ok $false -Summary "$($procs.Count) '$procName' processes are running — ambiguous which one to track (a stray instance from an earlier 50-race-day.ps1 crash test, or a manual bench run left over). Close the extras so exactly one remains, then re-run." -Data $data
    Save-W17Result -Result $r -ResultsDir $ResultsDir
    exit (Write-W17Result $r)
}
$mapperPid = $procs[0].Id
$mapperStartTime = $procs[0].StartTime
$data.mapperPid = $mapperPid
$data.mapperStartTimeAtBegin = $mapperStartTime

$baseline = Get-W17Ds4Devices
$data.baselineDevices = $baseline.devices
if ($baseline.error) { $data.baselineError = $baseline.error }
if (-not $baseline.devices -or $baseline.devices.Count -eq 0) {
    $r = New-W17Result -Script '60-hid-transition' -Ok $false -Summary 'no DualShock 4 detected at baseline — connect the pad first, then re-run' -Data $data
    Save-W17Result -Result $r -ResultsDir $ResultsDir
    exit (Write-W17Result $r)
}

$data.mapperLogTailBefore = Get-W17LogTail -Path $MapperLogPath

# --- unplug -----------------------------------------------------------------
if ($NonInteractive) {
    Write-Host "[60-r15] ACTION NEEDED: physically UNPLUG the DualShock 4 now. Waiting up to ${ActionWindowSec}s..."
} else {
    Read-Host "Physically UNPLUG the DualShock 4 now, then press Enter" | Out-Null
}
$unplug = Wait-W17Ds4Transition -Present $false -TimeoutSec $ActionWindowSec -PollMs $PollMs
$data.unplugTransition = $unplug
if (-not $unplug.reached) {
    $failures.Add("Windows never reported the DualShock 4 as absent within ${ActionWindowSec}s of the unplug prompt — either the cable was not pulled, or the OS is slow to notice (unusual for a USB HID removal)")
}

# Mapper still the same process throughout the unplug (real OS-level check,
# not app-self-reported).
$stillDuring = Get-Process -Id $mapperPid -ErrorAction SilentlyContinue
$data.mapperAliveAfterUnplug = [bool]$stillDuring
if (-not $stillDuring) {
    $failures.Add("the mapper process (pid $mapperPid) is GONE after the unplug — it crashed or was closed; R15 needs it to survive a controller disconnect")
}

# --- replug ------------------------------------------------------------------
if ($unplug.reached) {
    if ($NonInteractive) {
        Write-Host "[60-r15] ACTION NEEDED: physically RE-PLUG the DualShock 4 now. Waiting up to ${ActionWindowSec}s..."
    } else {
        Read-Host "Now physically RE-PLUG the DualShock 4, then press Enter" | Out-Null
    }
    $replug = Wait-W17Ds4Transition -Present $true -TimeoutSec $ActionWindowSec -PollMs $PollMs
    $data.replugTransition = $replug
    if (-not $replug.reached) {
        $failures.Add("Windows never reported the DualShock 4 as present again within ${ActionWindowSec}s of the replug prompt")
    }
} else {
    $data.replugTransition = $null
    $data.replugSkippedReason = 'skipped: the unplug transition itself was never observed'
}

# --- final state ---------------------------------------------------------
$final = Get-Process -Id $mapperPid -ErrorAction SilentlyContinue
$data.mapperAliveAtEnd = [bool]$final
$data.mapperStartTimeAtEnd = if ($final) { $final.StartTime } else { $null }
$data.mapperSamePidThroughout = [bool]($final -and $final.StartTime -eq $mapperStartTime)
if ($final -and $final.StartTime -ne $mapperStartTime) {
    $failures.Add("a process with pid $mapperPid exists at the end but its StartTime changed — the mapper was restarted (by something) during this test, not merely left running")
}

$data.mapperLogTailAfter = Get-W17LogTail -Path $MapperLogPath

# --- MAP-6 evidence framing (see .DESCRIPTION for the full citation) -------
$findings.Add('MAP-6')
$data.map6Note = 'this script proves the Windows-visible HID transition and mapper-process continuity only. It cannot and does not claim whether CONTROL resumes after the replug — w17-mapper/pkg/devices/controller.go:43 (EnumerateDevices() runs once at boot; the poll loop at :139-149 discards every add/remove event) predicts it will not, until the mapper process itself is restarted. Pair this script''s result with a manual "does the car respond again" bench observation to close the loop; that observation is out of scope here by design (no control-path probe is built, and none should be — CLAUDE.md: never open a serial port).'

$ok = $failures.Count -eq 0
$replugMs = if ($null -ne $data.replugTransition) { $data.replugTransition.elapsedMs } else { 'n/a' }
$summary = if ($ok) {
    "WINDOWS-LEVEL ONLY: HID transitions observed (unplug at $($unplug.elapsedMs)ms, replug at ${replugMs}ms) and the mapper process (pid $mapperPid) stayed alive with an unchanged StartTime throughout. This says nothing about whether CONTROL resumes (MAP-6 predicts it does not), and it is NOT R15 evidence — R15 is a FIRST_ACTIVE unlock item (CURRENT_STATUS.md:1356) and REMAINS NO-GO (:1375). This PASS moves no gate."
} else {
    ($failures -join '; ')
}

$result = New-W17Result -Script '60-hid-transition' -Ok $ok -Summary $summary -Data $data -Findings @($findings | Select-Object -Unique)
Save-W17Result -Result $result -ResultsDir $ResultsDir
exit (Write-W17Result $result)
