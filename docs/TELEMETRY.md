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

## The return-path decision (for a future car-firmware "item 5")

Telemetry has to get from the car to the laptop. Two options, and the choice matters:

### Recommended: WiFi (over the OpenIPC AP)
The car ESP32 publishes a tiny JSON packet over the 5.8 GHz AP the laptop is already joined to
(the video link), e.g. UDP broadcast or a WebSocket. **No contention with the control link.**
Build a `WebSocketSource`/`UdpSource` implementing `TelemetrySource` and select it in
`main/main.js`. This trades "no new wiring on the car" for "no serial conflict on the ground"
— the right trade for a viewer-only station.

Suggested JSON (maps 1:1 to `Telemetry`):
```json
{ "speedKmh": 42.0, "batteryV": 7.6, "batteryPct": 68, "armed": true,
  "failsafe": false, "linkQualityPct": 96, "gear": 3, "ersPct": 55 }
```

### Fallback: CRSF telemetry over the control serial
Standard CRSF telemetry frames travel RP1 → ELRS TX module → the **FT232 port**. But that port
is held by `elrs-joystick-control`, so our app can only read telemetry if that tool **forwards**
it (verify — see SETUP §4). If it does, a `CrsfSerialSource` consumes it using the already-built
parser in `shared/crsf.js`:
- **LINK_STATISTICS** (type `0x14`, 10-byte payload) → `linkQualityPct` from `uplinkLinkQuality`
  (offset 2), the failsafe-relevant field.
- **Battery** (type `0x08`, 8-byte payload) → `batteryV` / `batteryPct` via `decodeBattery`.
- A custom frame (or the WiFi packet) for `speedKmh` / `gear` / `ersPct`.

`shared/crsf.js` is a faithful port of the firmware CRSF decoder (same CRC-8/DVB-S2 poll 0xD5,
same byte layouts), unit-tested against the firmware's golden vectors — so either return path
decodes identically to what the car encodes.
