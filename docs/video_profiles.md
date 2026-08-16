# Video profiles — DRIVE / SHOWPIECE (vision decision 7)

Two **configurable** presets through the ground-station side of the video chain
(camera → mediamtx → WebRTC/WHEP → HUD `<video>`), closing the audit finding
"single fixed mediamtx path, WHEP pinned to min latency":

| Profile | Operator wording | Intent |
|---|---|---|
| `drive` | **RACING FEEL · instant** | lowest glass-to-glass latency; the profile the car is driven on |
| `showpiece` | **CINEMA LOOK · smoother** | best/smoothest picture for spectators; pays deliberate buffering latency |

Definitions live in **one module**, `shared/videoProfiles.mjs` — the renderer
reads the player half, `main.js` dynamic-imports the mediamtx half, and both
switch surfaces render their wording from it, so the two sides of the chain can
never carry different presets. Only the profile **id** is persisted
(`settings.json → {video:{profile}}`, conditional subtree like `wheel` /
`lowBattery`); knob values always come from the current code, so retuning a
profile never fights stale numbers on disk.

**DRIVE is defined as "today", byte for byte.** It carries an empty mediamtx
override set (the checked-in `mediamtx/mediamtx.yml` + pinned v1.9.3 defaults
are exactly the pre-profile tuning) and player knobs equal to the WHEP client's
own defaults. `test/videoProfiles.test.js` pins this at the real seams: the
supervisor spawn options with DRIVE are strict-equal to the historical literal
(no `env` key at all), and `VIDEO_PROFILES.drive.player` strict-equals
`WHEP_PLAYER_DEFAULTS`, which strict-equals the historical
`{playoutDelayHintS: 0, jitterBufferTargetMs: null, retryMs: 1500}`.

## Knob table

### mediamtx side (applied as `MTX_*` env vars on the supervised process)

mediamtx gives environment variables precedence over the YAML, so the
checked-in `mediamtx.yml` stays the single operator-editable base config and a
profile is a pure overlay. Key names are valid for the pinned **v1.9.3**
(`scripts/fetch-mediamtx.js`).

| Knob | DRIVE | SHOWPIECE | What it does / why |
|---|---|---|---|
| `MTX_PATHS_CAM_RTSPTRANSPORT` | *(unset — automatic)* | `tcp` | Camera→mediamtx RTSP ingest transport. TCP cannot lose RTP packets on the 5.8 GHz link — packet loss mid-GOP is what smears/blocks the picture, so this is the biggest GS-side image-quality lever. Cost: retransmit head-of-line blocking adds jitter/latency under loss, which SHOWPIECE accepts (the player buffer absorbs it). **BENCH-TBD (CB5):** confirm the OpenIPC camera serves interleaved RTSP/TCP alongside its other consumers. |
| `MTX_WRITEQUEUESIZE` | *(unset — 512)* | `1024` | Per-connection outbound packet queue toward the WHEP viewer. Doubling it absorbs the large I-frame bursts of a quality-tuned encoder instead of dropping; memory cost trivial on the GS; must be a power of two (mediamtx validates). **BENCH-TBD (CB5):** right-size against the camera's real bitrate/GOP. |

### Player side (renderer/whep.js, per-connection)

| Knob | DRIVE | SHOWPIECE | What it does / why |
|---|---|---|---|
| `playoutDelayHintS` | `0` | `0.3` | Receiver playout-delay hint (seconds, legacy spelling). 0 = render ASAP (FPV latency); 0.3 = deliberate smoothing buffer for spectators. **BENCH-TBD (CB5):** tune against measured link jitter; 300 ms is the defensible start, not a measured optimum. |
| `jitterBufferTargetMs` | `null` *(untouched)* | `300` | The current standard spelling of the same intent (milliseconds). DRIVE leaves the property alone exactly like the pre-profile client; SHOWPIECE states 300 ms in both spellings (pinned equal: `0.3 s == 300 ms`). |
| `retryMs` | `1500` | `1500` | Reconnect pacing after a drop/failed connect. **Deliberately identical**: pacing is outage recovery, not picture quality; carried per-profile so a bench pass *can* split them, with no invented difference today. |

## Switch points

- **GARAGE · VIDEO STYLE** — giftee-facing pill pair (`RACING FEEL · INSTANT` /
  `CINEMA LOOK · SMOOTHER`) with a plain-language note.
- **⚙ RACE OPS · VIDEO STYLE** — the same choice mid-session, as a select.

Both run the same routine: persist the whole `{video:{profile}}` subtree →
`session:apply` (main re-keys the mediamtx supervisor) → reconnect the WHEP
player with the new knobs. No new IPC/preload surface: the existing
`settings:set` / `session:apply` channels carry it, and the renderer reads the
profile definitions directly from the shared module.

## What live-applies vs. what restarts

A profile switch is **never seamless**, and the UI says so on every surface
(`VIDEO_PROFILE_RESTART_NOTE`: "switching restarts the video feed — the
picture is back in a few seconds"):

- **mediamtx half — restart.** The supervisor is held in a keyed instance
  (`main.js`), keyed on the profile's mediamtx config: an unchanged profile
  re-applies as a no-op (GRID re-entry never blinks video); a change stops the
  old process and spawns a fresh one with the new `MTX_*` env — the cleanest
  restart the existing code offers (env cannot be changed on a live process).
- **player half — reconnect.** `hud.js applyVideoProfile()` stops the WHEP
  session and reconnects with the new knobs; receiver hints are per-connection,
  so a reconnect is the honest way to apply them.
- **Recovery is automatic.** The WHEP client's existing auto-retry rides
  through the mediamtx respawn; the HUD's video-state model shows the truthful
  CONNECTING/STALLED phases while it happens, and VIDEO LOCK only returns green
  when frames actually flow.
- Re-selecting the already-active profile is **inert** at every level (UI
  guard, hud.js id check, keyed mediamtx instance) — no false restarts.

## Bench-TBD (CB5) checklist

The camera does not exist on the bench yet, so these are marked in the module
and must be validated when CB5 unblocks:

1. Camera serves RTSP over interleaved TCP (SHOWPIECE ingest) concurrently with
   its other consumers (iPhone RTP path — `docs/video_topology_baseline.md`).
2. 300 ms playout target vs. the measured link-jitter distribution (tune, don't
   assume).
3. `writeQueueSize 1024` vs. the camera's real bitrate/GOP burst size.
4. Whether DRIVE wants a *sub*-default write queue once real latency is
   measured (not pre-tuned: DRIVE stays byte-for-byte today until measurements
   justify touching it).

## Deliberately out of scope: camera-side knobs

Encoder bitrate, GOP length, resolution/framerate and codec live **on the IP
camera** (OpenIPC/majestic config) and shape both profiles upstream of this
repo. They are out of scope here because the camera hardware is CB5-gated —
there is nothing to configure or verify yet. When the camera lands, per-profile
camera settings (if any) belong to the camera bring-up work, not to
`shared/videoProfiles.mjs`; the GS profiles were designed to be defensible
against a *single* fixed camera configuration (the approved Batch 0 baseline:
H.264 1280×720@60).

## Safety scope

Profiles change how the already-published camera stream is relayed and
rendered — nothing here touches control, CRSF, the gimbal, or any iPhone path,
and no new IPC/preload surface exists for it (`test/ipcSurface.test.js`
unchanged).
