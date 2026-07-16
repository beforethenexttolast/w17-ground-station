# SEAT FIT controller / CAMERA MODE — validation handoffs (2026-07-16)

Two validation prompts for the SEAT FIT slice (controller mirror, input-source/transport
line, CAMERA MODE section, session-stable controller identity, responsive layout). Both
are **validation only**. No source changes, no flashing/powering hardware unattended, no
active pan/tilt, no U4, W3 stays log-only. See `docs/camera_aim_display_semantics.md §5`.

---

## Prompt 1 — Windows ground-station validation (real Windows, real controllers)

> You are validating the w17-ground-station Electron app on the **Windows** deployment
> target. This is a **viewer**: it must never drive the car. Do **not** modify source in
> this session — capture evidence (screenshots + notes) for each step and report results.
> The mapper (elrs-joystick-control) is the control authority; the ground station only
> mirrors input for display. Head tracking is locked; W3 is log-only. If anything below
> lets a UI interaction change what the mapper does, STOP and report it as a defect.
>
> Launch the app (`npm start`) and go to **SEAT FIT · CONTROLLER**. Validate and screenshot:
>
> **Controllers / transport**
> 1. **DualShock 4 over USB** — appears in the DEVICE list without restart; source line
>    reads `LIVE CONTROLLER`; meta reads `… PROFILE · TRANSPORT UNKNOWN`.
> 2. **DualShock 4 over Bluetooth** — pair it in Windows first; confirm it appears without
>    restarting the app; transport still reads **UNKNOWN** (must NOT be guessed as
>    Bluetooth even though it is paired over Bluetooth).
> 3. **DualSense over Bluetooth** (if available) — same expectations; note the reported
>    `Gamepad.id` string.
> 4. **Insertion while SEAT FIT is open** — plug a controller in with the page open; it must
>    appear live without leaving/reloading the step.
> 5. **Disconnect** — unplug/turn off the *selected* controller; the mirror returns to
>    neutral and the source line stops reading `LIVE CONTROLLER`; the app does not switch
>    to another controller on its own.
> 6. **Reconnect** — reconnect the same controller; note whether Windows restores the same
>    slot (selection re-matches) or a different slot (honest "re-pick" behaviour — the app
>    must not silently pretend it is the same unit).
> 7. **Two identical controllers** (if available) — both appear as separate rows with
>    distinct `SLOT n`; clicking the second selects the second (the live mirror follows the
>    one you clicked, not its twin); the first stays unselected.
> 8. **Duplicate enumeration** — watch for one physical pad showing up twice (XInput +
>    DirectInput). Record whether it appears as one row or two, the `id`/`SLOT` of each,
>    and which one the mirror follows. (This is the known-unsolved case from §5.6.)
> 9. **Selected-controller stability** — once selected, the choice stays put across live
>    input, button presses, and layout changes; it is not stolen by a later-connected pad.
>
> **Input mirroring (visualization only)**
> 10. **Left stick** moves the STR bar and the LEFT stick well dot (steering, X only).
> 11. **Right stick** moves the PAN and TILT bars and the RIGHT stick well dot in X and Y
>     (pan/tilt) — labelled `CAMERA · STICK INPUT`, never "camera aim".
> 12. **Buttons and triggers** — throttle/brake/gears/DRS/boost/overtake light up in the
>     preview and drive THR/BRK; analog triggers register.
> 13. **Profile detection + manual override** — the layout auto-suggests from the pad
>     (DualShock/Xbox); the LAYOUT pills override it manually and the override sticks.
>
> **Responsive layout** (validate at each size; full-screen and windowed)
> 14. **1920×1080, 1600×900, 1366×768, 1280×720** — panels use the horizontal space; text
>     is comfortably readable; the right-stick graphic and CAMERA MODE section fit; setup
>     navigation is reachable; `START / START ANYWAY / CHANGE SETUP / BACK / NEXT` never
>     overlap; short layouts **scroll** rather than clip; the pinned team-radio / footnote
>     never covers the controls.
> 15. **Full-screen and F11** — toggle full-screen / F11 at each size; confirm no clipping
>     or overlap appears or disappears wrongly.
>
> **CAMERA MODE**
> 16. **Manual mode available** — `MANUAL · RIGHT STICK` is selectable and selected.
> 17. **Head Tracking locked** — the card is visible, dimmed, `LOCKED · SAFETY GATE NOT
>     COMPLETE`, not clickable, never becomes selected.
> 18. **Active authority not reported** — the ACTIVE AUTHORITY line reads `NOT REPORTED BY
>     MAPPER` (muted), distinct from the AVAILABLE/REQUESTED setup-default line.
> 19. **Proof no UI interaction changes mapper authority** — with the mapper running,
>     click the Manual card and the (locked) Head Tracking card; confirm the mapper's
>     selected source / CRSF output does **not** change as a result (cross-check against
>     Prompt 2's mapper observation). The ground station has no mode-request path.
>
> Report: per-step PASS/FAIL, screenshots at all four sizes, the `Gamepad.id` strings seen,
> the duplicate-enumeration outcome, and any case where transport was shown as anything
> other than UNKNOWN or where a UI action affected the mapper.

---

## Prompt 2 — Mapper Bluetooth validation (elrs-joystick-control, observation only)

> You are validating **elrs-joystick-control** (the mapper) on Windows, **without modifying
> its source**. Goal: confirm what the mapper actually detects and binds, so the ground
> station's display can be cross-checked against the real control authority. Do not enable
> any active head-tracking and do not do any U4 (head-intent shaping/arbitration) work —
> observation only. Capture the mapper's own diagnostics/node-graph as evidence.
>
> 1. **SDL detection over USB and Bluetooth** — connect a DualShock 4 first by USB, then by
>    Bluetooth; confirm the mapper (via SDL) detects it in each case; record the device
>    name/index SDL reports and whether SDL distinguishes the transport.
> 2. **Raw axis / button numbering** — record the raw SDL axis and button indices the
>    mapper sees (so the ground station's preset map — steer=axis 0, pan=axis 2, tilt=axis 3
>    — can be checked against the real numbering).
> 3. **Right-stick axes** — identify which raw axes move for right-stick X (pan) and Y
>    (tilt); confirm they match what the ground station mirrors.
> 4. **Live node-graph bindings** — with the mapper's graph running, confirm the stick →
>    CRSF-channel bindings are live and which channels the right stick drives.
> 5. **Disconnect / reconnect** — disconnect and reconnect the controller; record how the
>    mapper handles it (re-detect, re-bind, slot/index changes).
> 6. **Duplicate device behaviour** — if the pad enumerates twice (XInput + DirectInput) or
>    two identical pads are present, record how SDL/the mapper enumerates and which it binds.
> 7. **Electron visualization agrees with mapper observation** — move each stick/button and
>    confirm the ground station's SEAT FIT mirror agrees with what the mapper observes for
>    the same physical input (same stick → same axis motion). Note any disagreement.
> 8. **No active head-tracking / no U4** — confirm nothing in this session enables active
>    pan/tilt or head-intent shaping; W3 stays log-only; the mapper's authority is
>    unchanged by anything the ground station displays.
>
> Report: SDL device names/indices, raw axis/button numbering, right-stick axis mapping,
> the live bindings, disconnect/reconnect + duplicate behaviour, and a clear
> agree/disagree verdict between the Electron visualization and the mapper's observation.
