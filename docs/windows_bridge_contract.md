> **This document is the Windows implementation copy of the iPhone bridge contract.
> The iPhone app is the client; Windows must conform to this packet shape.**
>
> The authoritative long-term contract lives with the iPhone app, at
> `iPhone_rc/docs/windows_bridge_contract.md` (plus its `schemas/*.schema.json`
> and `examples/*.json`) — the iPhone parser is the compatibility constraint, so
> the contract versions with it. Sections 1–7 below reproduce that document
> verbatim; keep them re-synced when the iPhone repo revs. The final appendix
> ("Windows implementation notes") records how *this* repo implements the Windows
> side — it adds no requirements and must never contradict the sections above.
> This copy supersedes the earlier camelCase/port-48017 draft that previously
> lived in this file (W1); that draft is obsolete.
>
> **Sync record:** mirrored 2026-07-14 from canonical revision
> `84532ed870ee9dc4563217a78ae112ccd0f1c8f6` ("Consolidate VR FPV integration
> plans", `iPhone_rc` branch `main`). The previous mirror was the 2026-07-08
> canonical; this revision brings in the Discovery (Bonjour/mDNS) section
> (canonical 2026-07-10) and the 2026-07-14 plan-consolidation clarifications
> (handoff items H1–H11: approved video baseline, mapper host =
> owned/forked `elrs-joystick-control`, commanded-mirror camera telemetry,
> 299/300/301 ms stale boundary, ≤250 ms future motion-sample freshness,
> warning-field near-limit notice).

# W17 iPhone <-> Windows Bridge Contract

Last updated: 2026-07-14

This document defines the W17 integration contract between the existing iPhone FPV HUD / head-tracking app and the future Windows ground-station bridge.

This is a documentation contract only. It does not authorize active camera pan/tilt mapping, CRSF channel output, servo movement, vehicle movement, firmware changes, or APFPV video decoding.

## Authority And Scope

The Windows ground station remains the control authority. The iPhone is a thin companion client.

Hard boundaries:

- The iPhone sends head-tracking intent only.
- Windows initially logs iPhone head-tracking only.
- Windows must not forward iPhone head-tracking to CRSF channels, servos, gimbal, ESC, or vehicle control in the first bridge milestone.
- Windows may later map validated intent to camera pan/tilt only after a separate safety milestone. The intended production mapper host is an owned/forked `elrs-joystick-control`; Electron remains viewer/configuration/logging only.
- The iPhone receives normalized telemetry snapshots from Windows.
- The iPhone must not parse raw CRSF.
- Firmware must not parse iPhone JSON.
- Firmware must not receive iPhone UDP.
- APFPV/OpenIPC video is a separate path and must not be coupled to telemetry or head-tracking authority.

Related documents:

- `docs/PROTOCOL_CONTRACT.md`
- `schemas/telemetry_snapshot.schema.json`
- `schemas/head_tracking_packet.schema.json`
- `examples/telemetry_snapshot.example.json`
- `examples/head_tracking_packet.example.json`
- `docs/WINDOWS_BRIDGE_INTEGRATION_PLAN.md`
- `docs/FUTURE_HEAD_TRACKING_TO_PAN_TILT_SAFETY.md`
- `docs/FIRST_ACTIVE_PAN_TILT_MILESTONE.md`

## 1. Data Paths

### Windows To iPhone: Telemetry Snapshot

```text
Car / ELRS / CRSF telemetry
  -> Windows decode / merge / normalize
  -> UDP JSON telemetry snapshot
  -> iPhone HUD
```

Purpose: give the iPhone a display-safe, normalized snapshot for the HUD.

The Windows bridge owns raw telemetry decoding and normalization. The iPhone receives only the normalized UDP JSON snapshot.

### iPhone To Windows: Head-Tracking Intent

```text
iPhone Core Motion / mock motion
  -> iPhone calibration and send gating
  -> UDP JSON head-tracking intent
  -> Windows validation / stale tracking / logging
  -> no control output in first bridge milestone
```

Purpose: provide optional camera-look intent to Windows for logging now and possible future pan/tilt arbitration later.

### Future Video Path

Preferred low-latency video path remains independent:

```text
APFPV/OpenIPC camera — approved baseline H.264 1280×720 60 fps
  -> RTP/UDP unicast -> iPhone receiver / depacketizer / decoder
  -> retained RTSP -> Windows MediaMTX/WHEP viewer
  -> simultaneous usable video on both clients
```

Windows does not forward or re-encode the preferred iPhone path. APFPV diagnostics are packet-statistics only until the native decoder milestone. If hardware cannot sustain the baseline on both clients, the limitation must be escalated; it must not silently become H.265-only, RTP-push-only, or single-receiver behavior. Video remains outside the W2/W3 schema and authority paths.

### Forbidden Path

There must be no iPhone-to-firmware data path:

```text
iPhone -> firmware JSON/UDP/CRSF: forbidden
```

Firmware should only ever see final, already-arbitrated control channels from the existing Windows/control chain in a later milestone.

## Discovery

Discovery is an addressing convenience for the Windows -> iPhone W2 telemetry stream. It does not add control authority, does not carry telemetry, does not carry head-tracking packets, and does not create any iPhone -> firmware path.

The iPhone HUD may advertise its telemetry receive address with Bonjour/mDNS while the app is foregrounded and its UDP telemetry receiver is listening.

Canonical service definition:

| Item | Value |
| --- | --- |
| Service type | `_w17hud._udp.local.` |
| Instance name | `W17 HUD (<device name>)` |
| SRV port | The iPhone app's W2 telemetry listen port, default `5601` |

TXT record keys:

| Key | Example | Meaning |
| --- | --- | --- |
| `v` | `1` | Discovery/bridge contract version |
| `role` | `hud` | Advertiser role; receivers should ignore unknown roles |
| `tport` | `5601` | Telemetry listen port; mirrors the SRV port |
| `feat` | `w2` or `w2,w3` | Supported bridge features; `w3` means the app can emit head-tracking intent packets when separately configured and safely gated |
| `dev` | `Vitaliy iPhone` | Short printable ASCII user-facing device label |

Current iPhone advertisement:

- Service type: `_w17hud._udp.local.`
- Instance name: `W17 HUD (<short device name>)`.
- SRV port: current telemetry receive port from app settings, default `5601`.
- TXT: `v=1`, `role=hud`, `tport=<telemetry port>`, `feat=w2,w3`, `dev=<short printable ASCII device name>`.

Receiver behavior:

- Discovery is advisory only.
- Receivers must treat advertisements as user-confirmed hints, never as authority.
- Windows may show discovered HUDs as candidate telemetry destinations, but the user should confirm the destination before Windows sends telemetry there.
- Reachability/config checks remain the ground truth for whether telemetry is actually flowing.
- A spoofed or stale advertisement must not affect vehicle control, head-tracking authority, CRSF output, servo output, firmware behavior, or failsafe behavior.

Lifecycle:

- The iPhone should advertise only while the app is foregrounded and the UDP telemetry receiver is listening.
- The iPhone should withdraw the advertisement when the app backgrounds, when telemetry receive is stopped, or when demo-only mode stops the UDP telemetry receiver.
- The advertisement's SRV port and `tport` TXT value must match the actual telemetry listen port.

Versioning:

- Adding new TXT keys is backward-compatible for version `1`; receivers must ignore unknown TXT keys.
- Changing the service type, changing existing key meanings, or changing compatibility expectations requires bumping `v`.
- Future Codex and Windows sessions must not invent discovery fields casually; changes should update this canonical contract first and then be mirrored into the Windows implementation copy.

## 2. Telemetry Snapshot Contract

Direction: Windows -> iPhone.

Transport: UDP JSON.

Default port: `5601`.

Schema: `schemas/telemetry_snapshot.schema.json`.

Current protocol version: `1`.

For version 1, `protocol_version` is recommended but optional for compatibility. If omitted, receivers should treat the packet as version 1 during bench testing.

### Recommended JSON Shape

```json
{
  "protocol_version": 1,
  "timestamp_ms": 12345678,
  "battery_v": 14.8,
  "link_quality": 92,
  "rssi_dbm": -62,
  "snr_db": 18,
  "speed_kmh": 12.4,
  "gear": 3,
  "drive_mode": "GEARBOX_ERS",
  "ers_percent": 55,
  "throttle": 0.43,
  "brake": 0.0,
  "steering": -0.15,
  "camera_yaw_deg": -12.0,
  "camera_pitch_deg": 5.0,
  "head_tracking_mode": "OFF",
  "video_lock": true,
  "warning": "",
  "stale_data_warnings": []
}
```

### Field Definitions

| Field | Required for full snapshot | Unit | Valid range / values | Unknown/null behavior |
| --- | --- | --- | --- | --- |
| `protocol_version` | Recommended | integer | `1` | Missing means version 1 for bench compatibility |
| `timestamp_ms` | Yes | milliseconds | `>= 0` | Should not be null in full snapshots |
| `battery_v` | Yes | volts | `>= 0` | If unknown, omit in partial/test packets or mark stale; do not send old value as fresh |
| `link_quality` | Yes | percent | `0...100` | If unknown, omit in partial/test packets or mark stale |
| `rssi_dbm` | Yes | dBm | integer | If unknown, omit in partial/test packets or mark stale |
| `snr_db` | Yes | dB | number | If unknown, omit in partial/test packets or mark stale |
| `speed_kmh` | Yes | km/h | `>= 0` | Do not use `0` to mean unknown unless Windows knows the car is safely stopped |
| `gear` | Yes | gear index | integer `>= 0` | Use `0` or omit only if defined as unknown by Windows UI/contract |
| `drive_mode` | Yes | enum | `TRAINING`, `GEARBOX`, `GEARBOX_ERS`, `UNKNOWN` | Use `UNKNOWN` when unavailable |
| `ers_percent` | Yes | percent | `0...100` | If unknown, omit in partial/test packets or mark stale |
| `throttle` | Yes | normalized | `0.0...1.0` | If unknown, omit in partial/test packets |
| `brake` | Yes | normalized | `0.0...1.0` | If unknown, omit in partial/test packets |
| `steering` | Yes | normalized | `-1.0...1.0` | If unknown, omit in partial/test packets |
| `camera_yaw_deg` | Yes | degrees | number | Final commanded/mapped camera yaw mirror; not measured camera aim and not iPhone authority |
| `camera_pitch_deg` | Yes | degrees | number | Final commanded/mapped camera pitch mirror; not measured camera aim and not iPhone authority |
| `head_tracking_mode` | Yes | enum | `OFF`, `DS4`, `HEAD_TRACKING`, `MIXED`, `UNKNOWN` | Use `UNKNOWN` if unavailable |
| `video_lock` | Yes | boolean | `true` / `false` | `false` means no current video lock; it does not prove video path latency |
| `warning` | Optional | string/null | human-readable status | `""` or `null` means no warning |
| `stale_data_warnings` | Optional | array | see below | Empty or missing means no explicit stale subsystem flags |
| `link_state` | Optional | enum | `disconnected`, `connecting`, `connected`, `degraded`, `demo` | Mainly diagnostic/debug |
| `mode` | Optional | enum | `demo`, `udp` | Mainly diagnostic/debug |

Accepted `stale_data_warnings` values:

- `battery`
- `linkQuality`
- `speed`
- `flightMode`
- `camera`
- `video`
- `telemetry`

For version 1, a coarse camera-command saturation/near-limit notice may be carried in the existing human-readable `warning` field. Receivers must not parse `warning` text as structured safety state. No dedicated near-limit field exists in version 1. Adding one requires a deliberate canonical schema/example revision and Windows mirror update.

### Telemetry Source Meaning

Windows should normalize from existing sources, for example:

- CRSF battery frame `0x08` -> `battery_v`.
- Ground TX `LINK_STATISTICS` -> `link_quality`, `rssi_dbm`, `snr_db`.
- CRSF GPS frame `0x02` groundspeed -> `speed_kmh`.
- CRSF FLIGHTMODE frame `0x21`, such as `G3 M2 E55` -> gear, drive mode, ERS/status fields.
- Existing control/mixer state -> `throttle`, `brake`, `steering`.
- Existing final camera/gimbal command state -> `camera_yaw_deg`, `camera_pitch_deg`, `head_tracking_mode`.

`camera_yaw_deg` and `camera_pitch_deg` mirror commanded targets for HUD presentation. They do not prove servo position, mechanism position, successful radio delivery, or camera boresight. A HUD near-limit indication derived from them means command saturation only.

The iPhone must not know or parse those raw upstream protocols.

### Nullable And Unknown Values

The preferred full snapshot is complete and non-null for required fields. For bench compatibility, the current iPhone parser tolerates missing fields and merges partial packets with the previous raw telemetry state.

Safety rule for Windows: do not keep publishing old values as fresh. If Windows loses a source, it should either:

- Stop sending valid snapshots and let the iPhone enter stale/lost state.
- Send explicit warning/status flags and unknown values where the schema supports them.
- Mark affected subsystems in `stale_data_warnings`.

Do not represent unknown speed as `0 km/h` unless Windows explicitly knows the vehicle is stopped.

### Telemetry Freshness And HUD Behavior

The iPhone evaluates telemetry freshness from local receive time:

- Fresh: latest valid packet age `<= about 1 s`.
- Stale: latest valid packet age `> about 1 s` and `<= about 3 s`.
- Lost: latest valid packet age `> about 3 s`.

Fresh telemetry:

- HUD shows actual values normally.

Stale telemetry:

- HUD shows a stale warning.
- Values may remain visible but should be visually degraded/marked stale.

Lost telemetry:

- HUD shows `TELEMETRY DATA LOST >3S` or equivalent.
- HUD must clear unsafe stale values:
  - battery -> `--.- V`
  - LQ -> `--`
  - RSSI -> `--`
  - SNR -> `--`
  - gear -> `--`
  - ERS -> `--`
  - speed -> `-- km/h`
  - source/mode -> `UNKNOWN` or `--`
- HUD may hold only non-authoritative debug metadata if clearly marked stale.

## 3. Head-Tracking Intent Contract

Direction: iPhone -> Windows.

Transport: UDP JSON.

Default port: `5602`.

Schema: `schemas/head_tracking_packet.schema.json`.

Current protocol version: `1`.

The packet is camera-look intent only. It is not a servo command, pan/tilt command, vehicle command, CRSF packet, or firmware packet.

### Current JSON Shape

```json
{
  "seq": 1,
  "timestamp_ms": 12345678,
  "yaw_deg": -12.5,
  "pitch_deg": 6.8,
  "roll_deg": 1.2,
  "tracking_enabled": true,
  "centered": true,
  "timeout_ms": 250
}
```

`protocol_version` is recommended for future compatibility but is not currently emitted by the iPhone app encoder. Windows should treat missing `protocol_version` as version 1 for this bench phase.

### Field Definitions

| Field | Required | Unit | Valid range / values | Behavior |
| --- | --- | --- | --- | --- |
| `protocol_version` | Recommended | integer | `1` | Missing means version 1 during bench phase |
| `seq` | Yes | count | integer `>= 0` | Monotonic diagnostics; wrap/restart should be logged, not fatal |
| `timestamp_ms` | Yes | milliseconds | integer `>= 0` | Packet send timestamp for diagnostics; it is not motion-sample time and receive time remains stale authority |
| `yaw_deg` | Yes | degrees | finite number; schema range `-360...360` | Centered iPhone yaw intent |
| `pitch_deg` | Yes | degrees | finite number; schema range `-180...180` | Centered iPhone pitch intent |
| `roll_deg` | Yes | degrees | finite number; schema range `-180...180` | Diagnostic only initially; ignore for pan/tilt |
| `tracking_enabled` | Yes | boolean | `true` / `false` | User/app tracking intent state |
| `centered` | Recommended | boolean | `true` / `false` | Must be true before any future active mapping |
| `timeout_ms` | Recommended | milliseconds | `1...5000`, app default `250` | Diagnostic sender hint only; it cannot weaken the canonical receiver threshold |

### Current Axis Conventions

Current iPhone implementation:

- Uses CoreMotion `CMMotionManager` device motion with `.xArbitraryCorrectedZVertical` on real iPhone.
- Uses simulator/mock yaw, pitch, and roll values in degrees on Simulator.
- Sends centered deltas after the user presses Center/Calibrate.
- `yaw_deg`, `pitch_deg`, and `roll_deg` are iPhone-attitude-derived intent values, not direct pan/tilt output values.

Current assumptions that must remain diagnostic until real iPhone validation:

- Positive/negative yaw sign is whatever CoreMotion reports in the mounted phone orientation.
- Positive/negative pitch sign is whatever CoreMotion reports in the mounted phone orientation.
- Roll is recorded for diagnostics only and should be ignored for initial pan/tilt mapping.
- Mount orientation and sign flips are not validated yet.

Future mapping may use:

- yaw -> pan
- pitch -> tilt
- roll ignored initially

But that mapping must not be implemented until the active pan/tilt safety milestone is complete.

### Invalid, Disabled, And Uncentered Behavior

Windows must classify valid packets without treating every packet as usable for control.

Recommended states:

- `disabled`: bridge disabled or socket closed.
- `idle`: no valid packet has been received.
- `inactive`: valid fresh packet with `tracking_enabled=false`.
- `not_centered`: valid fresh packet with `tracking_enabled=true` and `centered != true`.
- `active_log_only`: valid fresh packet with `tracking_enabled=true` and `centered=true`.
- `stale`: no valid packet within timeout.
- `invalid`: malformed or semantically invalid packet received.
- `fault`: configuration/socket/internal bridge error.

First milestone output rule:

| State | Log | CRSF output | Servo/gimbal output |
| --- | --- | --- | --- |
| `disabled` | Optional | No | No |
| `idle` | Yes | No | No |
| `inactive` | Yes | No | No |
| `not_centered` | Yes | No | No |
| `active_log_only` | Yes | No | No |
| `stale` | Yes | No | No |
| `invalid` | Yes | No | No |
| `fault` | Yes | No | No |

### Stale Timeout

Windows should use local receive time as the authority for freshness.

Canonical stale boundary:

- Integer receive age `299 ms`: fresh.
- Integer receive age `300 ms`: fresh.
- Integer receive age `301 ms`: stale.

The packet's `timeout_ms` is a diagnostic hint only. It does not override the `300/301 ms` receive-time boundary, and clock sync between iPhone and Windows must not be required.

Before any future active mapping, the iPhone must also stop packet generation when its underlying Core Motion sample is older than `250 ms`. The current `500 ms` local motion-staleness behavior is log-only and is not acceptable evidence for active use. No sample-age field is added in version 1; adding one later requires a deliberate schema/example/mirror revision.

### Malformed Packet Rejection

Windows must reject malformed or semantically invalid packets without updating the current valid state.

Reject when:

- Packet is not valid JSON.
- Packet is not a JSON object.
- Unsupported `protocol_version` is present.
- Required fields are missing.
- `seq` is not a non-negative integer.
- `timestamp_ms` is not a non-negative integer.
- `yaw_deg`, `pitch_deg`, or `roll_deg` are missing, non-numeric, NaN, infinite, or outside accepted diagnostic range.
- `tracking_enabled` is not boolean.
- `centered`, when present, is not boolean.
- `timeout_ms`, when present, is not a positive integer in the accepted range.

Invalid packets must:

- Increment an invalid packet count.
- Log a concise warning.
- Preserve the last valid packet state separately.
- Never produce control output.

### Sequence And Timestamp Diagnostics

Windows should track:

- Last valid `seq`.
- Sequence gaps.
- Sequence repeats/regressions.
- Packet-rate estimate over roughly one second.
- Sender timestamp delta for diagnostics.
- Receive-time age for safety/stale state.

Sequence regressions may occur on app restart or sender reset. They should be logged as diagnostics, not treated as proof of malicious or unsafe input by themselves.

## 4. Windows Responsibilities

Windows must:

- Own the bridge enable/disable state.
- Own socket configuration and validation.
- Receive iPhone head-tracking UDP JSON packets.
- Validate packet schema and semantics.
- Reject stale, uncentered, disabled, malformed, or invalid packets for any future control use.
- Initially log only.
- Never forward iPhone packets to CRSF/servos/gimbal in the first milestone.
- Never interfere with existing joystick/control flow in the first milestone.
- Publish normalized telemetry snapshots to the configured iPhone IP/port.
- Avoid blocking control loops on UDP send/receive.
- Show/log bridge state, packet age, packet rate, sequence diagnostics, yaw/pitch/roll, `tracking_enabled`, `centered`, valid packet count, invalid packet count, and stale state.
- Treat receive time as stale authority.
- Clear or mark telemetry source data stale rather than forwarding old values as live.
- Later arbitrate with manual/gamepad input only after a separate active pan/tilt safety milestone.
- Own any future operator enable/arm/disarm state.

Windows must not:

- Parse iPhone intent as direct servo angle commands in the first milestone.
- Map iPhone intent to CRSF channels 9/10 in the first milestone.
- Send iPhone JSON to firmware.
- Let a bridge enable switch bypass existing safety/failsafe architecture.
- Treat stale/invalid/uncentered packets as usable control input.

## 5. iPhone Responsibilities

The iPhone app must:

- Treat Windows as the authority.
- Receive telemetry snapshots from Windows only.
- Not parse raw CRSF.
- Gate head-tracking sender by valid settings, tracking enabled state, active motion state, and center/calibration.
- Stop sending when tracking is disabled.
- Stop sending when calibration is reset.
- Require fresh center/calibrate after app restart.
- Send camera-look intent only.
- Include sequence and timestamp diagnostics.
- Expose tracking state, calibration state, packet rate, and sender errors in Debug / Setup.
- Use compact non-technical error labels in Drive mode.
- Show stale/lost telemetry safely.
- Clear unsafe stale telemetry values when data is lost.

The iPhone app must not:

- Claim vehicle authority.
- Send direct car commands.
- Send CRSF.
- Talk directly to firmware.
- Send direct pan/tilt servo commands.
- Treat APFPV video diagnostics as proof of decoded video or latency.

## 6. Firmware Responsibilities

Firmware has no direct responsibility for iPhone integration in the current contract.

Firmware must not:

- Parse iPhone JSON.
- Receive iPhone UDP.
- Trust iPhone packets directly.
- Add an iPhone-specific side channel.

In a future active pan/tilt milestone, firmware should only consume final already-arbitrated control channels from the normal Windows/control chain. The intended mapper host is an owned/forked `elrs-joystick-control`; Electron remains viewer/configuration/logging only. Firmware remains the only producer of physical servo outputs.

## 7. Compatibility Tests

These tests are no-hardware or bench/log-only. They must not command vehicle hardware.

### Fake Windows Telemetry Sender To iPhone

Purpose: prove iPhone UDP telemetry receive and display safety.

Use:

```sh
python3 scripts/send_demo_telemetry.py --host <iphone-or-simulator-ip> --port 5601 --rate 20 --profile normal
```

Expected:

- iPhone shows live telemetry values while packets arrive.
- Packet age updates in Debug / Setup.
- No malformed count increases for valid packets.

Stale/lost test:

```sh
python3 scripts/send_demo_telemetry.py --host <iphone-or-simulator-ip> --port 5601 --drop-after 5 --duration 10
```

Expected:

- Stale warning after about `1 s`.
- Lost warning after about `3 s`.
- Battery, LQ, RSSI, SNR, gear, ERS, speed, and source/mode clear to safe unknown placeholders.

### Fake iPhone Head Tracking To Windows Receiver

Purpose: prove Windows can receive and validate iPhone-shaped intent packets before a real iPhone is available.

Use:

```sh
python3 scripts/send_fake_head_tracking.py --host <windows-host> --port 5602 --duration 5 --rate 30 --pattern sine
```

Expected:

- Windows logs sequence, packet age, packet rate, yaw, pitch, roll, `tracking_enabled`, and `centered`.
- Windows state becomes `active_log_only` for fresh enabled and centered packets.
- No CRSF/servo/gimbal output changes occur.

Uncentered test:

```sh
python3 scripts/send_fake_head_tracking.py --host <windows-host> --port 5602 --duration 5 --uncentered
```

Expected:

- Windows logs `not_centered`.
- No output is produced.

Disabled test:

```sh
python3 scripts/send_fake_head_tracking.py --host <windows-host> --port 5602 --duration 5 --disable-after 2
```

Expected:

- Windows logs transition from active/log-only to inactive.
- No output is produced.

### Malformed Packet Tests

Telemetry malformed test:

```sh
python3 scripts/send_demo_telemetry.py --host <iphone-or-simulator-ip> --port 5601 --malformed
```

Expected:

- iPhone does not crash.
- Malformed count increases.
- Last valid safe display state is not corrupted.

Head-tracking malformed test:

```sh
python3 scripts/send_fake_head_tracking.py --host <windows-host> --port 5602 --malformed
```

Expected:

- Windows rejects the packet.
- Invalid packet count increases.
- Last valid packet state is not replaced.
- No output is produced.

### Stale Timeout Test

Purpose: prove Windows marks head tracking stale when packets stop.

Use:

```sh
python3 scripts/send_fake_head_tracking.py --host <windows-host> --port 5602 --duration 2 --rate 30 --pattern static
```

Expected:

- Windows logs packets while sender runs.
- Boundary tests classify `299 ms` and `300 ms` receive age as fresh and `301 ms` as stale.
- No output is produced before, during, or after stale transition in the first milestone.

### Restart And Calibration Behavior

Purpose: prove iPhone calibration is session-only and sender gating survives restart/reset.

Expected iPhone behavior:

- App restart does not persist calibration as valid.
- Tracking enabled but not centered produces no packets.
- Center/calibrate allows packets only after tracking is enabled and motion is active.
- Reset calibration stops packets again.
- Invalid settings prevent sender start.

Expected Windows behavior:

- Sequence number reset after app restart is logged as a diagnostic.
- Missing packets after app restart become stale.
- New valid centered packets are accepted for logging only.
- No control output is produced.

## Contract Freeze For First Bridge Milestone

The first Windows bridge milestone is complete only when:

- Windows can send normalized telemetry snapshots to iPhone/Simulator.
- Windows can receive iPhone/fake-iPhone head-tracking packets.
- Windows validates schema and semantics.
- Windows rejects malformed packets without replacing valid state.
- Windows classifies `299 ms` and `300 ms` receive age as fresh and `301 ms` as stale.
- Windows shows/logs all required diagnostics.
- iPhone HUD handles stale/lost telemetry safely.
- No iPhone packet affects joystick flow, CRSF output, servos, gimbal, or vehicle behavior.

Anything beyond this, including pan/tilt mapping, requires a separate safety milestone and review.

---

# Appendix: Windows implementation notes (w17-ground-station)

Non-normative. How this repo implements the Windows side of the contract above.

## Configuration (env vars, read in `main/main.js`)

| Env var | Meaning | Default |
|---|---|---|
| `W17_IPHONE_BRIDGE` | master enable; `1` turns the telemetry sender on | **unset = off** (no socket created; app unchanged) |
| `W17_IPHONE_ADDR` | iPhone/Simulator IPv4 address (static; no discovery) | none (required when enabled) |
| `W17_IPHONE_PORT` | destination UDP port | `5601` (contract §2) |
| `W17_IPHONE_RATE_HZ` | snapshot send cadence | `10` |

Since the pre-ride setup flow (2026-07), the same sender can be enabled without env
vars: persisted settings (`settings.json` in Electron userData; "iPhone Cockpit" mode —
persisted value `iphone-hud` — + a user-confirmed IPv4) resolve through `shared/settings.js`. Precedence: **a set
`W17_IPHONE_BRIDGE` (any value, including `0`) wins over settings**; unset falls
through. Packet shape, port defaults, and cadence semantics are unchanged — this is
configuration sourcing only, not a contract change. Address discovery remains manual:
the setup UI may *suggest* the last W3 sender's IP (transport metadata from the
log-only receiver, user-confirmed, never auto-applied). Zero-config mDNS discovery is
now **canonically specified** (contract "Discovery" section above:
`_w17hud._udp.local.`, advisory/user-confirmed hints only; adopted canonically
2026-07-10, mirrored here at rev `84532ed`). The Windows-side implementation is
**not built yet** — the original proposal
(`docs/proposals/iphone_mdns_discovery.md`) can proceed as ordinary reviewed work
against the canonical Discovery section.

