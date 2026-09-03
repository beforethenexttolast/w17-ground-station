# Telemetry contract

The HUD consumes a normalized `Telemetry` object (`shared/telemetry.js`). The car only needs
to deliver the **car-side truths** the ground can't already infer from the gamepad:

| field | type | meaning |
|---|---|---|
| `speedKmh` | number | real ground speed (Hall sensor) |
| `batteryV` | number | pack voltage |
| `batteryPct` | number | remaining % |
| `linkQualityPct` | number | ELRS uplink LQ, 0..100 — **also the link-loss signal** (0 = LINK LOST) |
| `gear` | number | 1-based, car-authoritative (optional — HUD mirrors it locally otherwise) |
| `ersPct` | number | ERS store, car-authoritative (optional — HUD simulates otherwise) |
| `driveMode` | number | 0=TRAINING 1=RACE 2=ERS (optional); firmware calls 1/2 "gearbox"/"gearbox+ERS" |
| `armed` / `failsafe` | bool | **demo-only — NOT transmitted by the car.** Only the replay/demo source sets them; the real CRSF backchannel carries no such field. The car computes both, but `link2` carries them only to board #2 — there is no ground-bound carrier, and the handset only ever sees `M%u`. The HUD derives link loss from `linkQualityPct` + staleness instead (see below), and **labels the indicators as simulated** (see below). |

All fields optional: the HUD overlays whatever is present and simulates the rest.

### HUD link states (audit R01, option A)

The HUD shows one of four states, derived ground-side (`shared/linkState.mjs`):

| state | trigger | display |
|---|---|---|
| sim | no telemetry source has **ever** produced data | "Telemetry: sim", simulated values |
| live | fresh telemetry, LQ > 0 | "LQ n%", real values |
| **LINK LOST** | fresh telemetry with `linkQualityPct == 0` (the ground TX module keeps reporting LINK_STATISTICS after the radio link to the car drops) | red/amber alarm |
| **TELEMETRY LOST** | the source *was* live, then went silent >1 s (serial unplugged, forwarder died) | alarm; last real values held **dimmed** — the HUD never silently resumes simulated numbers once a source has been live |

### Simulated armed/failsafe are LABELLED as such (owner decision 2026-07-25)

Being demo-only was recorded in the code comments but invisible on screen, so a replayed
failsafe episode raised an alarm indistinguishable from a real radio drop. The HUD now states
the provenance, in the same muted "we do not observe this" vocabulary as CAMERA MODE's
`NOT REPORTED BY MAPPER`:

| indicator | no replay source | replay source active |
|---|---|---|
| `#armChip` (always visible) | `ARM / FAILSAFE · NOT REPORTED BY CAR` | `ARM / FAILSAFE · SIMULATED` |
| LINK LOST from `linkQualityPct == 0` | `LINK LOST` (real) | — |
| LINK LOST from `failsafe == true` | — | `LINK LOST · SIMULATED` |

`failsafe == true` is itself proof of a synthetic trigger (nothing but `shared/replaySource.js`
sets it), so no source plumbing is needed to tell the two apart. `shared/linkState.mjs` is
deliberately unchanged — the four states are the same; only the trigger is now named. Pinned by
`test/armFailsafeLabel.test.js`.

**Rejected alternative:** carrying A/F in the FLIGHTMODE status string. `"G4 M2 E100 A1F0"` is
15 chars and *exactly* fills the budget; R13 (whether a real ELRS/handset relays a custom
FLIGHTMODE status string at all) is unproven; and `parseFlightMode`'s per-field fallback is
tested only on the clean-ASCII path, so a mid-token truncation could surface a **wrong** armed
state. An honestly-labelled simulated indicator beats a possibly-wrong real one. Revisit only
after R13 is proven on hardware.

## The chosen path: CRSF over the ELRS backchannel (real speed + gear/mode/ERS + battery + LQ)

**Decided (Phase-2 item 5, extended):** the two-way ExpressLRS link already carries telemetry
from the car to the PC — use it, and carry *everything* over **standard, relayed** CRSF frames
so no MSP is needed. The control board emits, at ~5 Hz up to RP1 (relayed over the ELRS
downlink to the ground TX module → FT232 serial):

| what | CRSF frame | why this frame |
|---|---|---|
| pack voltage + % | **BATTERY 0x08** | standard battery sensor |
| **real wheel speed** | **GPS 0x02**, `groundspeed` field | ELRS relays GPS; groundspeed is a real numeric field |
| **car gear + drive-mode + ERS%** | **FLIGHTMODE 0x21** status string `"G3 M2 E55"` | status text is relayed + handset-displayable; we own the parser both ends |

