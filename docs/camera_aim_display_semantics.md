# Camera-aim display semantics — commanded vs measured

**Status: §1–§4 are the 2026-07-14 documentation pass (no code/contract change made by
this file). §5 (2026-07-16) records the SEAT FIT controller-mirror / CAMERA MODE slice,
and §6 (2026-07-16) the steering-wheel input mirror (Batch 7) — both implemented in
code+tests elsewhere in this repo. This file remains documentation and changes no
contract.** This is the ground-station source of truth for what camera
pan/tilt values *mean* wherever this app displays or exports them. The mapper/unlock sequencing lives in
`w17-control-fw/project-review/head_tracking_unlock_plan.md`; the bridge contract remains
canonical in `iPhone_rc/docs/windows_bridge_contract.md` with an implementation copy in
`docs/windows_bridge_contract.md` (synced only after canonical revisions are accepted —
two-stage rule, see §4).

## 1. The core fact: nothing measures the gimbal

There is no gimbal position feedback anywhere in the system — not in firmware telemetry,
not on the CRSF uplink, not on the bridge
(`w17-control-fw/project-review/iphone_pan_tilt_firmware_readiness.md §4.6`). Until
physical feedback exists, every pan/tilt number in this app is a **command**, and must be
presented as one.

## 2. Display rules (binding on future UI work)

1. **HUD `camDot` and any future SEAT-FIT pad-preview indicator show the local right-stick
   position** (the display-only gamepad mirror, `renderer/hud.js` `S.camPan`/`S.camTilt`),
   not the camera's aim. Today those coincide because the right stick is the only source.
   In a head-tracking era they will **diverge**: the stick will sit near center while the
   arbitrated command points elsewhere. Label such indicators as stick position
   ("R-STICK"), never as "camera aim".
2. **W2 telemetry `camera_yaw_deg` / `camera_pitch_deg` are commanded/requested mirrors**
   (currently: right-stick mirror × 90° full deflection — see the contract copy's Windows
   appendix), never measured angles. When an active mapper exists, the correct source
   becomes the **mapper's authoritative final commanded value** — a sourcing change inside
   Windows, not a schema change; it must be recorded in the contract copy's appendix only
   after the corresponding canonical revision is accepted (§4).
3. **"Near limit" means command saturation** — the commanded value reached its configured
   cap — not confirmed mechanical contact. Any near-limit warning shown here or forwarded
   to the iPhone HUD must use saturation of the commanded value. *Resolved canonically
   (rev `84532ed`, 2026-07-14): in contract version 1 a coarse near-limit notice may be
   carried only in the existing human-readable `warning` field; receivers must not parse
   it as structured state; no dedicated near-limit field exists, and adding one requires
   a canonical schema/example revision plus Windows mirror.*
4. **Recenter displays/uses the mapper's authoritative final commanded value.** CRSF 992
   is an authoritative *commanded* center; its physical safety still requires the
   blocker-1 mechanical validation (`head_tracking_unlock_plan.md §1.3`).
5. `head_tracking_mode` continues to report the actual authority (`DS4` today;
   `HEAD_TRACKING`/`MIXED` only when an approved mapper is actually the source).

## 3. Electron process boundary (restated for display work)

The Electron app is **viewer / configuration / visualization / log-only**. The proposed
active mapper is **elrs-joystick-control**, not this app
(`head_tracking_unlock_plan.md §2`). If/when the mapper exposes diagnostics (state,
packet age, arbitration source, commanded values), this app may **render** them via a
one-way inbound stream — it must never send anything to the mapper, and the launch-only
property of `main/elrsLauncher.js` (pinned by `test/noControlPath.test.js`) is untouched.

Note: the planned pad-preview right-stick indicator (authorized relaxation of the
depiction convention in `test/padPreview.test.js`) was **implemented on 2026-07-16**
— see §5 — following §2.1's labeling rule. `test/noControlPath.test.js` is unchanged,
and no outbound control/RPC path was added.

## 4. Contract synchronization is two-stage (do not shortcut)

1. Claude produces a Codex handoff for any iPhone-side/canonical change
   (current one: `../../_handoff/2026-07-14_codex_handoff_vr_fpv_cross_review.md`).
2. Codex updates the canonical contract in `iPhone_rc`.
3. Only then does this repo mirror the accepted canonical revision into
   `docs/windows_bridge_contract.md`.
4. Both sides record the canonical revision/commit used for the sync.

