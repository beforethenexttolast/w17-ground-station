# Setup-flow bench checklist (Windows GS host)

**Status: NOT EXECUTED. Every item below is UNVALIDATED until its evidence box is
filled in.** The orchestration logic is unit-tested against canned command output
(`test/wifiManager.test.js`, `test/hotspot.test.js`, `test/elrsLauncher.test.js`);
this checklist validates the real OS layer those fakes stand in for.

Rules (repo validation guidance): one step at a time; capture evidence (console log
lines, screenshots) per step; debug/validation setup only — any source change found
necessary goes back through review first. W3 stays LOG-ONLY throughout; active
pan/tilt is out of scope. When done, summarize results into `../CURRENT_STATUS.md`
(the workspace status file), not into this document's rules.

**`W17_WIFI_SIM` must be UNSET for every item below.** The simulation backend is a
dev preview against canned netsh output (the app shows a SIMULATED WIFI tag when it
is active) — it is never valid bench evidence; only the real OS layer counts here.

Prereqs:
- Windows GS host at the current `main` HEAD (`git rev-parse --short HEAD`; pull past the
  pre-hardware hardening pass — through E1, plus CB8 slices 3B/3C). Do not pin a floor
  hash here; it drifts — read the current HEAD and the current test count from CI/README.
- `npm install`, then **`npm run setup`** (fetches the pinned `mediamtx` binary and repairs
  the Electron binary if a script gate blocked the postinstall), then `npm test` green.
- **mediamtx configured for the camera:** edit `mediamtx/mediamtx.yml` → `paths.cam.source`
  to the real camera RTSP URL (see `SETUP.md` §2–§3) — without it the video checks below
  can never pass.
- RT5370 dongle on hand, iPhone with the HUD app for steps 8–10.

For the full evidence ledger this checklist feeds, see the **authoritative
hardware-evidence matrix** in `docs/audits/2026-07-12-pre-hardware-hardening-audit.md`
(§ "Authoritative hardware-evidence matrix"); each item below maps to a matrix row.

## 1. Baseline

- [ ] `git rev-parse --short HEAD`; `npm test` green (current total — see README/CI, not a
      frozen number; at time of writing the suite is 798 tests across 46 files);
      `npm run smoke:electron` → 4/4 scenarios PASS.
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

- [ ] Fresh `settings.json` (delete it): GARAGE → PIT WALL → SEAT FIT → GRID → all
      green → START → five lights, lights out, HUD fades in over live video.
- [ ] Relaunch: lands on GRID directly (returning-driver path); CHANGE SETUP walks
      back; START ANYWAY works with a deliberately red check.
- [ ] Radio sounds: default silent; enable in `⚙` → cues audible; disable → silent.
- Evidence: short screen recording of lights-out into the HUD.

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

## Sign-off

- [ ] Results + deviations summarized into `../CURRENT_STATUS.md` (checkpoint hash,
      what passed, what's still open) and into the audit's hardware-evidence matrix. Any
      needed source fix → new reviewed change, then re-run the affected steps.
