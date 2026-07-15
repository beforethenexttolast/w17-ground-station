# CB8 slice 3C — head-intent diagnostics cross-process integration evidence

**Date:** 2026-07-15
**Scope:** VALIDATION + a proto-drift guard. No new runtime behavior; log-only /
display-only throughout. No active pan/tilt, no iPhone→CRSF, no iPhone→servo/
gimbal/ESC; firmware untouched and iPhone-unaware. The mapper receiver stays
LOG-ONLY; the Electron consumer stays subscriber/display-only.

This note records a REAL cross-process run: a live `w17-mapper` (owned fork,
branch `w17-headtrack`) gRPC server on `:10000` with its LOG-ONLY UDP 5602
head-intent receiver, driven by the `iPhone_rc` fake UDP sender, and observed by
the ground-station consumer using the SHIPPING transport
(`main/headIntentGrpcConnect.js`) + consumer core
(`main/HeadIntentDiagnosticsClient.js`).

## Setup

- **Mapper build (validation setup only).** `go1.26.5` on this macOS host cannot
  build the pre-existing `go.bug.st/serial/enumerator` v1.5.0 (go1.26 cgo rule:
  "cannot define new methods on non-local type C.*"). This is unrelated to the
  head-intent work (it fails on pristine `main.go`). For the validation binary
  only, `go.bug.st/serial` was temporarily replaced with the cached `v1.7.1`
  (`go mod edit -replace`), the binary was built with `GOWORK=off`, and the
  module files were then reverted — **`go.mod`/`go.sum`/`go.work`/`go.work.sum`
  are byte-pristine vs `HEAD`** (`git diff HEAD` empty). The committed send-path
  dependency is unchanged; that bump remains an owner decision.
- **Consumer.** Node harness constructing the real `createHeadIntentConnect()` +
  `HeadIntentDiagnosticsClient` against `127.0.0.1:10000`, logging exactly the
  one-way `{connection, diagnostics}` broadcast the Electron main process would
  push to the renderer. (Harness is validation-only; not committed.)
- **Sender.** `iPhone_rc/scripts/send_fake_head_tracking.py` (read-only; run, not
  modified) to UDP `127.0.0.1:5602`.

## HeadIntentState coverage (observed live over the real gRPC stream)

| State (enum) | How driven | Observed snapshot (consumer view) |
|---|---|---|
| `IDLE` | ingest on, no packets | `conn=live state=…IDLE total=0 valid=0 invalid=0` |
| `INVALID` | `--malformed-every 1` (fresh receiver, no valid ever) | `…INVALID total=28 valid=0 invalid=28` |
| `STALE` | valid packets, then silent > 300 ms | `…STALE age=14460 rate=0` (last-valid preserved: yaw=12) |
| `INACTIVE` | `--disable-after 0` (tracking_enabled=false) | `…INACTIVE valid>0 enabled=false centered=true` |
| `NOT_CENTERED` | `--uncentered` | `…NOT_CENTERED enabled=true centered=false` |
| `ACTIVE_LOG_ONLY` | `--pattern static` (fresh+enabled+centered) | `…ACTIVE_LOG_ONLY enabled=true centered=true` (STILL no control output) |
| `FAULT` | 2nd mapper, ingest on, UDP 5602 already bound → bind fails | `…FAULT`; mapper log: `FAULT: could not bind 0.0.0.0:5602: address already in use` |

- **`UNSPECIFIED` (0)** is the never-sent guard; it is asserted by the hermetic
  enum guard and the mapper's `headIntentStateToPb` unknown→UNSPECIFIED default.
- **`DISABLED` (1)** is a receiver-lifecycle enum for "receiver present but not
  running." The `cmd` wiring never produces that shape: with `-headtrack-ingest`
  the receiver runs; without it the broadcaster is `nil` and the RPC returns
  **`UNAVAILABLE`** (below) instead. `DISABLED` is covered by the mapper's
  `pkg/headintent` / `pkg/server` unit tests and the state→enum map, not by this
  live topology.