Mirror debt **resolved 2026-07-14**: Codex applied handoff items H1–H11 in canonical
revision `84532ed870ee9dc4563217a78ae112ccd0f1c8f6` ("Consolidate VR FPV integration
plans"), and this repo's `docs/windows_bridge_contract.md` was re-mirrored from exactly
that revision (sections 1–7 + Discovery byte-identical; Windows appendix retained).
`84532ed` is the recorded sync revision on both sides.

## 5. SEAT FIT controller mirror + CAMERA MODE (implemented 2026-07-16)

This section records the SEAT FIT slice that implemented §2.1's deferred right-stick
indicator, added a live controller mirror, an input-source/transport line, a CAMERA
MODE section, session-stable controller identity, and a responsive setup layout. It is
**display-only**: no IPC/RPC was added, `test/noControlPath.test.js` is unchanged, and
the preload surface is byte-for-byte the reviewed one (pinned by `test/ipcSurface.test.js`).

### 5.1 Root cause — why the right stick was "missing"

The SEAT FIT pad preview (`renderer/padPreview.js`) intentionally omitted the right
stick under the **older depiction convention** (the earlier `test/padPreview.test.js`
banned drawing pan/tilt so a right-stick drawing could not become a control foothold).
Meanwhile the live HUD (`renderer/hud.js`) already mirrored the right stick — gamepad
axes 2/3 → `S.camPan`/`S.camTilt` → the `camdot`. So the stick was never absent from the
app; only the SEAT FIT teaching preview left it out, which read as an inconsistency.

### 5.2 The reviewed relaxation

SEAT FIT **may** now show right-stick input, but it **must not** describe it as measured
camera aim. Both sticks are drawn as **STICK INPUT** (the right one explicitly labelled
`CAMERA · STICK INPUT`, coloured violet, not the teal used for commanded/telemetry
values), per §2.1. `test/padPreview.test.js` pins that the rendered text never claims
"camera aim", "measured", or "gimbal", and that the stick dots carry `data-stick` (never
`data-role`) so they can never enter the button press-mirror seam.

### 5.3 Actual data source vs. actual authority

- **Data source (this app):** the browser `navigator.getGamepads()` snapshot, read for
  DISPLAY only. Steering, pan, tilt, and pressed buttons are read through the chosen
  layout preset and mirrored on screen. That is the app's *only* input.
- **Control authority (not this app):** the **mapper / SDL** (elrs-joystick-control),
  which reads the pad itself and produces CRSF. Electron **observing** a stick is not the
  mapper **selecting** it. This viewer does not observe the mapper's selection at all.

### 5.4 CAMERA MODE — AVAILABLE/REQUESTED vs. ACTIVE AUTHORITY

`shared/cameraMode.mjs` keeps two ideas strictly apart (pinned by `test/cameraMode.test.js`
and the DOM tests in `test/setupFlowDom.test.js`):

- **AVAILABLE / REQUESTED** is the setup default (`MANUAL · RIGHT STICK`) — clearly
  marked as the setup default, never as a verified live fact. **Manual is the only
  available/selectable mode.**
- **HEAD TRACKING is visible but LOCKED** — the safety gate is not complete (parent
  `CLAUDE.md`; W3 is log-only). The locked card carries no click handler that can change
  the mode, and selecting it is impossible (the model coerces any unknown/locked request
  back to Manual).
- **ACTIVE AUTHORITY is `NOT REPORTED BY MAPPER`.** Current mapper diagnostics do not
  report who is actively aiming the camera, and this viewer never fabricates it — not from
  the browser seeing a stick, not from the requested mode, and never from W3 (log-only).
  The model exposes an optional trusted-source input so a *future* mapper-diagnostics feed
  could populate it; absent that, it stays unreported (rendered muted, not the teal
  "confirmed value" colour). There is **no** `headtrackArmed`-style property asserting a
  live state the renderer cannot know.
- **No outbound control path.** Neither card touches `groundStation`/`gs`; there is no
  mode-request RPC in the preload surface and none was added. `canEmitControl: false` is a
  tested invariant of the pure model.

### 5.5 Transport is UNKNOWN; Bluetooth is OS-paired; Windows validation still required

The browser Gamepad API exposes no reliable USB-vs-Bluetooth field, so the input-source
line **always** reads `TRANSPORT UNKNOWN` — it is never guessed (e.g. the string "Wireless
Controller" in a `Gamepad.id` is **not** treated as Bluetooth). Pairing is done in the
operating system; if Chromium recognizes the pad it appears without a restart. **Real
Windows Bluetooth behaviour has not been validated** — the SEAT FIT wording says so, and
Windows validation remains a required, separate step (see the Windows handoff prompt). A
transport value could later come from a trusted mapper/SDL diagnostics source (the
mapper's authority, not this viewer's), never from the Gamepad API.

### 5.6 Controller identity — limitation, not a solved problem

Selection uses a **session-stable key = slot index + `Gamepad.id`** (`gamepadKey`,
`resolveSelectedPad` in `shared/inputPresets.mjs`):

- two identical controllers (same id, different slot) stay **independently selectable**;
  a click selects exactly one; the on-screen `SLOT n` tells identical rows apart;
- a duplicate reference to the **same** slot collapses to one row;
- disconnecting the **selected** device invalidates it (the mirror goes neutral) — it
  **never** auto-switches to an identical peer;
- reconnect at the **same** slot re-matches; reconnect at a **different** slot is treated
  honestly as missing (re-pick), because the OS may reassign the slot.

**Limitation (do not claim solved until Windows validation):** Chromium may expose one
physical controller through multiple Windows backends (XInput + DirectInput) as two slots
with the same id, and provides no universally reliable hardware identity. The session key
is therefore **not** persisted as if it pinned a specific unit — only the **model id** is
persisted (for layout auto-detect and the live-HUD's best-effort model-id matching).
Identical devices are not distinguishable across restarts without a stable hardware id.

### 5.7 Responsive layout

`renderer/hud.css` makes the setup screens fill the horizontal space with readable caps
(`min(…ch, …vw)` widths), collapses the two-column SEAT FIT / PIT WALL steps via a
`grid auto-fit` (no hard pixel breakpoint), lets the overlay **scroll instead of clip** on
short viewports (`overflow-y:auto` + `justify-content:safe center`), wraps the action rows
so `START / START ANYWAY / CHANGE SETUP / BACK / NEXT` never collide, raises font-size
clamp floors for readability, and reserves bottom padding so the pinned team-radio /
footnote overlays never cover the controls. Contract tests live in
`test/responsiveLayout.test.js`; DOM tests cannot prove *physical* overlap, so
**pixel-level visual validation at 1920×1080 / 1600×900 / 1366×768 / 1280×720 remains a
manual step on Windows** (see the Windows handoff prompt).

## 6. Steering-wheel input mirror (implemented 2026-07-16, Batch 7)

The optional steering-wheel support (SEAT FIT input type GAMEPAD / WHEEL / BOTH, chosen
per session) extends the SAME display-mirror semantics to a wheel; it introduces **no new
meaning** and **no new control path**. It is DISPLAY-ONLY: no IPC/RPC was added (the
preload surface stays the pinned 24-method contract, `test/ipcSurface.test.js`),
`test/noControlPath.test.js` is unchanged, and the wheel modules (`shared/wheelProfile.mjs`,
`renderer/wheelPreview.js`, `renderer/hud.js`) carry none of the forbidden control
vocabulary.

### 6.1 The wheel is an input mirror, using the same vocabulary

- The SEAT FIT wheel viz (`renderer/wheelPreview.js`) shows **observed wheel input** — a
  steering needle and calibrated pedal-travel bars — under the header **`OBSERVED WHEEL
  INPUT · NOT PROOF OF CAR / CAMERA MOTION`**. Like the pad preview it says **input**,
  never **"camera aim" / "measured" / a gimbal position**. A wheel has no aim stick, so it
  makes no camera-motion claim at all.
- On the live HUD (`renderer/hud.js`), a wheel/both session mirrors the wheel for
  **steering / throttle / brake ONLY** (`wheelValues(pad, profile)`). These feed the same
  command widgets the gamepad drives — a mirror of the driver's input, not a car-side
  measurement. Driving still comes from elrs-joystick-control, which reads the device
  itself; this app only observes it.

### 6.2 Pan/tilt stays gamepad-only — camera-aim semantics untouched

Camera **pan/tilt is never wheel-sourced**. The camera dot keeps reading the gamepad right
stick (`S.camPan`/`S.camTilt`) under every input type, exactly as §2.1 requires; a GAMEPAD
session is bit-identical to before, and the wheel override touches only STR/THR/BRK. So all
of the §5.4 invariants stand unchanged: **Head Tracking is LOCKED**, **ACTIVE AUTHORITY is
`NOT REPORTED BY MAPPER`**, and this viewer never fabricates an active aiming source — the
mapper remains the camera authority, and the browser observing a wheel or a stick is not the
mapper selecting one.

### 6.3 Activation is per-session; only calibration persists

The input type **always boots GAMEPAD** and is never persisted (a fresh load starts on
GAMEPAD even with a saved wheel profile). Only the calibrated `wheel.profile` persists,
through the existing `settings:set` path (`{ wheel: { profile } }`) — no new key. The wheel
device selection uses the same **session-stable key (slot + `Gamepad.id`)** as the gamepad
mirror, so the identical-device / slot-reassignment limitation documented in §5.6 applies
equally to the wheel; it is not persisted as a hardware identity.
