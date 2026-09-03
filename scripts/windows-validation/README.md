# Windows-VM validation scripts

PowerShell scripts that exercise the **installed** ground-station build (and,
where relevant, the mapper it drives) against a real Windows guest. Owner
decision A4: a VMware Fusion VM on the owner's Apple Silicon Mac, with the
three real USB devices (AP-capable 5 GHz Wi-Fi adapter, ELRS TX serial,
DualShock 4) passed through — Claude drives the checks autonomously from the
Mac over SSH; a real Windows PC is the final proof only at handover. The full
one-time VM setup and the autonomous-drive design live in the workspace
runbook: `w17-windows-vm-validation-runbook.md` (workspace root, not this
repo — see `WORKSPACE_MAP.md`).

> **Requires PowerShell 7 on the guest.** Every script here carries
> `#Requires -Version 7.0` and means it: they use
> `System.Diagnostics.ProcessStartInfo.ArgumentList`, which exists only on
> .NET Core 2.1+ / .NET 5+, not on the .NET Framework that Windows PowerShell
> 5.1 runs on. **Windows 11 does not ship PowerShell 7.** Install it first:
> `winget install --id Microsoft.PowerShell --source winget`, then open a new
> shell. `run-all.ps1` refuses to fall back to `powershell.exe` and says so in
> one message, rather than letting each script fail separately.

> **One prerequisite is not yet on hand.** Steps `30` and `40`'s hotspot path
> need an **AP-capable 5 GHz USB Wi-Fi adapter**, which `CURRENT_STATUS.md`
> still lists under *"Owner residue: shopping only"*; the adapter
> `HARDWARE_INVENTORY.md:183` records as present is an **RT5370**, which is
> 2.4 GHz and whose AP mode is unverified. Until that adapter exists **and**
> has an ARM64 driver for the guest, `30` can only report its clean
> no-backend FAIL, `40`'s hotspot-interface path cannot be exercised, and
> `00` will honestly report `likely5GHzCapable = false`. That is a purchase
> gating a program step, not a defect in these scripts.

Nothing here flashes, uploads, or powers hardware, and nothing opens a serial
port for control (workspace `CLAUDE.md` safety rules) — the COM-port and
HID inventory below is read-only enumeration, never a port open. **One
caveat, stated rather than buried:** step `60` tracks a mapper the *operator*
started by hand, and a mapper that is actually driving was started with
`-tx-serial-port-name`, so its COM port is open and it is transmitting CRSF.
That is outside this suite's claim (which is about the scripts, and remains
true of all of them). Run `60` only with the **car unpowered or its RX
unbound** — see that script's own safety precondition.

## What each script does

| script | needs | what it proves |
|---|---|---|
| `00-inventory.ps1` | nothing | host survey: OS/arch, VMware Tools, Wi-Fi adapter + 5 GHz capability, COM ports, DualShock4 HID, installed W17 apps, firewall profiles. Informational — no pass/fail gate. |
| `10-install-gs.ps1` | `-InstallerPath` | silent-installs the NSIS build; FAILS LOUDLY if `mediamtx.exe` is missing (CONFIRMED finding `boundaries-1`: CI never runs `fetch-mediamtx.js` before packaging) and reports whether `proto/` is packaged. |
| `20-mapper-stage.ps1` | `-MapperExe -Profile` | stages the mapper + profile exactly where race day's real path resolution expects them; FAILS if the profile still carries `REPLACE-WITH-` placeholders (`MAP-5`). |
| `30-hotspot.ps1` | `-InstallDir -Password` | drives the app's own `main/hotspot.js` / `hotspotVerify.js` through start → verify → teardown. Clean FAIL (not a crash) when no hotspot backend/adapter exists. |
| `40-mdns-udp.ps1` | `-InstallDir` | firewall state for UDP 5601/5602/5353, a real mDNS query via the app's own codec, and a UDP 5601 receive probe using the app's own replay telemetry + iPhone-bridge env. |
| `50-race-day.ps1` | `-InstallDir` (+ a completed `20` stage) | drives race day's REAL mapper step end to end, to reproduce CONFIRMED blockers `MAP-1` (config double-wrap panic) and `MAP-2` (RF link structurally never started), plus `MAP-8` (gRPC :10000 / webapp :3000 reachable while the mapper runs). `MAP-2`/`SYN-2` reproduce on **every** run until the fix wave lands, so they are recorded in `data.expectedFindingsReproduced` and do **not** set the exit code: a FAIL here means something the suite did *not* already know about. |
| `60-hid-transition.ps1` | `-MapperExe` (mapper must already be running) | Windows HID presence transitions across an operator-driven DS4 unplug/replug, plus mapper-**process** continuity. **Human-in-the-loop by nature** — see below. **Not an R15 test**, and nothing in this suite discharges R15 (see below). |
| `run-all.ps1` | (per-script, see above) | runs everything it has parameters for, skips what it doesn't, prints one PASS/FAIL table, writes `results/<timestamp>.json`. |

