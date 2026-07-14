# Camera-aim display semantics — commanded vs measured

**Status: documentation only (2026-07-14). No code, test, or contract change is made by
this file.** This is the ground-station source of truth for what camera pan/tilt values
*mean* wherever this app displays or exports them. The mapper/unlock sequencing lives in
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
depiction convention in `test/padPreview.test.js`) is **deferred** — it is a code+test
change, out of scope for the 2026-07-14 documentation pass. When implemented it must
follow §2.1's labeling rule, and `test/noControlPath.test.js` remains unchanged.

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
