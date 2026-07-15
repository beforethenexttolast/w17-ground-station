# iPhone bridge readiness — Windows ground-station assessment

**Status: readiness report only. Nothing in this document is implemented; no source code
was changed to produce it.** Date: 2026-07-08.

Scope: prepare the Windows ground station to (a) export normalized telemetry snapshots to
an iPhone companion HUD over UDP, and (b) receive iPhone head-tracking *intent* packets —
**log-only** in this phase. Hard rules inherited from the phase brief:

- Windows remains the central authority / control hub.
- The iPhone is a thin companion client: it displays; it does not control.
- **No iPhone packet may affect vehicle control in this phase.** Head-tracking intents are
  received, validated, and logged — never mapped to CRSF, servos, or any output.
- Facts below are tagged [C] confirmed (file cited) / [I] inferred / [A] assumption.

---

## 1. Current ground-station architecture

### 1.1 Process/module layout [C]

| Layer | Files | Role |
|---|---|---|
| Electron **main** (Node) | `main/main.js` | Window lifecycle, chooses the telemetry source, pushes each snapshot to the renderer over one IPC channel (`'telemetry'`), serves a one-shot `config:get` (WHEP URL + feel constants). |
| | `main/mediamtx.js` | `MediamtxSupervisor` — spawns/restarts/kills the bundled mediamtx binary. |
| | `main/CrsfSerialSource.js` | Thin serial I/O wrapper (lazy-`require`d `serialport`), feeds bytes to the pure shared decoder, **accumulates a running merged snapshot** (`this._telem`) so a battery frame doesn't blank speed/gear, emits the merge. |
| | `main/preload.cjs` | The only renderer↔Node bridge: `groundStation.getConfig()` + `groundStation.onTelemetry(cb)`. Renderer is sandboxed (`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`). |
| **renderer** (Chromium) | `renderer/hud.js` | The HUD. Command side (throttle/brake/steer/DRS/boost/overtake/gear-shifts, cam pan/tilt reticle) mirrored from the local gamepad/keyboard; car-side truth overlaid from telemetry; link state derived locally. |
| | `renderer/whep.js` | Minimal WHEP client: SDP offer → mediamtx `:8889/cam/whep`, recvonly video, `playoutDelayHint = 0`, auto-retry. |
| **shared** (pure, unit-tested) | `shared/telemetry.js` | `TelemetrySource` base class + the normalized `Telemetry` typedef. |
| | `shared/crsf.js`, `shared/crsfAssembler.js`, `shared/crsfTelemetry.js` | CRSF CRC/decode (port of the firmware decoder, golden-vector-pinned), byte→frame assembler, frame→partial-Telemetry mapper. |
| | `shared/linkState.mjs` | Pure, clock-injected link-state model. |
| | `shared/replaySource.js` | Scripted keyframe replay source (demo + test fixture), injectable clock/scheduler. |
| | `shared/feelConstants.js` | Display-feel constants shared main→renderer. |

### 1.2 Telemetry sources [C]

`chooseTelemetrySource()` (`main/main.js:32`) selects by `W17_TELEMETRY_SOURCE`:
`replay` → `ReplaySource`; `crsf-serial` → `CrsfSerialSource` (port from
`W17_TELEMETRY_PORT`, 420000 baud); anything else → `null` (HUD runs gamepad-simulated).
All sources implement the same interface: `start()`, `stop()`,
`onTelemetry(cb)`/`_emit(t)` (`shared/telemetry.js:33`). A comment at
`shared/telemetry.js:30` already anticipates a future `WebSocketSource/UdpSource` behind
this same seam.

### 1.3 HUD state model [C]

`renderer/hud.js` keeps three kinds of state:

1. **Command mirror `S`** — throttle/brake/steer/gear/DRS/boost/overtake/camPan/camTilt
   read each frame from the Gamepad API (or keyboard, or demo script). Display-only
   mirror of the driver's inputs; **exists only in the renderer** — the main process
   never sees it.