Every **numbered** script (`00`–`60`) is idempotent, prints one
`W17VAL_RESULT: {...}` JSON line plus a human summary, and exits 0/PASS or
1/FAIL. **`run-all.ps1` does not print a `W17VAL_RESULT` line** — it is the
driver, not a check: it prints the PASS/FAIL table, writes the combined
`results/<timestamp>.json`, and exits 1 if any non-skipped step failed. (The
previous wording claimed `run-all.ps1` printed one too; it never did.)
`lib/common.ps1` documents the shared result envelope and safety rules in
full; read it once before reading any individual script.

### R15 is NOT tested by this suite

`60-hid-transition.ps1` was once called `60-r15-pad-unplug.ps1` and described
`R1–R16` as a *"bench-gate checklist"*. Both were wrong, and a green line from
it could have been read as an unlock gate passing. `R1–R16` is the
**FIRST_ACTIVE unlock checklist** (`CURRENT_STATUS.md` §2.3.11.6 — the
head-tracked-gimbal arbiter, parked on the `u4-arbiter` branch). **R15**
specifically (`CURRENT_STATUS.md:1356`) is *device loss ⇒ **arbiter** disarm,
from `ARMING`/`ACTIVE`/`OVERRIDDEN`, reconnect proves no restore* — arbiter
states, in unmerged code. `CURRENT_STATUS.md:1375`: **"R15 remains NO-GO"**.

`60` measures Windows HID presence and mapper-process liveness. That is real
and worth having; it is not R15 evidence, **nothing in this suite discharges
R15**, and R15 stays NO-GO after a green run. Every result `60` emits —
including its early-exit failures — carries a `data.r15Status` field saying
exactly this.

## Driving them from the Mac over SSH

Once the VM's guest OpenSSH server is set up (workspace runbook §2) and
`~/.ssh/config` has a `w17vm` host entry:

```sh
# one script, one call — a plain (non-interactive) command works for every
# script EXCEPT 60 (see "human-in-the-loop" below)
ssh w17vm 'pwsh -File C:\w17\scripts\windows-validation\10-install-gs.ps1 -InstallerPath C:\w17\dist\w17-ground-station-Setup.exe -ResultsDir C:\w17\results'

# the whole automated sweep in one call
ssh w17vm 'pwsh -File C:\w17\scripts\windows-validation\run-all.ps1 -InstallerPath C:\w17\dist\w17-ground-station-Setup.exe -MapperExe C:\w17\mapper\elrs-joystick-control.exe -Profile C:\w17\mapper\configs\w17-ds4.json -Password <hotspot-password>'
```

The numbered scripts write their machine-readable line to the process's real
stdout, so `ssh … | grep '^W17VAL_RESULT: ' | cut -d' ' -f2- | jq .` works
directly. (It did not always: the line used to go through `Write-Output`,
which `exit (Write-W17Result $r)` captured instead of printing — the envelope
never reached stdout at all, and the exit code came back 0 even for a FAIL.
Both are fixed; `lib/common.ps1` explains why the line now goes through
`[Console]::Out`.)

Pull results back to the Mac:

```sh
scp -r w17vm:'C:\w17\scripts\windows-validation\results\20260101-120000' ./results/
# or, for run-all's single combined file:
scp w17vm:'C:\w17\scripts\windows-validation\results\20260101-120000.json' ./results/
```

A `vmrun -T fusion captureScreen` (from the Mac, against the running VM) is
useful alongside any script that needs an operator watching the guest
console — see the workspace runbook for the full `vmrun` command set
(start/stop/revertToSnapshot/captureScreen).

## Non-automatable steps (human-in-the-loop, by design)

Nothing below is a gap in these scripts — each is something no script can
do, and each one is called out explicitly at the point it matters rather
than silently skipped:

