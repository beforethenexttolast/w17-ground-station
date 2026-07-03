# Telemetry contract

The HUD consumes a normalized `Telemetry` object (`shared/telemetry.js`). The car only needs
to deliver the **car-side truths** the ground can't already infer from the gamepad:

| field | type | meaning |
|---|---|---|
| `speedKmh` | number | real ground speed (Hall sensor) |
| `batteryV` | number | pack voltage |
| `batteryPct` | number | remaining % |
| `armed` | bool | arm-gate confirmation from the car |
| `failsafe` | bool | car-side failsafe active |
| `linkQualityPct` | number | ELRS uplink LQ, 0..100 |
| `gear` | number | 1-based (optional — HUD tracks it locally otherwise) |
| `ersPct` | number | ERS store (optional — HUD simulates otherwise) |

All fields optional: the HUD overlays whatever is present and simulates the rest. A source
that stops emitting for >1 s falls back to simulation automatically.

## The chosen path: CRSF over the ELRS backchannel (battery + LQ)

**Decided (Phase-2 item 5):** the two-way ExpressLRS link already carries telemetry from the
car to the PC — use it. The control board emits a standard **CRSF battery frame (0x08)** up to
RP1; RP1 relays it over the ELRS downlink to the ground TX module, which puts it on the FT232
serial. **Link quality needs no firmware** — the ground TX module reports **LINK_STATISTICS
(0x14)** to the host natively. `CrsfSerialSource` reads that serial stream and emits a *partial*
`Telemetry` (only `batteryV`/`batteryPct` + `linkQualityPct`); the HUD keeps simulating
speed/gear/ERS from the gamepad.

Why only battery + LQ: ELRS relays *standard* CRSF telemetry sensor frames + MSP, not arbitrary
custom data, so speed/gear/ERS have no natural frame and aren't worth MSP complexity for a gift.
(A WiFi/ESP-NOW path could carry all fields as JSON — see the git history — but was declined:
the ESP32-WROOM is 2.4 GHz-only and the video AP is 5.8 GHz, and this path needs no new radio.)

Enable it: `W17_TELEMETRY_SOURCE=crsf-serial W17_TELEMETRY_PORT=COM5` (see `main/main.js`).

### The one obstacle: the FT232 COM port is exclusive

On Windows a COM port opens for **exclusive access** by default (`CreateFile` `dwShareMode = 0`),
so only one process holds it — and `elrs-joystick-control` holds it to *write* control. The
telemetry comes back *in* on that same port, but our app can't open it a second time. Resolve
by "one owner redistributes" (SETUP.md §4):
1. **elrs-joystick-control forwards telemetry** (a UDP/log/stdout flag) → point the source at
   that. Verify whether it can.
2. **com0com/hub4com virtual-COM splitter** → one owner mirrors the physical port; elrs-jc opens
   one virtual port, our app opens another to read. `W17_TELEMETRY_PORT` = the reader end.
3. (Not recommended) our app owns the port — reverses the viewer-only safety choice.

### Frame → Telemetry mapping (`shared/crsfTelemetry.js`, unit-tested)
- **Battery 0x08** (8-byte BE payload) → `batteryV` / `batteryPct` via `decodeBattery`.
- **LINK_STATISTICS 0x14** → `linkQualityPct` from `uplinkLinkQuality` (offset 2).

`shared/crsf.js` is a faithful port of the firmware CRSF decoder (CRC-8/DVB-S2 poly 0xD5, same
byte layouts), and the battery frame is pinned by an identical golden vector in *both* the
firmware (`test_build_battery_frame_bytes`) and here — so the car encodes exactly what the
ground station decodes.