2. **Local display simulation** — speed/rpm/ERS animated from `S` using
   `shared/feelConstants.js`, used only while no telemetry source has ever been live.
3. **Telemetry overlay `telem`** — the latest merged snapshot pushed from main; any field
   present overrides its simulated counterpart (`render()`, `hud.js:174`). `telemFresh`
   (timestamp of last push) and `telemEverLive` (latched) feed the link-state model.

### 1.4 Link-state model [C]

`shared/linkState.mjs` — pure function of
`{nowMs, lastTelemetryMs, everLive, linkQualityPct, failsafe}` → one of four states:
`sim` (never live), `live` (fresh, LQ > 0), `link-lost` (fresh but LQ == 0 — the ground
TX module keeps reporting LINK_STATISTICS after the radio drops), `telemetry-lost`
(previously-live source silent ≥ `TELEMETRY_FRESH_MS` = 1000 ms; last real values held
dimmed, never a silent fall-back to simulation). `armed`/`failsafe` are demo-only fields
(`shared/telemetry.js:10`); the real backchannel never carries them.

### 1.5 Video / mediamtx / WebRTC path [C]

Camera RTSP (`paths.cam.source`, `mediamtx/mediamtx.yml`) → bundled mediamtx v1.9.3
(spawned by `MediamtxSupervisor`) → WebRTC/WHEP at `http://127.0.0.1:8889/cam/whep`
(`W17_WHEP_URL` overridable, `main/main.js:30`) → `renderer/whep.js` → full-screen
`<video>`. mediamtx is deliberately **localhost-only** (`webrtcAdditionalHosts:
[127.0.0.1]`, `mediamtx.yml:19`); its RTSP re-serve on `:8554` stays up for the VLC
fallback. Known bench gate: camera must emit H.264 for Chromium WebRTC (`docs/SETUP.md` §1).

### 1.6 Tests [C]

`vitest` (`npm test`), four specs, all against pure `shared/` code with no hardware and no
Electron: `test/crsf.test.js` (decoder + assembler against `test/fixtures/crsf_golden.json`
— the same golden vectors pinned in the firmware tests), `test/crsfTelemetry.test.js`
(frame→Telemetry mapping incl. locally built frames), `test/linkState.test.js` (all four
states, clock-injected), `test/replay.test.js` (timeline sampling + source lifecycle with
injected clock/scheduler). Established repo pattern: **pure logic in `shared/`, injectable
clocks, thin I/O wrappers in `main/`** — the bridge work should follow it exactly.

### 1.7 What does NOT exist today [C]

- No network servers or sockets of any kind (verified: no `dgram`/`net`/`http.createServer`/
  `WebSocket` usage anywhere in `main/`, `shared/`, `renderer/`).
- No serial **writes** — `CrsfSerialSource` only reads; there is no CRSF *encoder* for RC
  channels in this repo at all (the JS `crsf.js` is decode + CRC only).
- No control path: driving belongs to elrs-joystick-control, a separate program
  (`README.md` "Viewer only").

---

## 2. Telemetry snapshot export readiness

### 2.1 Normalized state that already exists [C]

The `Telemetry` object (`shared/telemetry.js` typedef) is already the normalized,
transport-independent snapshot: `speedKmh`, `batteryV`, `batteryPct`, `linkQualityPct`,
`gear`, `ersPct`, `driveMode` (+ demo-only `armed`/`failsafe`). `CrsfSerialSource`
already maintains the **merged running snapshot** the iPhone would want (its `_telem`
accumulator), and `main.js:74` already fans each snapshot out to a consumer (the
renderer). Adding a second consumer (a UDP sender) is architecturally trivial: subscribe
the sender alongside `win.webContents.send` on the same `onTelemetry` callback.

### 2.2 Field match vs. the iPhone HUD's expected telemetry

