# Video topology — approved Batch 0 baseline (owner decision, 2026-07-14)

**Status: documentation of an owner decision. Verification is hardware work (Codex
Batch 0 on the camera + iPhone, with a Windows-side check); nothing here changes code or
camera configuration.**

## The approved baseline to verify

One camera, one encoder configuration, two simultaneous consumers:

1. **Codec/mode: H.264, 1280×720, 60 fps** (single encoder configuration).
2. **iPhone path: direct low-latency H.264 RTP/UDP unicast to the iPhone, if the camera
   supports it.**
3. **Windows path: RTSP retained simultaneously** for the existing
   MediaMTX → WebRTC/WHEP viewer path (`docs/SETUP.md` §1–3).
4. **Simultaneous usable video on BOTH iPhone and Windows is required** — not an
   optimization, part of the baseline.

Why this shape: Chromium/Electron WebRTC cannot decode H.265 (`docs/SETUP.md` §1), the
iPhone decodes H.264 in hardware, and 60 fps at 720p favors the VR latency/comfort target
over resolution.

## If the exact baseline is not supported

**Report the measured limitation and return the trade-off to the owner.** Do not silently
substitute any of the following, each of which was explicitly considered and NOT approved
as a default:

- iPhone-over-RTSP instead of direct RTP;
- H.265-only operation;
- RTP-push-only operation (dropping the Windows RTSP path);
- "selected receiver" operation (operator picks iPhone *or* Windows).

Any of these may end up chosen — but only as a documented owner decision against measured
evidence, not as a Batch 0 convenience.

## Dual-stream remains an experiment only

If this camera build supports dual encode (**H.265 main stream to the iPhone + H.264
substream to Windows**), it may be *tested* as an experiment. It must not replace the
approved baseline without measured evidence and an owner decision.

## Who verifies what

- **Codex (Batch 0):** record the exact Greg/OpenIPC settings (resolve the "64/65" and
  "RTP/RTPS" labels precisely), capture real packets on the iPhone, measure whether
  unicast RTP to the iPhone and the RTSP serve can run simultaneously without degrading
  either consumer. The Codex handoff item for this is H1 in
  `../../_handoff/2026-07-14_codex_handoff_vr_fpv_cross_review.md`.
- **Windows side (this repo):** with the camera in the baseline configuration, confirm
  the existing RTSP → MediaMTX → WHEP path still plays (no code change expected;
  `mediamtx.yml` stays localhost-only per `docs/iphone_bridge_readiness.md` §5).

Cross-links: `docs/SETUP.md` (codec gate, stream URL, WHEP),
`w17-control-fw/project-review/head_tracking_unlock_plan.md` (unlock sequencing),
`docs/camera_aim_display_semantics.md` (display semantics).
