# Setup-flow bench checklist (Windows GS host)

**Status: NOT EXECUTED. Every item below is UNVALIDATED until its evidence box is
filled in.** The orchestration logic is unit-tested against canned command output
(`test/wifiManager.test.js`, `test/hotspot.test.js`, `test/elrsLauncher.test.js`);
this checklist validates the real OS layer those fakes stand in for.

Rules (repo validation guidance): one step at a time; capture evidence (console log
lines, screenshots) per step; debug/validation setup only — any source change found
necessary goes back through review first. W3 stays LOG-ONLY throughout; active
pan/tilt is out of scope. When done, summarize results into `../../CURRENT_STATUS.md`
(the workspace status file, workspace root), not into this document's rules.

**`W17_WIFI_SIM` must be UNSET for every item below.** The simulation backend is a
dev preview against canned netsh output (the app shows a SIMULATED WIFI tag when it
is active) — it is never valid bench evidence; only the real OS layer counts here.

Prereqs:
- Windows GS host at the current `main` HEAD (`git rev-parse --short HEAD`; pull past the
  pre-hardware hardening pass — through E1, plus CB8 slices 3B/3C). Do not pin a floor
  hash here; it drifts — read the current HEAD and the current test count from CI/README.
- **Two valid ways to get the app onto the host** — see `SETUP.md` "Two ways to run this
  app": (a) **dev checkout** — `npm install`, then **`npm run setup`** (fetches the pinned
  `mediamtx` binary and repairs the Electron binary if a script gate blocked the
  postinstall), then `npm test` green; or (b) **the installed gift-kit app** — run the NSIS
  installer (`npm run build` locally, or the `w17-ground-station-nsis-unsigned` artifact
  from a green CI run) once on the target Windows account, launch it from the Start Menu.
  Path (b) has no `npm`/source tree — every `⚙`-menu step below still applies; every
  `npm run demo*` / env-var step is dev-checkout-only and does not apply to (b). Record
  which path was used for each evidence box; `[win-TBD]` items specific to path (b)
  (installed resources path, Start Menu shortcut, no-admin install) have never been run —
  see `SETUP.md`.
- **mediamtx configured for the camera:** edit `mediamtx/mediamtx.yml` (dev checkout:
  `mediamtx/mediamtx.yml`; installed app: under its own resources directory, `[win-TBD]`
  exact path — see `SETUP.md`) → `paths.cam.source` to the real camera RTSP URL (see
  `SETUP.md` §2–§3) — without it the video checks below can never pass.
- **RACE DAY prerequisites (§12 below):** a saved controller profile file must exist and
  be reachable from the host (e.g. the mapper kit's `configs/w17-ds4.json` placeholder —
  the real file ships with the `w17-mapper` release, not this repo) and the ⚙ **RACE DAY**
  fields (drive-program path, saved-profile path) must be set once before §12's checks mean
  anything; an unset profile is an expected, honest `FAIL` per `shared/raceDayView.mjs`,
  not a bug.
- The GCS box (RT5370 + ELRS TX + hub, pre-wired for the gift kit) is documented at
  `../../w17-gcs-box-guide.md` (workspace root) — confirm its contents against that guide
  before starting the network/hotspot steps (2–4) if this is a from-the-box bench pass.
- RT5370 dongle on hand, iPhone with the HUD app for steps 8–10.

For the full evidence ledger this checklist feeds, see the **authoritative
hardware-evidence matrix** in `docs/audits/2026-07-12-pre-hardware-hardening-audit.md`
(§ "Authoritative hardware-evidence matrix"); each item below maps to a matrix row.

## 1. Baseline

- [ ] `git rev-parse --short HEAD`; `npm test` green (current total — see README/CI, not a
      frozen number; at time of writing (2026-09-03) the suite is 1447 tests across 67
      files — re-read this from the current `npm test` summary or CI, it drifts every
      wave); `npm run smoke:electron` → 4/4 scenarios PASS (`normal`, `corrupt-settings`,
      `forced-failure`, `timeout` — `node scripts/electron-smoke.js --list`).
