# Windows ↔ iPhone bridge contract (v1, canonical)

**Status: contract / design only. Nothing here is implemented (W1, docs-only).** No iPhone
repo or schema exists in this workspace, so **this document is the canonical v1 contract**:
the iPhone companion client conforms to what Windows defines here.

Companion design record: [`iphone_bridge_readiness.md`](iphone_bridge_readiness.md).
Firmware side: `w17-control-fw/project-review/iphone_pan_tilt_firmware_readiness.md`.

Date: 2026-07-08. Batches: **W2** = Windows→iPhone telemetry sender; **W3** =
iPhone→Windows head-tracking receiver (log-only). Neither is built yet.

---

## A. Architecture boundary (non-negotiable this phase)

- **Windows is the sole control authority.** Driving stays with elrs-joystick-control
  (DualShock → CRSF → ELRS TX). The ground-station app and this bridge are viewer/companion
  only.
- **The iPhone is a thin companion client.** It *displays* telemetry it receives and *sends*
  head-tracking intent. It has **no control authority** and no path to the car.
- **Windows → iPhone:** normalized telemetry snapshots over **UDP/JSON** (§B).
- **iPhone → Windows:** head-tracking intent over **UDP/JSON**, sent to Windows **only**
  (§D). In W3 the receiver is **log-only**.
- **The firmware is unaware of the iPhone.** It never sees UDP or JSON; it consumes only
  final, already-arbitrated CRSF channels over the radio link. This bridge introduces no
  firmware change.
- **No pan/tilt, CRSF, or servo output is produced from iPhone intent in this phase.**
  Head-tracking terminates at a Windows log. Mapping intent → camera channels is a
  separate, later, safety-gated milestone.
- **Video is out of scope of this contract.** The FPV video path (camera → mediamtx →
  WebRTC/WHEP) is independent of control and of this bridge; it is not carried over these
  UDP channels. Advertising video endpoint info to the phone is a possible future
  extension, explicitly deferred.

### Transport summary

| Direction | Batch | Transport | Default port | Config | Behavior |
|---|---|---|---|---|---|
| Windows → iPhone telemetry | W2 | UDP, JSON, one datagram per snapshot | **48017/udp** | `W17_IPHONE_PORT` | fire-and-forget, ~10 Hz |
| iPhone → Windows head-tracking | W3 | UDP, JSON, one datagram per intent | **48018/udp** (reserved) | `W17_HEADTRACK_PORT` (W3) | received, validated, **logged only** |

Both defaults are in the non-privileged range (> 1023) and are **configurable** to avoid
collisions on any given network. UDP is chosen deliberately: telemetry and head-tracking
are both latest-value-wins streams where a dropped datagram is preferable to
head-of-line blocking; there is no retransmission and no ordering guarantee at the
transport layer (the `seq` field provides ordering/loss visibility at the application
layer).

---

## B. W2 — Windows → iPhone telemetry snapshot contract

### B.1 Packet

One UDP datagram per snapshot, payload = a single UTF-8 JSON object (no framing, no
trailing newline required). One snapshot fully replaces the previous one on the phone
(latest-value-wins).

```jsonc
{
  "v": 1,              // protocol version (integer). Bump on any breaking change.
  "type": "telemetry", // message discriminator (lets one listener sort message kinds)
  "seq": 1234,         // uint32, +1 per sent datagram, wraps 4294967295 -> 0
  "tMs": 1751972400123,// sender wall-clock, ms since Unix epoch, at snapshot build
  "linkState": "live", // derived on Windows: "sim"|"live"|"link-lost"|"telemetry-lost"
  "speedKmh": 182.4,   // number | null
  "batteryV": 7.6,     // number | null
  "batteryPct": 70,    // number | null (0..100)
  "linkQualityPct": 98,// number | null (0..100; 0 is the link-lost signal, not "unknown")
  "gear": 4,           // number | null (1-based; 1 == first gear)
  "ersPct": 40,        // number | null (0..100)
  "driveMode": 2       // number | null (0=TRAINING, 1=RACE, 2=ERS)
}
```

### B.2 Field definitions

| Field | Type | Units / meaning | Source |
|---|---|---|---|
| `v` | integer | protocol version; `1` for this contract | constant |
| `type` | string | `"telemetry"` | constant |
| `seq` | integer (uint32) | per-datagram counter, wraps at 2³²; the phone uses it to detect loss/reorder | sender |
| `tMs` | integer | ms since Unix epoch when the snapshot was built (informational; the phone measures its own staleness against arrival time) | sender clock |
| `linkState` | string enum | `"sim"` / `"live"` / `"link-lost"` / `"telemetry-lost"` — **derived on Windows** by `shared/linkState.mjs`, sent so both HUDs agree instead of the phone re-deriving with different constants | derived |
| `speedKmh` | number\|null | real ground speed (Hall → GPS 0x02 groundspeed) | car |
| `batteryV` | number\|null | pack voltage (V) | car |
| `batteryPct` | number\|null | coarse remaining %, 0..100 | car |
| `linkQualityPct` | number\|null | ELRS uplink LQ, 0..100 | ground TX module |
| `gear` | number\|null | 1-based gear, car-authoritative | car |
| `ersPct` | number\|null | ERS store %, 0..100 | car |
| `driveMode` | number\|null | 0=TRAINING, 1=RACE, 2=ERS | car |