## Transport / robustness (observed live)

- **Ingest OFF ⇒ UNAVAILABLE.** Mapper started WITHOUT `-headtrack-ingest`
  (broadcaster `nil`): consumer receives gRPC `code=14`, detail
  *"head-intent ingest is disabled; start the mapper with -headtrack-ingest"* →
  `conn=unavailable`, keeps retrying. (Renderer chip: `MAPPER OFFLINE / INGEST OFF`.)
- **4-stream cap ⇒ RESOURCE_EXHAUSTED.** Opening 5 concurrent subscribers:
  `subscribed=4 resource_exhausted=1`; the 5th returns `code=8`
  *"too many head-intent diagnostics subscribers"*. (Renderer chip: `STREAM BUSY · CAP 4`.)
- **Mapper restart ⇒ bounded-backoff reconnect.** Under a live subscriber, the
  mapper was killed and restarted: `live(STALE)` → `unavailable` (code 14,
  "Connection dropped") → repeated `connecting`→`unavailable` cycles (ECONNREFUSED,
  bounded 500 ms→10 s backoff) → after restart `connecting` → `live(IDLE, total=0)`.
  The consumer never wedged; no effect on any other GS subsystem.

## CRSF send-path unaffected (byte-identical)

- `go test ./pkg/headintent/` → **ok**, including
  `TestPackChannelsUnchangedByReceiver` and
  `TestPackChannelsUnchangedByDiagnosticsSubscribers` — `crsf.PackChannels`
  output is byte-for-byte identical with the head-intent receiver AND diagnostics
  subscribers attached (connected / slow / disconnected), across valid/stale/
  invalid UDP traffic.
- `go test ./pkg/server/` → **ok** (WatchHeadIntentDiagnostics handler, 4-cap
  ResourceExhausted, nil→Unavailable), built with the temporary serial replace,
  which was then reverted.

## Mutual exclusivity (topology (a), observed live)

Exercised through the real GS resolver (`mapperHeadIntentConfigFromEnv` +
`w3ConfigFor` + `resolveHeadIntentModes`, as `main.js applyW3()` wires them),
with a persisted W3 wish = ON so the W3 receiver *would* bind 5602 unless
suppressed:

| Env | consumer (mapper gRPC) | GS W3 receiver (UDP 5602) | live 5602 bind attempt |
|---|---|---|---|
| `W17_MAPPER_HEADINTENT=1` (+`W17_HEADTRACK=1`) | **ON** → 127.0.0.1:10000 | **OFF** (mapper owns 5602) | none attempted |
| `W17_MAPPER_HEADINTENT` unset (+`W17_HEADTRACK=1`) | **OFF** | **ON** → 5602 | `{"bound":true,"port":5602}` |

The consumer flag forces the W3 receiver off even when `W17_HEADTRACK=1` wishes
it on: exactly one owner of UDP 5602 at a time.

## Proto-drift guard (committed, hermetic + green)

- `proto/canonical/head_intent_canonical.descriptor.json` — generated from the
  live mapper `pkg/proto/server.proto` via `scripts/check-canonical-proto.js`
  (`--write`); regeneration is a **zero-diff** (idempotent).
- `test/protoDrift.test.js` — HERMETIC: proves `proto/head_intent_diagnostics.proto`
  is byte-faithful to that snapshot (package `JoystickControl`; enum value
  name→number pairs incl. `UNSPECIFIED=0` and no value above `ACTIVE_LOG_ONLY=8`;
  all 22 `HeadIntentDiagnostics` field name/number/type/label tuples; `Empty` is
  zero-field; method path `/JoystickControl.JoystickControl/WatchHeadIntentDiagnostics`
  with `requestStream=false`, `responseStream=true`). Verified to BITE on injected
  drift (a mutated field number fails 2 assertions) and pass when correct.
- `npm run proto:check` (non-hermetic, cross-repo) confirms the checked-in
  snapshot equals the live `../w17-mapper` proto.
- **GS suite: 746 passed (43 files)** — 739 prior + 7 new drift-guard tests.
