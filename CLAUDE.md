# w17-ground-station — Local Guidance (Claude Code)

Windows/laptop ground-station maintenance guide. Shared W17 workspace rules live in the
parent `../CLAUDE.md`; this file carries only repo-specific rules. Volatile
checkpoints/status live in `../CURRENT_STATUS.md`, never here.

## Repo scope

- Electron ground-station app; runs on Windows (the deployment target), also macOS/Linux.
- Integrates **video** (RTSP → mediamtx → WebRTC/WHEP), the **HUD**, and **telemetry**.
- **Windows is the control/integration authority.** The iPhone is a thin HUD/client only.
- This app is a **viewer** — it does not drive the car; control stays with
  elrs-joystick-control (DualShock → CRSF → ELRS).
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
- Never route head-tracking intent (`main/HeadTrackingReceiver.js`,
  `shared/headTracking.js`) into any control output.
- Do not casually change the bridge contract. `iPhone_rc` (Codex-owned) owns the
  **canonical** schemas/examples/contract; this repo keeps an **implementation copy only**
  (`docs/windows_bridge_contract.md`).
- Any contract change must be deliberate and **mirrored on both sides** (this repo and
  `iPhone_rc`), not made unilaterally here.

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
