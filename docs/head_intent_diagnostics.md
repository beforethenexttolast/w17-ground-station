# Mapper head-intent diagnostics subscriber (CB8 slice 3B)

Read-only Electron consumer of the mapper's head-intent diagnostics stream. This
is the ground-station half of VR-FPV batch **CB8 slice 3B**; the mapper half
(slice 3A) lives in `w17-mapper` and is the authoritative producer.

## What this is (and is not)

- **Is:** a SUBSCRIBER that renders the mapper's authoritative, read-only
  head-intent diagnostics (state machine + counters + last-valid angles +
  server-computed freshness) as a HUD chip.
- **Is not:** a controller, a second head-intent state machine, or a UDP
  receiver. It binds no socket, opens nothing from the renderer, sends nothing to
  the mapper, and never drives CRSF / servos / gimbal / ESC. There is no active
  pan/tilt anywhere in this path (that remains blocked behind a separate,
  reviewed safety milestone).

The mapper's diagnostics deliberately expose **no "active control" state**;
`ACTIVE_LOG_ONLY` is the fully-fresh state that STILL produces no output. The
chip always reads `· NO CONTROL`.

## Topology (a) — UDP 5602 has exactly one owner

Owner decision #1 (2026-07-15) chose topology (a): the mapper owns UDP 5602
head-intent ingest and republishes diagnostics over gRPC; Electron stays
viewer/log-only.

| Mode | Owns UDP 5602 | Electron W3 receiver | This consumer |
|---|---|---|---|
| **Electron-owns-5602** (default) | Electron W3 receiver | ON (`W17_HEADTRACK`) | OFF |
| **Mapper-owns-5602** | the mapper (`-headtrack-ingest`) | **OFF (forced)** | ON (`W17_MAPPER_HEADINTENT=1`) |

The two are **mutually exclusive**: enabling the consumer means the mapper owns
5602, so the local W3 receiver is force-disabled (a second bind on 5602 would
fail the exclusive bind regardless). The switch is `resolveHeadIntentModes()` in
`main/headIntentDiagnosticsConfig.js`, applied at the single sanctioned wiring
point (`main/main.js`, `applyW3`). See `test/headIntentDiagnosticsConfig.test.js`.

## Enablement

```
W17_MAPPER_HEADINTENT=1               # master enable (unset = off, no gRPC client)
W17_MAPPER_GRPC_ADDR=127.0.0.1:10000  # mapper gRPC endpoint (default loopback)
```

Loopback by default: in production the mapper and the ground station run on the
same Windows host. `:10000` is the mapper's **existing** gRPC service (unchanged
by this slice; still binds `[::]` per the mapper — tightening that bind is a
separate decision).

## Client mechanism (decision)

**`@grpc/grpc-js` + `@grpc/proto-loader`** in the Electron **main** process,
loading `proto/head_intent_diagnostics.proto` dynamically. NOT generated stubs,
and **not** the browser grpc-web path (no gRPC in the renderer).

Why proto-loader over generated stubs:

- No codegen toolchain is required in this repo (the mapper already owns the
  pinned `protoc` pipeline for slice 3A). There is no forked/generated artifact
  to drift, so there is no `mirror-generate.sh` / zero-diff regen step here — the
  single synced artifact is the `.proto` mirror itself.
- The mirror declares **only** the read-only `WatchHeadIntentDiagnostics` RPC, so
  the generated client physically has no setter — the no-control-path guarantee
  holds at the wire-definition level (`test/headIntentGrpcConnect.test.js`).

Loader options: `keepCase:true` (snake_case fields as in the proto), `enums:String`
(enum name, e.g. `HEAD_INTENT_STATE_ACTIVE_LOG_ONLY`), `longs:Number`.

## Proto mirror & sync

`proto/head_intent_diagnostics.proto` is a **faithful mirror** — not a fork — of
the `HeadIntentState` enum, `HeadIntentDiagnostics` message, and `Empty` from the
canonical source:

> **Canonical source:** `w17-mapper/pkg/proto/server.proto`
> (owned fork of `elrs-joystick-control`, upstream pinned `2b8031a`, branch
> `w17-headtrack`). Field numbers, types, and enum values must match exactly.

To keep it in sync when the mapper's definitions change, re-copy those three
definitions verbatim and keep the package name `JoystickControl` and the service
method `WatchHeadIntentDiagnostics` (the gRPC method path
`/JoystickControl.JoystickControl/WatchHeadIntentDiagnostics` must match the
mapper). The mirror intentionally OMITS every other mapper RPC and is
self-contained (no `google/protobuf` imports to resolve).

## Robustness (display-only semantics)

- **Reconnect** with bounded exponential backoff (500 ms → 10 s cap) on stream
  end/drop; the backoff resets on a healthy frame.
- **`UNAVAILABLE`** (mapper down or ingest disabled) → chip
  `MAPPER OFFLINE / INGEST OFF`; keeps retrying.
- **`RESOURCE_EXHAUSTED`** (the mapper caps concurrent streams at **4**) → chip
  `STREAM BUSY · CAP 4`; keeps retrying (a slot may free).
- A mapper restart / slow network never wedges the app and never touches the
  elrs launcher. `stop()` cancels cleanly and does not reconnect.

## Files

| File | Role |
|---|---|
| `proto/head_intent_diagnostics.proto` | subscriber-only proto mirror (one read-only RPC) |
| `main/headIntentGrpcConnect.js` | `@grpc/grpc-js` transport factory (main-only) |
| `main/HeadIntentDiagnosticsClient.js` | reconnect/backoff/state consumer core (transport-injected) |
| `main/headIntentDiagnosticsConfig.js` | env resolution + topology-(a) exclusivity |
| `shared/headIntentView.mjs` | pure snapshot → chip render model |
| `renderer/hud.js` / `renderer/index.html` | one-way subscription + `HEAD-INTENT` chip |
| `main/main.js` | single wiring point (consumer + W3 exclusivity + teardown) |

## Tests / validation

- `test/headIntentDiagnosticsConfig.test.js` — env resolution + exclusivity.
- `test/headIntentDiagnostics.test.js` — stream consumption, reconnect/backoff,
  `UNAVAILABLE`/`RESOURCE_EXHAUSTED` display states, stop() has no reconnect, and
  the no-setter / one-way guards.
- `test/headIntentView.test.js` — every `HeadIntentState` + connection state maps
  to the rendered view; fields pass through verbatim; NO CONTROL invariant.
- `test/headIntentGrpcConnect.test.js` — the mirrored service exposes ONLY the
  read-only watch RPC (no setter on the generated client).
- `test/noControlPath.test.js` — subscriber is a one-way display path (client
  never writes, preload surface is receive-only).

End-to-end against a live `@grpc/grpc-js` server emitting `HeadIntentDiagnostics`
was exercised during development (real wire dispatch, snake_case decode, enum
strings, and reconnect after a server-side stream end), confirming read-only
rendering and reconnect.