- [ ] `npm start` boots to GARAGE; `⚙` menu opens; `settings.json` appears under
      `%APPDATA%/w17-ground-station/` after any change.
- Evidence: console excerpt + screenshot of GARAGE.

## 2. WiFi scan + join (PIT WALL)

- [ ] Enter *iPhone HUD* mode → PIT WALL lists real networks with signal % and
      `known` flags matching `netsh wlan show profiles`.
- [ ] Join a **known** network from the list (no password prompt) → radio message
      "NETWORK CONFIRMED", Windows shows it connected.
- [ ] Join a **new** network (password prompt) → connects; confirm no leftover
      `w17-wlan-*.xml` in `%TEMP%` (key material must be deleted).
- [ ] Non-English Windows only: scan list still populates (structure-based parsing).
- [ ] ADAPTER row: with only the built-in WLAN adapter, the row shows a readonly
      confirmation (name — description · connected SSID), no picker.
- [ ] Plug in the RT5370 → RESCAN → the row becomes a picker listing both adapters;
      choose the dongle and rescan/join — results now come from that interface
      (spot-check against `netsh wlan show networks interface="Wi-Fi 2"`).
- [ ] Unplug the dongle while it is the saved choice → RESCAN → picker falls back to
      the remaining adapter with a `saved adapter … not found` hint; with zero WLAN
      adapters the row shows the amber NO WLAN ADAPTER DETECTED dongle hint.
- [ ] WLAN radio off (or WLAN AutoConfig stopped): join pane shows `SCAN FAILED —
      <reason>` (never "NO NETWORKS FOUND") and the row shows ADAPTER LIST FAILED.
- Evidence: screenshot of list + `netsh wlan show interfaces` after join, plus one
  screenshot of the ADAPTER row in each state above.

## 3. Hotspot — Mobile Hotspot backend

- [ ] With a tetherable connection profile present: START HOTSPOT → status `LIVE
      (mobile)`; SSID/password visible; a second device can join and ping the PC.
- [ ] Windows Settings shows the Mobile Hotspot as on, SSID matches `W17-GRID`
      (or the edited value).
- Evidence: hotspot status line + ping output from the second device.

## 4. Hotspot — hostednetwork fallback (RT5370)

- [ ] `netsh wlan show drivers` on the RT5370: record "Hosted network supported".
- [ ] With Mobile Hotspot unavailable (e.g. no tetherable profile): START HOTSPOT
      falls back → `LIVE (hosted)`; a second device joins and pings the PC.
- [ ] **Elevation case:** run the app *without* admin → expect the explicit
      "run as administrator" message, no silent failure. Re-run elevated → works.
- [ ] One-radio caveat: confirm the RT5370 hosts while the built-in adapter stays
      on the camera/backhaul network.
- Evidence: drivers output, status lines for both attempts, ping output.

## 5. Client isolation demonstration (negative test)

- [ ] On the office/guest network: GRID "IPHONE REACHABLE" stays red while both
      devices are online (ping blocked) — matches the recorded `SE-Guest` finding.
- [ ] Switch to hotspot → same check goes green with no app restart.
- Evidence: checklist screenshots on both networks.

## 6. elrs-joystick-control launch-only integration

- [ ] Set the path in `⚙` → GRID shows ELRS CONTROL row; LAUNCH starts it; row goes
      OK within a poll or two (`tasklist` detection).
- [ ] **Survival test:** quit the ground station (and once: kill it from Task
      Manager) → elrs-joystick-control keeps running. This is the safety property.
- [ ] Unset/broken path: row shows SKIP (not configured) and never blocks START.
- Evidence: task manager screenshot after GS quit.

## 7. Controller (SEAT FIT)

- [ ] Real DualShock: listed by id; live test strip follows steer/throttle/brake;
      preset persists across app restart (HUD mirrors without re-selecting).