Port `5602` is the iPhone → Windows head-tracking receiver (contract §3), now
**implemented on Windows and LOG-ONLY** (W3; see the "W3: head-tracking receiver"
notes below). It validates and logs intent only — **no active pan/tilt, no iPhone →
CRSF, no iPhone → servo, no firmware UDP/JSON**; active pan/tilt mapping stays a
separate safety milestone, and real-device iPhone validation remains pending.

## Module layout

- `shared/telemetrySnapshot.js` — pure packet builder (golden-tested against §2's shape).
- `main/IphoneTelemetryBridge.js` — send-only UDP wrapper: coalesces to the configured
  cadence, injectable socket/clock for tests.
- `main/iphoneBridgeConfig.js` — pure env-var resolution (disabled-by-default rules).
- The bridge subscribes as a **second consumer** of the existing telemetry flow in
  `main/main.js`; the on-screen HUD path is untouched.

## Field sourcing on Windows

| Contract field | Windows source |
|---|---|
| `battery_v` | CRSF BATTERY 0x08 → merged `Telemetry.batteryV` |
| `link_quality`, `rssi_dbm`, `snr_db` | ground TX LINK_STATISTICS 0x14 (`rssi_dbm` = −uplinkRssiAnt1; `snr_db` = uplinkSnr) |
| `speed_kmh` | CRSF GPS 0x02 groundspeed |
| `gear`, `drive_mode`, `ers_percent` | CRSF FLIGHTMODE 0x21 `"G3 M2 E55"`; `drive_mode` maps 0→`TRAINING`, 1→`GEARBOX`, 2→`GEARBOX_ERS`, else `UNKNOWN` |
| `throttle`, `brake`, `steering` | **read-only display mirror** of the HUD's gamepad state, renderer → main IPC (`command-mirror`), ~20 Hz |
| `camera_yaw_deg`, `camera_pitch_deg` | same mirror: right-stick pan/tilt × 90° full deflection; positive yaw = camera right, positive pitch = camera up. Commanded look direction, **not** a measured gimbal angle |
| `head_tracking_mode` | `"DS4"` while the mirror is fresh (camera is right-stick-driven; Windows has no head tracking yet) |
| `video_lock` | whether the HUD's WHEP `<video>` is currently playing |
| `mode` | `"demo"` when the replay telemetry source is active |

The mirror is one-way (renderer → main → UDP out). Nothing the iPhone sends can
reach it; `test/noControlPath.test.js` guards this structurally.

## Staleness/omission behavior (contract "Nullable And Unknown Values")

- Car-side fields are included only while the Windows source is **fresh** (the
  same `shared/linkState.mjs` derivation the HUD uses). `link-lost` (LQ = 0) is
  fresh, real data and adds `warning: "LINK LOST"`.
- When a previously-live source goes silent (>1 s), car fields are **omitted**
  and `stale_data_warnings: ["telemetry"]` is set — old values are never re-sent
  as fresh.
- A mirror silent for >1 s is omitted the same way.
- Anything Windows has no real datum for is omitted, never faked as `0`/`null`.
- Demo-only `armed`/`failsafe` (replay source) are never exported.
- Raw CRSF never crosses the bridge.
- Optional diagnostic `link_state`: `live`→`connected`, `link-lost`→`degraded`,
  `telemetry-lost`→`disconnected` ("sim" sends nothing car-side).

## W3: head-tracking receiver (LOG-ONLY) — implementation notes

Implements contract §3 ("Head-Tracking Intent Contract") and §4's first-milestone
output rule: **every state logs; none produces CRSF, servo, gimbal, or control
output.** Active pan/tilt mapping remains **blocked until the separate safety
milestone** (contract "Contract Freeze"; firmware blockers in
`w17-control-fw/project-review/iphone_pan_tilt_firmware_readiness.md` §8).

- `shared/headTracking.js` — pure validator (mirrors the reference
  `iPhone_rc/scripts/reference_iphone_bridge.py` semantics: required
  `seq`/`timestamp_ms`/`yaw_deg`/`pitch_deg`/`roll_deg`/`tracking_enabled`;
  missing `protocol_version` ⇒ version 1; angles finite, yaw ±360°,
  pitch/roll ±180°; `timeout_ms` 1–5000 when present; booleans never pass
  integer checks) + `HeadTrackingMonitor` diagnostics state machine.
- `main/HeadTrackingReceiver.js` — thin UDP wrapper: binds, validates, logs
  state transitions and a 1 Hz rate line, caps invalid-packet log spam.
  Public surface is `{start, stop, state, getDiagnostics}` — a structural dead
  end; `test/noControlPath.test.js` asserts no other runtime module imports it
  and `main.js` never reads its data.
- States: `disabled`, `idle`, `inactive`, `not_centered`, `active_log_only`,
  `stale`, `invalid`, `fault` (contract's recommended set). Stale authority is
  **receive time > 300 ms** (`W17_HEADTRACK_STALE_MS`, clamped 1–5000); the
  packet's `timeout_ms` is recorded as a diagnostic hint only. Invalid packets
  increment counters + log a concise reason and never replace the last valid
  state. Sequence gaps/repeats/regressions are logged diagnostics, not faults.
- `calibrated` is not a schema field (the app's Center/Calibrate action is
  carried by `centered`); it is tolerated as an optional boolean diagnostic and
  gated conservatively (`calibrated: false` ⇒ `not_centered`).

### Config (env vars, read in `main/main.js`)

| Env var | Meaning | Default |
|---|---|---|
| `W17_HEADTRACK` | master enable; `1` binds the listener | **unset = off** |
| `W17_HEADTRACK_PORT` | UDP listen port | `5602` (contract §3) |
| `W17_HEADTRACK_BIND` | bind address | `0.0.0.0` |
| `W17_HEADTRACK_STALE_MS` | receive-time stale authority | `300` |

The ⚙ settings menu adds a persisted toggle for the same receiver ("head-track
logging — diagnostic only, no camera control"), off by default; a set `W17_HEADTRACK`
(any value, including `0`) overrides it. The receiver stays **LOG-ONLY** either way.
One sanctioned diagnostic seam was added for the setup flow: an injected sink
(`noteRemoteAddr`) receives the sender IP *string* of accepted datagrams — transport
metadata only, never packet contents — to pre-fill the W2 destination field as a
user-confirmed suggestion. `test/noControlPath.test.js` pins the seam shape (exactly
`rinfo.address`), bans intent vocabulary in the hint store, and keeps every original
dead-end assertion byte-identical.

### Log-only validation runbook (mirrors `iPhone_rc/docs/WINDOWS_BRIDGE_LOG_ONLY_TEST.md`)

1. `W17_HEADTRACK=1 npm start` (or `npm run demo`) — expect
   `[headtrack] LOG-ONLY receiver listening on 0.0.0.0:5602 …`.
2. From the iPhone repo:
   `python3 scripts/send_fake_head_tracking.py --host <pc-ip> --port 5602 --pattern sine`
   → state `idle -> active_log_only`, 1 Hz rate lines with seq/age/yaw/pitch/roll.
3. `--uncentered` → `not_centered`; `--disable-after 2` → `inactive`;
   `--malformed` → `rejected packet: malformed-json`, counters up, valid state kept.
4. Stop the sender → `active_log_only -> stale` after ~300 ms.
5. Throughout: confirm **no** CRSF/servo/pan-tilt/control effect exists — there is
   no code path; `npm test` runs the no-control-path regression proving it.