### B.3 Send rate

Default **10 Hz**. Overridable via `W17_IPHONE_RATE_HZ`. The underlying telemetry
sources emit irregularly (the CRSF path emits once per merged frame; the replay source at
20 Hz), so the sender **coalesces** to the configured cadence — it sends the latest merged
snapshot on a fixed timer, not one datagram per source emit.

### B.4 Destination configuration (read in `main/main.js`, repo env-var pattern)

| Env var | Meaning | Default |
|---|---|---|
| `W17_IPHONE_BRIDGE` | master enable; `1` turns the sender on | **unset = off** (no socket created) |
| `W17_IPHONE_ADDR` | iPhone IPv4 address (static; no discovery in v1) | none (required when enabled) |
| `W17_IPHONE_PORT` | destination UDP port on the iPhone | `48017` |
| `W17_IPHONE_RATE_HZ` | send cadence in Hz | `10` |

The bridge is **off by default and opt-in**, matching the ground station's existing
viewer-only, nothing-by-surprise posture (`W17_TELEMETRY_SOURCE`, `W17_WHEP_URL`, etc.).
With `W17_IPHONE_BRIDGE` unset, no UDP socket is opened.

### B.5 Value honesty rules (mandatory)

1. **Unknown / unavailable values are explicit `null`, never a fake `0`.** A field is
   present with value `null` when Windows has no real datum for it. `0` means a real
   measured zero (e.g. `speedKmh: 0` stopped, `linkQualityPct: 0` link lost). The phone
   must render `null` as "—"/unknown, never as a real reading.
2. **Demo-only fields are not exported as car truth.** The replay/demo source sets
   `armed`/`failsafe`; the real car transmits neither. They are **omitted** from the v1
   telemetry packet. (If a future debug build needs them, they must be carried under a
   clearly-marked debug key, never as real fields.)
3. **Raw CRSF is never sent to the iPhone.** Only the normalized snapshot crosses the
   bridge. No CRSF frames, no channel arrays, no control values.
4. `linkState` is authoritative for link status; the phone should not re-derive it from
   `linkQualityPct` alone (staleness is part of the derivation and lives on Windows).

---

## C. W2 — golden example packets

These are the pinned reference packets; the W2 snapshot-builder golden test (§E) must
reproduce them from canned inputs, and the iPhone client must parse them.

### C.1 Normal live telemetry

```json
{
  "v": 1,
  "type": "telemetry",
  "seq": 481,
  "tMs": 1751972400123,
  "linkState": "live",
  "speedKmh": 182.4,
  "batteryV": 7.6,
  "batteryPct": 70,
  "linkQualityPct": 98,
  "gear": 4,
  "ersPct": 40,
  "driveMode": 2
}
```

### C.2 LINK LOST — fresh telemetry, but uplink LQ is 0

The ground TX module keeps reporting after the radio to the car drops; `linkQualityPct`
is a real `0` (the link-lost signal), not `null`. Last real car values may still be shown.

```json
{
  "v": 1,
  "type": "telemetry",
  "seq": 902,
  "tMs": 1751972411500,
  "linkState": "link-lost",
  "speedKmh": 0,
  "batteryV": 7.2,
  "batteryPct": 55,
  "linkQualityPct": 0,
  "gear": 4,
  "ersPct": 20,
  "driveMode": 2
}
```

### C.3 TELEMETRY LOST / stale — source was live, then went silent

Windows holds the last real values and marks the state stale; the phone shows them
dimmed and must not resume simulated numbers. `tMs` continues to advance (Windows is
still sending state packets) even though the car data underneath is frozen.

```json
{
  "v": 1,
  "type": "telemetry",
  "seq": 903,
  "tMs": 1751972413000,
  "linkState": "telemetry-lost",
  "speedKmh": 0,
  "batteryV": 7.2,
  "batteryPct": 55,
  "linkQualityPct": 0,
  "gear": 4,
  "ersPct": 20,
  "driveMode": 1
}
```

### C.4 Partial / unknown values — only some fields known

E.g. a battery frame has arrived but no GPS/flightmode yet; unknown fields are explicit
`null`. `linkState` is `sim` because no source has ever been fully live in this example.

```json
{
  "v": 1,
  "type": "telemetry",
  "seq": 3,
  "tMs": 1751972390000,
  "linkState": "sim",
  "speedKmh": null,
  "batteryV": 7.9,
  "batteryPct": 66,
  "linkQualityPct": null,
  "gear": null,
  "ersPct": null,
  "driveMode": null
}
```

---

## D. W3 — iPhone → Windows head-tracking intent contract (log-only)