**[A] The iPhone app's telemetry schema is not available in this workspace** — no iPhone
repo/spec exists under `~/Documents/projects/`. Alignment of exact field names/units is
batch W1 work. Against a *reasonable* FPV-HUD expectation:

| iPhone HUD likely wants | Ground station has | Notes |
|---|---|---|
| speed | `speedKmh` [C] | car-authoritative (Hall → GPS 0x02 groundspeed) |
| battery V / % | `batteryV`, `batteryPct` [C] | |
| link quality | `linkQualityPct` [C] | also the link-loss signal |
| gear, drive mode, ERS | `gear`, `driveMode`, `ersPct` [C] | car-authoritative via FLIGHTMODE 0x21 |
| link/telemetry state | derivable [C] | reuse `shared/linkState.mjs` on the Windows side and **send the derived state string** so both HUDs agree (don't make the iPhone re-derive with different constants) |
| throttle/brake/steer/DRS mirror | **missing in main** [C] | lives only in the renderer's gamepad loop (`hud.js` `S`); main never sees it — see 2.4 |
| armed / failsafe | demo-only [C] | must NOT be exported as if real; either omit or mark `source: "demo"` |
| timestamps / sequence no. | missing [C] | snapshot has no `t`/`seq`; a UDP export needs both (loss/reorder detection, staleness on the phone) |
| video endpoint info | missing [C] | see §5 |

### 2.3 Missing pieces to build (batch W2, not now)

1. **Snapshot builder** — a pure `shared/` module that takes (mergedTelemetry, derived
   linkState, seq, timestampMs) → one JSON-serializable export object with a `v: 1`
   protocol version. Pure = unit-testable with canned inputs, per repo style.
2. **Rate limiter** — telemetry arrives ~5 Hz from CRSF but per-frame from the merge
   (each CRSF frame type triggers an emit); the replay source emits at 20 Hz. The sender
   should coalesce to a fixed cadence (e.g. 10 Hz) rather than forwarding every emit. [I]
3. **UDP sender** — thin `node:dgram` wrapper in `main/`, mirroring the
   `CrsfSerialSource` thin-I/O pattern (socket + reconnect in main, zero logic).

### 2.4 The command-mirror question (decision for W1)

If the iPhone HUD wants throttle/brake/steer widgets, the data is currently renderer-only
(Gamepad API). Options: (a) iPhone HUD shows car-side truth only — **no code-path change,
recommended for W2** [I]; (b) add a renderer→main IPC channel publishing the mirror at
~10 Hz so the sender can include it — small, but it grows the preload surface and is
display-only data; defer until the iPhone spec proves it's wanted.

### 2.5 Where the sender lives

**Main process, unambiguously.** [I — from the repo's own architecture]
- The merged snapshot and all telemetry sources already live in main.
- The renderer is sandboxed with no Node access (`preload.cjs`); giving it sockets would
  punch a hole in a deliberate security boundary.
- Precedent: mediamtx supervision and serial I/O are main-process, logic is `shared/`.

Split: `shared/` = snapshot builder + (later) any encode/validate logic → vitest;
`main/` = the ~40-line dgram wrapper, enabled only by explicit env/config
(e.g. `W17_IPHONE_BRIDGE=1`, `W17_IPHONE_ADDR=<phone-ip>:<port>`), default **off**. [I]

Transport note [A]: PC and iPhone must share a network (both on the camera's 5.8 GHz AP,
or a hotspot) — same unknown as the video phase; measure in W4.

---

## 3. Head-tracking receive readiness (log-only)

> **Update 2026-07-15 — owner decision #1 (topology (a)).** Production ownership of UDP
> **5602 moves to the owned mapper fork** (`w17-mapper`, the forked elrs-joystick-control;
> see `w17-control-fw/project-review/head_tracking_unlock_plan.md §2.3.7-§2.3.8`). The mapper
> now hosts the log-only head-intent receiver (new pure-Go `pkg/headintent`, implemented +
> tested 2026-07-15). This ground station stays **viewer / configuration / log-only** and
> gains, later, only a **read-only** head-intent diagnostic snapshot from the mapper (transport
> TBD — owner picks gRPC vs localhost-HTTP; no control relay). **The GS `HeadTrackingReceiver`
> below and the mapper receiver are mutually exclusive on 5602** (plain exclusive UDP bind, no
> `SO_REUSEPORT`): if the GS receiver is retained for rollback, it must **not** bind 5602 while
> the mapper is the active ingester. No change to the canonical iPhone contract. The 400 ms
> figure in §3.4 below is superseded by the canonical **300 ms** receive-time authority
> (299/300 fresh, 301 stale).

### 3.1 Where the receiver fits

Same seam as the sender: a thin `main/` UDP listener (e.g. `HeadTrackingReceiver`,
`node:dgram` bound to a configured port, default off), with **all parsing/validation in a
pure `shared/` module**. It is a *sink*: in this phase its only outputs are log lines and
an in-memory diagnostics buffer. It must **not** emit into `TelemetrySource`, IPC, or any
object the renderer or (nonexistent) control path consumes — see 3.5.

### 3.2 Parsing and validating JSON

Pure function, e.g. `shared/headTracking.js: parseIntentPacket(buf, nowMs)` →
`{ ok: true, intent } | { ok: false, reason }`. Validation gauntlet (each step short-circuits
to a reject with a machine-readable `reason`):

1. Size guard — reject datagrams > ~512 B before parsing (UDP is unauthenticated input).
2. `JSON.parse` in try/catch → reject `malformed-json`.
3. Schema: exact required fields, e.g. `{ v, type: "head-intent", seq, tMs, enabled, panDeg, tiltDeg, centered }` [A — field names to be aligned with the iPhone app in W1]; unknown `type` or missing field → reject `bad-schema`; wrong version → `bad-version`.
4. Range: pan/tilt within declared limits (e.g. ±90°), finite numbers → reject `out-of-range`.
5. `enabled !== true` → reject `disabled` (logged, never processed further).
6. Session gate: until a packet with `centered: true` (or pan/tilt within a small neutral
   window) has been seen, reject `uncentered` — the analog of the firmware's
   "no arm-into-full-throttle" rule: a stream must start from neutral. [I]
7. Staleness/order: `seq` regression → `stale-seq`; and receiver-side wall-clock gap
   (see §4) → `stale`.

### 3.3 Logging packets safely

- Log the **decoded, validated summary**, never raw payload echoes (no log injection from
  an unauthenticated socket): fixed-format line, numbers formatted, strings whitelisted.
- Rate-limit logging (e.g. 1 summary line/s + every rejection *reason count*, not every
  packet at 30–60 Hz) so a chatty phone can't flood the console/disk. [I]
- Route through the same `log` callback style the repo already uses
  (`MediamtxSupervisor`, `CrsfSerialSource` take an injected `log`) — testable.

### 3.4 Diagnostics storage

- In-memory **ring buffer** (e.g. last 256 intents + last 64 rejects with reasons) in the
  receiver, exposed only for tests/debug dumps.
- Optional file: append JSONL to Electron's `app.getPath('userData')`/`logs/head-intent-YYYYMMDD.jsonl`
  behind a second explicit flag (`W17_HEADTRACK_LOGFILE=1`) — off by default so bench runs
  don't silently grow files. [I]
- Counters: received / accepted / rejected-by-reason / last-seq / last-rx-time — cheap to
  assert in tests and to print on shutdown.

### 3.5 Enforcing log-only behavior

Structural, not aspirational:

1. The receiver module **exports no data accessor** used by any other runtime module —
   `main.js` constructs it, `start()`s it, `stop()`s it; nothing consumes it.
2. It never touches `TelemetrySource`, `ipcMain`/`webContents.send`, `serialport`,
   or the mediamtx supervisor. (Today the repo has no control path at all to touch —
   §4 — keep it that way.)
3. A **regression test** (see §6) asserts the module graph: nothing in `main/` or
   `shared/` imports the head-tracking module except `main.js` and its own tests, and the
   module's public surface is `{start, stop, getDiagnostics}` only.
4. Code comment + doc marker (this file) stating the phase rule, so a future diff that
   wires intents anywhere is visibly a *phase change*, reviewable as such.

---

## 4. Safety boundaries

- **No CRSF/servo mapping exists or will be added in this phase.** [C today: the repo
  contains no CRSF encoder for RC channels, no serial writes, no PWM/servo concepts at
  all. The head-tracking receiver terminates at a log.]
- **No vehicle-control path from the iPhone is possible through this app** [C]: the
  ground station is viewer-only (`README.md`); driving is elrs-joystick-control on a COM
  port this app never opens for write. Even a hypothetically malicious packet has no code
  path to reach the car. The bridge work must preserve exactly this property.
- **Stale timeout:** intent packets older than **400 ms** (receiver wall-clock since last
  accepted packet; > the required ~300 ms floor, distinct from the HUD's 1000 ms
  `TELEMETRY_FRESH_MS`) are rejected as `stale` and the session gate re-arms (a fresh
  `centered` packet is required to resume acceptance).
  *(Superseded 2026-07-14: the ratified stale authority is **300 ms receive-time**,
  matching the canonical contract §3 and the implemented `W17_HEADTRACK_STALE_MS`
  default of 300. Deterministic boundary: age ≤ 300 ms fresh, > 300 ms stale. See
  `w17-control-fw/project-review/head_tracking_unlock_plan.md §1.1`.)* Rationale: head-tracking is a
  future *rate-limited camera aim*, not a control loop; when mapping is eventually
  designed, stale intent must decay to center, never hold last value. In *this* phase the
  timeout only classifies log entries — but the constant and test land now so W-later
  inherits them. [I]
- **Rejection classes (all logged with reason, none processed):** malformed JSON / bad
  schema / bad version, `enabled: false`, uncentered session start, out-of-range values,
  stale (seq regression or 400 ms gap).
- **Authority:** the DualShock via elrs-joystick-control remains the only control
  authority; the TX16S handset remains the radio-level backup. Nothing the iPhone sends
  can change either. Head-tracking, when eventually mapped, goes iPhone → Windows →
  (existing PC→CRSF path) → car, and only after explicit approval + bench validation.

---

## 5. Video compatibility

- **Current Windows path** [C]: camera RTSP → mediamtx (localhost) → WHEP `:8889/cam/whep`
  → renderer `<video>`. Auto-retry on drop; H.264 bench gate; VLC-on-RTSP fallback.
- **iPhone direct video is independent** [C/I]: the camera's RTSP (and mediamtx's `:8554`
  re-serve) can serve another client without any ground-station code change; an iPhone on
  the camera AP playing RTSP directly involves zero Windows involvement (per the
  onboarding assessment, architecture D). The bridge phase does not need to touch video.
- **Windows could later expose video endpoint info** [I]: the telemetry snapshot (or the
  `config:get`-style handshake, mirrored into the UDP protocol) is the natural place to
  advertise `{ whepUrl, rtspUrl, codec }` so the phone auto-discovers the stream instead
  of hardcoding IPs. Design in W1; implement only when the mirrored-video decision (A/B
  from the onboarding report) is made.
- **Do not change yet:** `mediamtx.yml` stays localhost-only (`webrtcAdditionalHosts`);
  no LAN exposure, no transcode entries, no second path. Opening mediamtx to the LAN is a
  deliberate, reviewed step in the video phase — not a side effect of the bridge phase.

---

## 6. Required tests (all vitest, pure `shared/` modules, injected clocks — repo style)

| Test | Asserts |
|---|---|
| **Snapshot builder** | canned merged telemetry + link state → exact export JSON (fields, units, `v`, `seq`, `tMs`); partial telemetry → partial snapshot (absent ≠ zero); demo-only `armed`/`failsafe` never exported as real. |
| **UDP sender (mock)** | with an injected fake socket + fake clock: coalesces emit bursts to the configured cadence; stops cleanly; disabled-by-default (no socket created without the env flag). Practical because the sender takes the socket factory as a constructor arg, mirroring `ReplaySource`'s injected scheduler. |
| **Intent parser** | golden accepted packet decodes exactly; each rejection class (malformed, bad-schema, bad-version, out-of-range, disabled, uncentered, seq-regression) returns its distinct `reason`; oversized datagram rejected before parse. |
| **Stale timeout** | injected clock: gap > 400 ms → `stale` + session gate re-arms (next packet must be centered); gap < 400 ms accepted; boundary case pinned. |
| **Log-only guard** | receiver with N mixed packets produces log lines + diagnostics counters and **nothing else** — its emitted-events list is empty, no IPC spy called; public surface is exactly `{start, stop, getDiagnostics}`. |
| **No-control-path regression** | static assertion test: no module in `main/`+`shared/` matches `/serialport.*write|dgram/` outside the two bridge files; head-tracking module imported only by `main.js` + its test; `shared/crsf.js` still exports no RC-channel encoder. Cheap grep-style test that turns the phase's safety rule into CI. |

Golden vectors for the two packet formats should be committed as fixtures (like
`test/fixtures/crsf_golden.json`) and **shared with the iPhone repo** so both ends pin the
same bytes — the proven firmware↔ground-station pattern.

---

## 7. Recommended implementation batches

- **W1 — docs + protocol alignment only (no code).** Obtain the iPhone app's actual
  telemetry/intent schemas; fix field names, units, ports, cadence, version fields; write
  `docs/iphone_bridge_protocol.md` with golden example packets; decide the command-mirror
  question (§2.4) and the video-endpoint advertisement shape (§5). Exit: both repos agree
  on the byte-level contract.
- **W2 — Windows → iPhone telemetry snapshot sender.** `shared/` snapshot builder + tests;
  `main/` dgram sender behind `W17_IPHONE_BRIDGE` env flag, default off; subscribe next to
  the existing renderer push. No renderer changes. Exit: `npm run demo` + flag streams
  snapshots a laptop-side listener script can print.
- **W3 — iPhone → Windows head-tracking receiver, log-only.** `shared/` parser/validator +
  full rejection gauntlet + tests (incl. stale + log-only guard + no-control-path
  regression); `main/` listener, ring-buffer diagnostics, rate-limited logging. Exit: fake
  packets from a script produce correct accept/reject logs and zero side effects.
- **W4 — integration test with a fake iPhone.** A `scripts/fake-iphone.js` (or vitest
  integration spec) that consumes snapshots and emits scripted intent sequences — happy
  path, malformed floods, stale gaps, uncentered starts; measure snapshot cadence and
  loss on a real shared network (camera AP or hotspot — the §2.5 unknown). Exit: soak run
  clean, counters match script expectations.
- **Later milestone (separate approval): pan/tilt mapping design.** Paper design only for
  intent → (Windows) → existing PC→CRSF ch9/ch10 gimbal path, with rate limits,
  center-decay on staleness, and an explicit user-facing enable. **No active servo output
  until bench validation, and no iPhone→car direct path ever in this architecture.**

---

*Sources: `main/main.js`, `main/CrsfSerialSource.js`, `main/mediamtx.js`, `main/preload.cjs`,
`shared/telemetry.js`, `shared/linkState.mjs`, `shared/crsfTelemetry.js`, `shared/replaySource.js`,
`renderer/hud.js`, `renderer/whep.js`, `mediamtx/mediamtx.yml`, `docs/TELEMETRY.md`,
`docs/SETUP.md`, `README.md`, `package.json`, `test/*.test.js`.*