- [ ] Mapping preview lights pressed buttons live (R2/L2/R1/L1/△/○/□ highlight their
      pill/circle; releasing clears; right stick lights nothing).
- [ ] Two pads connected: selection sticks to the chosen id.
- Evidence: screenshot of SEAT FIT with the strip mid-input.

## 8. W2 telemetry to the real iPhone — settings-only enable

- [ ] No `W17_IPHONE_BRIDGE` env var set. iPhone HUD mode + confirmed IP → after
      GRID `session:apply`, iPhone HUD shows live values (`npm run demo` data OK).
- [ ] Env override check: relaunch with `W17_IPHONE_BRIDGE=0` → bridge stays off
      despite settings; GRID radio notes env lock.
- Evidence: iPhone screenshot + console `[iphone] telemetry bridge ->` line.

## 9. W3 toggle + address suggestion (LOG-ONLY)

- [ ] Enable head-track logging in `⚙` → console `LOG-ONLY receiver listening`;
      iPhone (or fake sender) produces `active_log_only` rate lines; **no camera,
      CRSF, or control effect anywhere** (there is no code path; observe anyway).
- [ ] With packets flowing, PIT WALL shows the `USE <ip> · from HUD traffic` chip;
      chip fills the field; suggestion disappears ~30 s after packets stop.
- [ ] While logging is enabled, the HUD session panel (after START) shows the amber
      `HEAD-TRACK LOG · NO CONTROL` chip; disabling in `⚙` hides it.
- Evidence: console lines + PIT WALL screenshot with the chip visible.

## 10. Full flow + lights

- [ ] Fresh `settings.json` (delete it): GARAGE → PIT WALL → SEAT FIT → SETUP → GRID →
      all green → START → **no** lights by default (START LIGHTS is OFF out of the box,
      `shared/settings.js` `startLightsEnabled: false` — confirm SESSION LIVE fades straight
      in); enable START LIGHTS in `⚙` → relaunch the flow → now five lights, lights out,
      HUD fades in over live video.
- [ ] Relaunch (settings.json already exists): the app lands on **GARAGE**, not GRID —
      `boot()` always shows GARAGE (`renderer/setupFlow.js` `boot()`); a completed prior
      session shows the **WELCOME BACK — LAST SESSION READY** card there with a
      **STRAIGHT TO THE GRID ▸** button that opens GRID directly (re-running its checks) —
      confirm the card appears and the button works, not that the app skips GARAGE
      entirely. CHANGE SETUP (from GRID) walks back through the numbered steps; START
      ANYWAY works with a deliberately red check.
- [ ] Radio sounds: default silent; enable in `⚙` → cues audible; disable → silent.
- Evidence: short screen recording of lights-out into the HUD (once with START LIGHTS on,
  once with it off).

## 11. Hardening-pass bench items (batches A–E)

The pre-hardware hardening pass added behaviors that the original steps 1–10 don't fully
exercise. Verify these on the real OS; each maps to a matrix row in the audit.

- [ ] **A — Hotspot STOP + quit ownership.** START HOTSPOT → LIVE; **STOP HOTSPOT** returns
      it to READY (second device drops). Quit while LIVE (app-owned) → the *STOP AND QUIT /
      LEAVE RUNNING / CANCEL* dialog appears; LEAVE RUNNING quits with the hotspot still up;
      STOP AND QUIT stops then quits. Turn a hotspot on from Windows Settings (not the app),
      then quit the app → **no** dialog (externally-owned hotspot untouched). Force a stop
      failure if possible → the app keeps ownership and STOP stays retryable.
      Evidence: status lines + the quit dialog screenshot.
- [ ] **B — Wi-Fi security classification (real `netsh wlan show networks mode=bssid`).**
      Against a real open, WPA2-PSK, WPA2/WPA3-transition, WPA3-only, and enterprise AP:
      open → joins with the `OPEN NETWORK — unencrypted` warning; WPA2 + transition → join;
      WPA3-only + enterprise → rejected up front with the controlled message (never a raw
      netsh error); an unidentifiable *new* network → rejected conservatively; a network
      with a saved Windows profile → joins via the profile. Record each AP's real
      Authentication/Encryption strings. Evidence: scan screenshot + per-class result lines.