- **Physically unplugging/replugging the DualShock 4** (`60-hid-transition.ps1`)
  — no script can pull a USB cable. **Car unpowered / RX unbound first** (see
  above and that script's header). Run it over an **interactive** SSH
  session (`ssh -t w17vm pwsh -File ...`) for its `Read-Host` prompts, or
  with `-NonInteractive` for a fixed timed window if you can only reach the
  VM with a one-shot command and are watching the console another way
  (`vmrun captureScreen`, or physically at the machine).
- **The first-launch Windows Defender Firewall prompt** ("has blocked some
  features of this app") — `40-mdns-udp.ps1` reports whether an app/port
  firewall rule already exists, but a fresh install has neither until either
  the operator clicks through that prompt once or an admin pre-seeds a rule.
  No script here clicks it.
- **Exercising the GRID-launch env-scrub gap live** — `50-race-day.ps1`
  documents the gap between `main/elrsLauncher.js` (inherits the full,
  unscrubbed environment) and race day's managed launch (scrubs the entire
  `W17_*` class) as a cited **code fact**, not a live run: `launchDetached()`
  spawns the real control-path binary detached, with no pid returned and no
  kill hook by design, which an unattended VM session cannot safely clean up.
  A human watching Task Manager can identify and close the exact new process
  by launch time; do that manually if you want to see the gap in action.
- **Whether control actually resumes after a DS4 replug** — `60` proves the
  Windows-visible HID transition and mapper-process continuity only.
  CONFIRMED finding `MAP-6` (the mapper's SDL gamepad registry never
  reopens a re-added pad) predicts control will not resume until the mapper
  restarts; confirming that for real means watching the actual car, which is
  outside what a validation script should decide on its own.
- **A real Windows PC pass at handover** — owner decision A4: the VM is
  where this whole suite runs during development; the giftee's real PC gets
  the same scripts run against it once, by hand, before the gift is
  finalized (workspace runbook).

## `[win-TBD]` items this suite cannot resolve itself

Per workspace `CLAUDE.md` (A2 NOT-EXECUTED, Phase B BLOCKED: no doc may claim
a hardware fact is proven), several values these scripts read are formulas
or fallbacks, not observations, until run for real on the VM — each script's
own comments say so at the point it matters (search for `[win-TBD]` and
`win-TBD` across this directory), and nothing here invents a substitute
number. Notably: electron-builder's default NSIS install directory (only a
formula until `10-install-gs.ps1` runs against a real artifact), whether a
5 GHz-capable Wi-Fi driver actually produces a 5 GHz hotspot (`00`/`30`
report a driver-string hint, not an observed radio), and the ELRS TX
USB-serial adapter's VID:PID (the owner has not named a chipset).

## What has and has not been executed

**Executed, under PowerShell 7.7.0-preview.4 on macOS, against stubs:**
`Parser::ParseFile` over all 9 `.ps1` files (0 errors); `lib/common.ps1`
dot-sourced and its pure functions unit-run (result envelope, JSON round-trip,
key ordering, the `$Env`/`$env` collision, `Get-W17Prop` over every probe
shape); `00-inventory.ps1`'s netsh parser against EN/DE fixtures;
`20-mapper-stage.ps1` end to end against the app's real
`main/settingsStore.js` (BOM-less write, merge, placeholder refusal);
`30-hotspot.ps1` and `50-race-day.ps1` end to end against stub probes in
four and five outcome modes; `60-hid-transition.ps1` on both early-exit
paths; and the whole suite through `run-all.ps1`.

**NOT executed — `[win-TBD]`, and nothing here claims otherwise:** anything
that needs Windows. `netsh` output formats and locales, Defender firewall
rules, WMI/CIM (`Win32_PnPEntity`, `Win32_OperatingSystem`),
`Get-NetTCPConnection` / `Get-NetUDPEndpoint`, the WinRT Mobile-Hotspot and
ICS paths, NSIS `/S` and `/D=` against a real artifact, electron-builder's
actual install directory, real USB/HID unplug behaviour, and the ARM64 driver
question for an adapter that has not been bought yet. Search this directory
for `[win-TBD]` — each marker sits on the exact claim it qualifies.

Re-run the parse check any time:

```sh
pwsh -NoProfile -Command '
  Get-ChildItem -Recurse -Filter *.ps1 | ForEach-Object {
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$null, [ref]$errors)
    if ($errors) { Write-Host "PARSE ERRORS: $($_.FullName)"; $errors | ForEach-Object { Write-Host "  $_" } }
    else { Write-Host "OK: $($_.FullName)" }
  }
'
```

Note what a parse check does **not** catch: every blocking defect the review
and this fix pass found — the `$Env`/`$env` collision, the StrictMode
property throws, the swallowed `W17VAL_RESULT` line, the empty output
capture — parses perfectly clean. Running the code is what found them.