**Link quality needs no firmware** — the ground TX module reports **LINK_STATISTICS (0x14)** to
the host natively. `CrsfSerialSource` reads the serial stream and merges the frames into one
running `Telemetry` snapshot (each frame type sets its own fields; a battery frame must not
blank speed/gear, so the source accumulates rather than replaces).

**Why gear/ERS are sent, not mirrored:** the HUD *can* track gear/ERS from the same gamepad
inputs, but that is an independent computation that drifts from the car's (a dropped shift edge
desyncs them; the HUD's display model even used a different gear count). Sending the car's
actual values makes the HUD show ground truth. Speed is not inferable on the ground at all.

**Why standard frames, not MSP:** ELRS relays standard CRSF telemetry frames natively; MSP-over-
CRSF is request/response and higher-risk for marginal gain. GPS-groundspeed and a flight-mode
status string are ordinary relayed telemetry, so this needs no MSP and no new radio. (A
WiFi/ESP-NOW path could carry richer JSON — see git history — but was declined: the ESP32-WROOM
is 2.4 GHz-only while the video AP is 5.8 GHz.)

Enable it: `W17_TELEMETRY_SOURCE=crsf-serial W17_TELEMETRY_PORT=COM5` (see `main/main.js`).

### The one obstacle: the FT232 COM port is exclusive

On Windows a COM port opens for **exclusive access** by default (`CreateFile` `dwShareMode = 0`),
so only one process holds it — and `elrs-joystick-control` holds it to *write* control. The
telemetry comes back *in* on that same port, but our app can't open it a second time. Resolve
by "one owner redistributes" (SETUP.md §4):
1. **Read it from the drive program's own stream** — `W17_TELEMETRY_SOURCE=mapper-grpc`, and what
   race day now selects for itself. THE SHIPPED ANSWER (owner decision OD-4); see below.
2. ~~elrs-joystick-control forwards telemetry (a UDP/log/stdout flag)~~ — **it cannot.**
   `cmd/elrs-joystick-control/main.go` has no such flag; the old "verify whether it can" line is
   settled, in the negative. Option 1 is the same idea done over the interface it does have.
3. **com0com/hub4com virtual-COM splitter** → one owner mirrors the physical port; elrs-jc opens
   one virtual port, our app opens another to read. `W17_TELEMETRY_PORT` = the reader end. A
   hobbyist install; not on the gift kit's path.
4. (Not recommended) our app owns the port — reverses the viewer-only safety choice.

### The shipped answer: `mapper-grpc` (owner decision OD-4)

The drive program already decodes these frames for its own UI and publishes them on a **read-only
server stream**, so the ground station reads them from there instead of fighting for the port.
`main/MapperTelemetrySource.js` consumes `getTelemetryStream` (mirrored in
`proto/mapper_readonly_streams.proto` from `w17-mapper/pkg/proto/server.proto:575`) on
`127.0.0.1:10000` and feeds the ordinary snapshot path, so BATT, the low-battery banner and the
send-only phone bridge all work with no other change. It is read-only by construction — the
mirrored service declares no mutating RPC at all — and `test/noControlPath.test.js` pins that.

**Two unit differences from the serial path**, both handled in `shared/mapperTelemetry.js` and
both pinned by `test/mapperTelemetry.test.js`, because they come from upstream assuming a
Betaflight flight controller rather than this car:
- **Speed.** The mapper divides the raw CRSF groundspeed by 100 and documents it as m/s; the car
  encodes the standard 0.1 km/h unit, so the conversion is **×10, not ×3.6**. A golden test feeds
  the same wire bytes through both readers and requires the same km/h.
- **SNR.** The mapper reads the uplink SNR byte unsigned, so −6 dB arrives as 250; it is
  reinterpreted as the signed byte it is.

### Frame → Telemetry mapping (`shared/crsfTelemetry.js`, unit-tested)
- **Battery 0x08** (8-byte BE payload) → `batteryV` / `batteryPct` via `decodeBattery`.
- **GPS 0x02** (15-byte BE payload) → `speedKmh` from `groundspeed` (offset 8-9, 0.1 km/h) via
  `decodeGps`. The car fills only groundspeed; lat/lon/heading/sats are 0, altitude the 1000-m
  baseline.
- **FLIGHTMODE 0x21** (NUL-terminated ASCII) → `gear` / `driveMode` / `ersPct` via
  `decodeFlightMode` + `parseFlightMode` (tolerant `G<n> M<n> E<n>` reader).
- **LINK_STATISTICS 0x14** → `linkQualityPct` from `uplinkLinkQuality` (offset 2).

`shared/crsf.js` is a faithful port of the firmware CRSF decoder (CRC-8/DVB-S2 poly 0xD5, same
byte layouts), and every emitted frame is pinned by an identical golden vector in *both* the
firmware (`test_build_*_frame*`) and here — so the car encodes exactly what the ground station
decodes.