- [ ] **C — Reachability classification (real Windows `ping`).** A live host shows `TTL=`
      → REACHABLE; a dead host → timeout; a router-originated "Destination host unreachable"
      → classed **unreachable** (not a false green). Repeat on a localized Windows build if
      available. Evidence: raw ping output + the GRID line for each case.
- [ ] **D — Video-state lock (real camera → mediamtx → WHEP).** Live stream → GRID VIDEO
      LOCK green and W2 `video_lock:true` only while actually `playing`; kill/stall the
      stream → lock clears within a reconnect (waiting/stalled/dropped/error all clear it,
      not just an emptied element); recovery re-locks. Evidence: screen recording of a drop
      + recovery.
- [ ] **E — Credential DPAPI round-trip (packaged app, real Windows account).** Save a
      hotspot password → `settings.json` shows an empty `password` and a `passwordEnc` DPAPI
      blob (no plaintext, incl. `.bak`); restart → recovered. Copy the settings file to a
      **different** Windows account/machine → the app prompts to re-enter (no crash, other
      settings intact). With secure storage unavailable → session-only (lost on restart, no
      plaintext). Evidence: on-disk `settings.json` excerpt (redacted) + the re-enter/notes.

## 12. RACE DAY — one-action bring-up (GARAGE)

New wave, not covered by steps 1–11. See the README "RACE DAY" section for the full
mechanism (`main/raceDayOrchestrator.js`, managed via `main/mapperRunner.js`). Requires the
prereq above (a saved controller profile + the ⚙ RACE DAY paths set).

- [ ] With a saved session and the ⚙ RACE DAY drive-program + profile paths **unset**:
      GARAGE's RACE DAY card shows the DRIVE PROGRAM step failing with "its location is not
      set — set it once in ⚙ (RACE DAY)" (or the profile-equivalent line) — confirm it fails
      honestly rather than silently no-op'ing.
- [ ] Set both ⚙ RACE DAY paths (a real drive-program `.exe` + an existing profile file) →
      press **RACE DAY ▸ BRING EVERYTHING UP** → confirm, in order: CAR WI-FI switches on
      (or shows "using your own Wi-Fi" if the saved network plan isn't the hotspot), DRIVE
      PROGRAM shows "starting…" then "running" (`tasklist`/Task Manager confirms the process
      exists), PHONE LINK shows "on — pick up the phone" (iPhone sessions with the checkbox
      on) or "not needed this time" otherwise.
- [ ] **`[fix-wave: SYN-2]`** — a "running" DRIVE PROGRAM step is **not** proof the radio
      link to the car is up: with the GCS box's serial link deliberately unplugged, confirm
      today's behavior is that the step still reports "running" (the process started; it
      does not probe the link). This is a known, tracked gap (`SYN-2`, gift-blocking) — do
      not treat a green RACE DAY card as proof the car will respond until that fix lands.
      Record whether the process nonetheless exits/crashes on its own with the link absent
      (a different, informative signal from the honest "running" one above).
- [ ] Press RACE DAY again while everything is already up → idempotent re-run: each step
      re-verifies/no-ops (hotspot re-verified, mapper shows "already running", bridge
      re-applies) rather than restarting anything.
- [ ] **STOP RACE DAY** (visible while the managed process appears to be running) → press
      it, confirm the process exits (Task Manager confirms) and the DRIVE PROGRAM step
      returns to "waiting…"; the hotspot and phone link are **not** touched by this button
      (PIT WALL / the quit dialog still own those, unchanged). `[fix-wave:
      lifecycle-concurrency-3]` **Today's truth:** immediately after pressing it, expect the
      button to possibly still be visible for a moment — `MapperRunner.stop()`
      (`main/mapperRunner.js:162-172`) leaves `_proc` set until the child's own `exit` event
      fires, and the orchestrator's liveness mirror (`main/raceDayOrchestrator.js:104-111`)
      does not re-emit once its own step is already `idle`, so the stale "running" state can
      linger in the renderer past the actual stop. Record how long the button visibly lags
      the real process exit.