**Planned for W3. Not built in W1. In W3 the receiver validates and logs; it produces no
control output of any kind.**

### D.1 Planned packet

```jsonc
{
  "v": 1,                 // protocol version (integer)
  "type": "head-intent",  // message discriminator
  "seq": 5567,            // uint32, +1 per datagram, wraps
  "timestamp_ms": 1751972400200, // iPhone clock, ms; used with arrival time for staleness
  "yaw_deg": -12.5,       // head yaw, degrees (would map to camera PAN — later, not now)
  "pitch_deg": 4.0,       // head pitch, degrees (would map to camera TILT — later, not now)
  "roll_deg": 1.2,        // head roll, degrees (captured; unused — the 2-axis gimbal has no roll)
  "tracking_enabled": true, // the phone asserts head-tracking is active
  "centered": true        // a neutral/centered reference has been calibrated this session
}
```

Full 3-axis head pose is captured at the intent layer for completeness and future use;
only yaw/pitch would ever map to the 2-axis gimbal, and **no mapping exists in this
phase**. `roll_deg` is recorded but has no camera meaning.

### D.2 Validation & handling rules (W3)

Each rule short-circuits to a logged rejection with a machine-readable reason; **no
packet, valid or not, produces any control/servo/CRSF output**:

1. **Malformed** — oversized datagram (reject before parse), non-JSON, wrong/absent
   `type`, missing required field, or wrong `v` → **rejected** (`malformed` /
   `bad-schema` / `bad-version`).
2. **Disabled** — `tracking_enabled !== true` → **ignored** (logged as `disabled`).
3. **Uncentered / not calibrated** — until a packet with `centered: true` has been seen,
   intent is **ignored** (`uncentered`); a stream must start from a calibrated neutral.
4. **Invalid / out of range** — non-finite numbers or angles outside the declared limits
   → **rejected** (`out-of-range`).
5. **Stale** — intent older than **~300 ms** (receiver wall-clock since the last accepted
   packet, or `seq` regression) → **rejected** (`stale`), and the centered gate re-arms
   (a fresh `centered` packet is required to resume acceptance). This 300 ms window is the
   canonical head-tracking staleness threshold for this contract; it supersedes the
   earlier 400 ms placeholder noted in `iphone_bridge_readiness.md`. It is distinct from
   the telemetry HUD's 1000 ms freshness window (`TELEMETRY_FRESH_MS`).
6. **Log-only** — accepted packets are summarized to the log + an in-memory diagnostics
   buffer. The receiver's public surface is `{start, stop, getDiagnostics}` only; nothing
   consumes its data. There is **no code path** from the receiver to a telemetry source,
   IPC, serial, or the (nonexistent-in-this-repo) control path.

---

## E. Tests expected later (all vitest; pure modules, injected clock/socket — repo style)

**W2 (telemetry sender):**
- **Snapshot builder golden tests** — canned merged telemetry + derived link state →
  exact packets from §C (live, link-lost, telemetry-lost, partial/null). Committed as a
  shared fixture; unknown → `null`; demo-only `armed`/`failsafe` never present.
- **Disabled / no-destination test** — with `W17_IPHONE_BRIDGE` unset (or no
  `W17_IPHONE_ADDR`), no socket is created and nothing is sent.
- **UDP sender mock test** — injected fake socket + fake clock: coalesces emit bursts to
  the configured `W17_IPHONE_RATE_HZ` cadence, sends the latest snapshot per tick,
  increments `seq`, stops cleanly.

**W3 (head-tracking receiver):**
- **Parser tests** — golden accepted packet; each rejection class (`malformed`,
  `bad-schema`, `bad-version`, `out-of-range`, `disabled`, `uncentered`, `stale`/seq
  regression) returns its distinct reason; oversized datagram rejected before parse.
- **Stale timeout tests** — injected clock: gap > 300 ms → `stale` and the centered gate
  re-arms; gap < 300 ms accepted; boundary pinned.
- **No-control-path guard** — static/module-graph assertion: nothing in `main/`+`shared/`
  gains a serial write or CRSF RC-channel encoder because of the bridge; the head-tracking
  module is imported only by `main.js` + its test; its emitted-events surface is empty.

---

## F. Reserved / deferred (explicitly not v1)

- iPhone auto-discovery of the Windows host (v1 uses a static `W17_IPHONE_ADDR`).
- Video endpoint advertisement to the phone (`whepUrl`/`rtspUrl`/`codec`) — a future
  telemetry-packet or handshake extension, tied to the mirrored-video decision.
- Any mapping of head-tracking intent → camera pan/tilt channels — a separate,
  safety-gated milestone with its own blockers (see the firmware readiness report §8).

---

*Sources: `shared/telemetry.js`, `shared/linkState.mjs`, `shared/crsfTelemetry.js`,
`main/main.js`, `docs/TELEMETRY.md`, `docs/iphone_bridge_readiness.md`, and the firmware
readiness report `w17-control-fw/project-review/iphone_pan_tilt_firmware_readiness.md`.*
