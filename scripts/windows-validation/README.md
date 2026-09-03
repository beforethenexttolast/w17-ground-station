# Windows-VM validation scripts

PowerShell scripts that exercise the **installed** ground-station build (and,
where relevant, the mapper it drives) against a real Windows guest. Owner
decision A4: a VMware Fusion VM on the owner's Apple Silicon Mac, with the
three real USB devices (5.8 GHz AP-capable Wi-Fi adapter, ELRS TX serial,
DualShock 4) passed through — Claude drives the checks autonomously from the
Mac over SSH; a real Windows PC is the final proof only at handover. The full
one-time VM setup and the autonomous-drive design live in the workspace
runbook: `w17-windows-vm-validation-runbook.md` (workspace root, not this
repo — see `WORKSPACE_MAP.md`).

Nothing here flashes, uploads, or powers hardware, and nothing opens a serial
port for control (workspace `CLAUDE.md` safety rules) — the COM-port and
HID inventory below is read-only enumeration, never a port open.

## What each script does

| script | needs | what it proves |
|---|---|---|
| `00-inventory.ps1` | nothing | host survey: OS/arch, VMware Tools, Wi-Fi adapter + 5 GHz capability, COM ports, DualShock4 HID, installed W17 apps, firewall profiles. Informational — no pass/fail gate. |
| `10-install-gs.ps1` | `-InstallerPath` | silent-installs the NSIS build; FAILS LOUDLY if `mediamtx.exe` is missing (CONFIRMED finding `boundaries-1`: CI never runs `fetch-mediamtx.js` before packaging) and reports whether `proto/` is packaged. |
| `20-mapper-stage.ps1` | `-MapperExe -Profile` | stages the mapper + profile exactly where race day's real path resolution expects them; FAILS if the profile still carries `REPLACE-WITH-` placeholders (`MAP-5`). |
| `30-hotspot.ps1` | `-InstallDir -Password` | drives the app's own `main/hotspot.js` / `hotspotVerify.js` through start → verify → teardown. Clean FAIL (not a crash) when no hotspot backend/adapter exists. |
| `40-mdns-udp.ps1` | `-InstallDir` | firewall state for UDP 5601/5602/5353, a real mDNS query via the app's own codec, and a UDP 5601 receive probe using the app's own replay telemetry + iPhone-bridge env. |
| `50-race-day.ps1` | `-InstallDir` (+ a completed `20` stage) | drives race day's REAL mapper step end to end. **Expected to FAIL against today's code** — it exists to reproduce CONFIRMED blockers `MAP-1` (config double-wrap panic) and `MAP-2` (RF link structurally never started), plus `MAP-8` (gRPC :10000 / webapp :3000 reachable while the mapper runs). |
| `60-r15-pad-unplug.ps1` | `-MapperExe` (mapper must already be running) | R15 bench-gate item: physically unplug/replug the DualShock 4, poll Windows HID state and mapper-process continuity. **Human-in-the-loop by nature** — see below. |
| `run-all.ps1` | (per-script, see above) | runs everything it has parameters for, skips what it doesn't, prints one PASS/FAIL table, writes `results/<timestamp>.json`. |

Every script (`run-all.ps1` included) is idempotent, prints one
`W17VAL_RESULT: {...}` JSON line plus a human summary, and exits 0/PASS or
1/FAIL. `lib/common.ps1` documents the shared result envelope and safety
rules in full; read it once before reading any individual script.

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

- **Physically unplugging/replugging the DualShock 4** (`60-r15-pad-unplug.ps1`)
  — no script can pull a USB cable. Run it over an **interactive** SSH
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

## Syntax validation

These scripts were authored and reviewed without a local `pwsh` to run
against (checked via `which pwsh` on the authoring machine — not found).
Before relying on a script unattended, validate it once:

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