- [ ] Launch the SAME drive-program executable from GRID's own **LAUNCH** button first
      (the detached, launch-only path), then press RACE DAY → DRIVE PROGRAM shows "already
      running (started outside RACE DAY)" and STOP RACE DAY does **not** appear for it (race
      day never adopts or stops a process it did not start) — confirms the two launch paths
      documented in the README don't collide.
- [ ] Kill the race-day-managed process externally (Task Manager, not STOP RACE DAY) →
      the card mirrors the death honestly ("stopped on its own — press RACE DAY to bring it
      back"), without a button press.
- Evidence: screenshots of each step state above + Task Manager before/after STOP.

## 13. Low-battery banner + video profiles (real hardware)

- [ ] `npm run demo:low-battery` (dev checkout only) exercises the ⚙ LOW BATTERY banner
      against the replay backend — confirm this rehearsal still matches what a real sagging
      pack produces: connect the real CRSF telemetry source (§8/`SETUP.md` §4) and, on the
      bench with a genuinely low pack (supervised — do not over-discharge a LiPo to test
      this), confirm BATTERY LOW then BATTERY CRITICAL appear at the ⚙-configured
      thresholds with the hysteresis hold (no flicker at the boundary).
- [ ] VIDEO STYLE — switch DRIVE ↔ SHOWPIECE from GARAGE and from ⚙ against the real camera
      → confirm the restart-and-reconnect note appears, the picture returns, and SHOWPIECE
      is visibly smoother/more buffered than DRIVE. `docs/video_profiles.md` "Bench-TBD
      (CB5)" lists the specific knob values (RTSP/TCP ingest, write-queue size, playout
      target) still unverified against the real camera's bitrate/GOP — confirm or correct
      those once the camera is on the bench.

## 14. Quit prompts (hotspot + RACE DAY drive program)

Item 11.A already covers the hotspot's *STOP HOTSPOT AND QUIT / LEAVE HOTSPOT RUNNING /
CANCEL* dialog. RACE DAY adds a second, independent quit prompt for its managed child:

- [ ] With a race-day-managed drive program alive, quit the app → a
      *QUIT AND STOP THE DRIVE PROGRAM / CANCEL* dialog appears first (before any hotspot
      dialog), naming the drive program in plain language. CANCEL leaves everything running
      and the app open. QUIT AND STOP THE DRIVE PROGRAM quits and the process is confirmed
      gone in Task Manager.
- [ ] With both a race-day-managed drive program AND an app-owned hotspot alive, quit → the
      drive-program dialog appears first, then (if not cancelled) the hotspot dialog.
- [ ] A drive program launched from GRID's detached LAUNCH button (not race-day-managed)
      never triggers this dialog on quit — confirms the launch-only doctrine holds.
- [ ] **`[fix-wave: SYN-1]`** — a known, tracked gift-blocking defect: if the main window is
      already closed/destroyed when CANCEL is pressed (e.g. the window was closed by other
      means while a quit was pending), the app can be left as a **windowless background
      process** still holding the hotspot and/or the managed drive program, with no way to
      bring the window back short of Task Manager. If this bench pass reproduces that shape
      (no window, but the process list still shows `w17-ground-station.exe`), record it as
      confirming `SYN-1` rather than as a new finding — do not attempt a source fix here
      (debug/validation setup only, per the rules above).
- Evidence: screenshots of each dialog + Task Manager after each quit path.

## Sign-off

- [ ] Results + deviations summarized into `../../CURRENT_STATUS.md` (workspace root —
      checkpoint hash, what passed, what's still open) and into the audit's hardware-evidence
      matrix. Any needed source fix → new reviewed change, then re-run the affected steps.
