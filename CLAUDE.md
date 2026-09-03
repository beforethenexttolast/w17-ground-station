# w17-ground-station — Local Guidance (Claude Code)

Windows/laptop ground-station maintenance guide. Shared W17 workspace rules live in the
parent `../CLAUDE.md`; this file carries only repo-specific rules. Volatile
checkpoints/status live in `../CURRENT_STATUS.md`, never here.

## Repo scope

- Electron ground-station app; runs on Windows (the deployment target), also macOS/Linux.
- Integrates **video** (RTSP → mediamtx → WebRTC/WHEP), the **HUD**, and **telemetry**.
- **Windows is the control/integration authority.** The iPhone is a thin HUD/client only.
- This app is a **viewer** — it does not drive the car; control stays with
  elrs-joystick-control. The GRID launch of elrs-joystick-control (DualShock → CRSF → ELRS)
  is detached and fire-and-forget: this app starts it but has no kill/stop/restart path to it
  (`main/elrsLauncher.js`). Race day separately may *manage* the mapper binary's PROCESS
  lifecycle (start/liveness/stop) — the mapper binary IS elrs-joystick-control, launched
  through a second, separately-manageable contract (`main/mapperRunner.js` vs
  `main/elrsLauncher.js`); managing a process is not driving the car; see the guardrail below
  for what that still forbids.
- **Firmware is a separate concern** (own repos: `w17-control-fw`, `w17-soundlight-fw`)
  and is never edited or reached from here.

## Bridge architecture

- **W2 — telemetry, Windows → iPhone**, UDP port **5601**, send-only. Windows streams the
  normalized telemetry snapshot as UDP/JSON to the iPhone HUD. Off by default
  (`W17_IPHONE_BRIDGE`). Nothing flows back on this path.
- **W3 — head-tracking, iPhone → Windows**, UDP port **5602**, receive-only and
  **LOG-ONLY**. Packets are validated, counted, and summarized to the console; nothing
  else happens. Off by default (`W17_HEADTRACK`).
- The head-tracking receiver **must remain a diagnostic/log-only path** unless a separate,
  explicitly approved safety milestone changes that. Do not wire it to anything.

## Safety boundaries (non-negotiable)

- No active iPhone-derived pan/tilt.
- No iPhone → CRSF.
- No iPhone → servo / gimbal / ESC.
- No firmware UDP/JSON awareness — firmware stays iPhone-unaware.
- No direct iPhone-to-control path of any kind.
- No physical camera movement driven by W3 head-tracking.

## Guardrails for future work

- Keep the `noControlPath`-style tests green (`test/noControlPath.test.js`) — they assert
  head-tracking intent never reaches control outputs. If a change trips them, the change is
  wrong, not the test.
- Race day may **manage the mapper PROCESS** — start, liveness, stop
  (`main/mapperRunner.js`, `main/raceDayOrchestrator.js`) — but must never **send it
  commands**: no stdin (the child's input stream is closed outright), no control RPC, no IPC
  channel, nothing on UDP 5602; argv is limited to `MAPPER_ARG_WHITELIST` and the child env
  is scrubbed of the entire `W17_*` namespace. **Read-only stream subscriptions are viewer
  consumers, not a control path**, and stay allowed: subscribing to one of the mapper's
  server-streaming gRPC endpoints on `127.0.0.1:10000` and only rendering what it returns is
  the sanctioned pattern (`main/HeadIntentDiagnosticsClient.js` — it opens and cancels the
  stream and does nothing else). This is a deliberate evolution of the launch-only doctrine
  above, not an exception to it — the GRID launcher stays detached and unstoppable.
  `test/noControlPath.test.js:124-169` pins the process contract structurally; if a change
  trips it, the change is wrong.
- Never route head-tracking intent (`main/HeadTrackingReceiver.js`,
  `shared/headTracking.js`) into any control output.
- Do not casually change the bridge contract. `iPhone_rc` (Claude-owned since 2026-08-17,
  relocated into this workspace) owns the **canonical** schemas/examples/contract; this repo
  keeps an **implementation copy only** (`docs/windows_bridge_contract.md`). The mirror
  discipline is unchanged: canonical first, deliberate re-mirror here.
- Any contract change must be deliberate and **mirrored on both sides** (this repo and
  `iPhone_rc`), not made unilaterally here.
- **Camera-aim depiction (relaxed 2026-07-16, reviewed):** the UI **may** draw right-stick
  input — it must never label it as measured camera aim. Stick position is `STICK INPUT`;
  `camera aim` / `measured` / `gimbal` wording stays banned, and stick dots ride
  `data-stick`, never the `data-role` press-mirror seam. Rules:
  `docs/camera_aim_display_semantics.md` §2.1; pinned by `test/padPreview.test.js`.

## Validation guidance

- Real iPhone ↔ Windows bridge validation **is allowed**.
- Validate **one step at a time**.
- Adjust the **debug/validation setup only**; source changes require explicit approval
  first.
- Capture logs / screenshots / evidence for each validated step.
- **Active pan/tilt validation is NOT allowed** in W3 — it stays log-only.

## Pointers

- `README.md` — app overview, run/build, bridge env vars, troubleshooting.
- `docs/windows_bridge_contract.md` — implementation copy of the bridge contract.
- `docs/iphone_windows_bridge_test_plan.md` — bridge validation test plan.
- `docs/iphone_bridge_readiness.md` — bridge readiness notes.
- `docs/SETUP.md`, `docs/TELEMETRY.md`, `docs/CODESIGNING.md` — setup, telemetry contract,
  signing.
- `../CURRENT_STATUS.md` — volatile checkpoints / gate status (workspace-level).
