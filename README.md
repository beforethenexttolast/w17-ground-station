# w17-ground-station

Ground-station app for the 1/10 FPV Mercedes W17 RC car — the laptop-side companion to
[w17-control-fw](https://github.com/beforethenexttolast/w17-control-fw) (car ESP32 #1) and
w17-soundlight-fw (car ESP32 #2).

An **Electron** app that overlays a Mercedes-livery F1 HUD on the live FPV video:
- **Video** — OpenIPC camera RTSP → a bundled **mediamtx** → **WebRTC/WHEP** rendered as the
  full-screen background (low latency; WebRTC not HLS).
- **HUD** — throttle/brake/steering/DRS/boost/overtake/gear mirrored live from the DualShock
  (Gamepad API), plus a simulated speed/rpm/ERS animation, all in the F1 dash style.
- **Telemetry overlay** — real speed, gear, drive mode, ERS%, battery and link quality from the
  car replace the simulated values when a telemetry source is connected. Link loss is derived
  on the ground (LQ 0 → "LINK LOST"; a stalled stream → "TELEMETRY LOST" holding the last real
  values dimmed — the HUD never silently falls back to simulation once telemetry has been live).

## Viewer only — it does NOT drive the car

Control stays with **elrs-joystick-control** (DualShock → CRSF → ELRS TX module), which runs
alongside. This app reads the gamepad purely to *mirror* inputs on-screen. A bug here can never
stop the car — deliberate gift-day safety. The zero-code fallback (elrs-joystick-control + VLC
on the raw stream) is always available.

## Run

```
npm install
npm run setup               # fetch mediamtx + repair the Electron binary if the install
                            #   was blocked by a script gate (see Troubleshooting)
npm test                    # unit/integration suite (pure-core + wiring; no hardware)
npm run smoke:electron      # boot the REAL app in 4 scenarios; passes on a structured
                            #   readiness handshake, not on process launch (no hardware)
npm start                   # launch the app (video needs the camera; see docs/SETUP.md)
npm run demo                # launch with the replay telemetry source (live-looking, no car)
npm run build               # package a Windows .exe (electron-builder; unsigned by
                            #   default -- code-signing is opt-in, see docs/CODESIGNING.md)
npm run proto:check         # verify the head-intent proto mirror matches ../w17-mapper
                            #   (dev-only; not part of the hermetic test suite)
```

(Two different "demos": the floating **▶ HUD preview · simulated** button on the setup
gate just plays simulated inputs/physics into the HUD, while `npm run demo` feeds the
replay **telemetry** source — live-looking car data, no car.)

Runs on Windows, macOS and Linux (Electron is cross-platform; the `.exe` is just the
deployment target). CI runs the full suite on Ubuntu (fast gate) and, on windows-latest,
runs the suite **plus** `npm run smoke:electron` (a real boot of the app under a scrubbed,
Wi-Fi-simulated environment) **plus** an `electron-builder --dir` package build — so the
deployment target proves tests, runtime boot, and packaging every push. CI does **not**
prove real Wi-Fi, camera, iPhone, ELRS, or Windows DPAPI behavior — those are bench items
(`docs/setup_flow_bench_checklist.md`). The GUI + WebRTC video are verified on the target
machine.

### Pre-ride setup flow (pit wall)

The app opens into a four-step, F1-styled setup instead of a bare start button:

1. **GARAGE** — pick the session: *Desktop FPV* (laptop only) or *iPhone Cockpit* (adds
   the telemetry bridge + network step; live HUD on the iPhone today, the planned FPV/VR
   view later). Persisted values stay `solo` / `iphone-hud` — display labels only.
2. **PIT WALL** *(iPhone mode, Windows)* — scan and join a WiFi network, or start a local
   hotspot (SSID `W17-GRID` by default; Mobile Hotspot backend preferred, legacy
   `hostednetwork` fallback for the RT5370 dongle). Each scanned network is classified by
   security before you can act on it: **open** networks join with an `OPEN NETWORK —
   unencrypted` warning; **WPA2-PSK** and **WPA2/WPA3 transition** networks join normally
   (the WPA2-compatible path); **WPA3-only**, **enterprise (802.1X)**, and networks whose
   security can't be identified are rejected up front with a clear message (never a raw
   netsh error), unless Windows already has a saved profile for that network (which is
   joined through the stored profile). Hidden-network manual entry is out of scope. The
   hotspot has an explicit lifecycle: **START HOTSPOT** / **STOP HOTSPOT** with live
   state (STARTING → VERIFYING → READY / NOT READY FOR CLIENTS → STOPPING). A successful
   start *command* is never shown as client-ready on its own: the app checks local
   readiness (tether state, the ICS `192.168.137.x` gateway, and the required services)
   and reports **READY** or **NOT READY FOR CLIENTS**, and if the backing adapter vanishes
   the hotspot is marked interrupted — "ready" means "nothing locally wrong", never a proof
   that a client obtained a lease. The app only ever stops a hotspot **it** started —
   quitting with an app-owned hotspot live prompts *STOP AND QUIT / LEAVE RUNNING /
   CANCEL*; an externally-owned hotspot is never touched. An ADAPTER row always
   shows which WLAN adapter netsh will use: readonly with one adapter, a picker with
   several (pinning scan/join to the chosen interface, persisted), and a dongle
   troubleshooting hint when none is detected or listing fails. RESCAN re-detects
   adapters as well as networks, so plugging the dongle in mid-step just works.
   The client-isolation warning is a one-line hint (full text on hover) — pick a network
   that allows device-to-device traffic. Enter/confirm the iPhone's IP (validated; a
   suggestion chip appears when the log-only head-track listener is hearing the phone).
   On macOS/Linux this step is guide-mode: instructions + verify.
3. **SEAT FIT** — connected gamepads are detected automatically (first pad tagged *auto*)
   with a manual override; the layout preset (DualShock / Xbox / generic) is auto-suggested
   from the pad type and shown as a visual button-mapping preview (informational only — no
   camera/pan-tilt mapping) next to a live test strip. Pressing a button lights it up in
   the preview, proving the mapping instantly. Keyboard fallback remains.
4. **GRID** — pre-race checklist: video lock, controller, telemetry (when configured),
   iPhone reachability (iPhone mode), elrs-joystick-control detected (with a LAUNCH
   button). A summary strip shows what's configured (mode · network · adapter · pad) and
   every failing check carries a one-line fix hint. START enables when required checks
   pass; an amber **START ANYWAY** always works — the viewer must never lock you out of
   driving. Then five red lights… lights out.

Choices persist in `settings.json` under Electron's userData dir; **env vars always
override persisted settings** (dev/CI behavior unchanged). The one persisted secret — the
hotspot password — is **encrypted at rest** via Electron `safeStorage` (Windows DPAPI /
macOS Keychain / Linux libsecret); it is never written to disk in plaintext (including the
`.bak`), there is no app-managed key, and when secure storage is unavailable the password
is kept for the session only rather than persisted. Transient Wi-Fi *join* passwords are
never persisted at all. The ⚙ menu is a modal
(backdrop click / Escape closes) holding radio-sound (off by default), the start-lights
countdown toggle (on by default; off = straight into the HUD), the log-only head-track
toggle, the elrs-joystick-control path (launch-only: this app starts it detached and can
never stop it), and telemetry source/COM port. `docs/proposals/iphone_mdns_discovery.md` sketches zero-config
iPhone discovery (needs the iPhone-side, Codex-owned change first).

The OS-touching pieces (netsh scan/join, both hotspot backends, elrs detection) are
unit-tested against canned command output but **not yet validated on the Windows
bench** — `docs/setup_flow_bench_checklist.md` is the step-by-step runbook with
evidence boxes; treat those paths as unproven until it's executed.

Any OS can *preview* the network step against that same canned output:
`W17_WIFI_SIM=two-adapters npm start` (also `one-adapter`, `no-adapter`,
`netsh-fail`) runs the real WiFi/hotspot managers and parsers on a simulated
netsh/powershell, so PIT WALL scan/join/hotspot work on the macOS dev machine with
no hardware. A **SIMULATED WIFI** tag marks the step; this is a dev preview only and
never counts as bench evidence.

### iPhone telemetry bridge (optional, off by default)

Windows can also stream the normalized telemetry snapshot to the companion iPhone FPV
HUD app as UDP/JSON — **send-only, viewer companion, no control authority** (the iPhone
cannot drive the car; the firmware never sees it). Off unless explicitly enabled. The
packet shape is the iPhone app's own contract (snake_case fields, unknown fields
omitted): `docs/windows_bridge_contract.md`.

```
W17_IPHONE_BRIDGE=1          # master enable (unset = off, no socket opened)
W17_IPHONE_ADDR=192.168.1.9  # iPhone IPv4 (required when enabled; missing = disabled)
W17_IPHONE_PORT=5601         # destination UDP port (default 5601, per the iPhone contract)
W17_IPHONE_RATE_HZ=10        # send cadence in Hz (default 10)
```

The bridge is a second consumer of the existing telemetry flow plus a read-only display
mirror of the HUD's gamepad/camera state, so the on-screen HUD is unaffected and nothing
flows back. With `W17_IPHONE_BRIDGE` unset the app behaves exactly as before.

The setup flow can also enable it without env vars: *iPhone Cockpit* mode + a confirmed
iPhone IP starts the same sender. If `W17_IPHONE_BRIDGE` is set (even to `0`), the env
var wins outright.

### iPhone head-tracking receiver (optional, off by default, LOG-ONLY)

Windows can also *receive* the iPhone app's head-tracking intent packets (UDP/JSON on
port 5602) — **strictly log-only**: packets are validated, counted, and summarized to the
console, and nothing else happens. No CRSF, no servos, no camera pan/tilt, no control —
that mapping is blocked until a separate safety milestone. Off unless explicitly enabled.

```
W17_HEADTRACK=1            # master enable (unset = off, no socket bound)
W17_HEADTRACK_PORT=5602    # UDP listen port (default 5602, per the iPhone contract)
W17_HEADTRACK_BIND=0.0.0.0 # bind address (default all interfaces)
W17_HEADTRACK_STALE_MS=300 # receive-time stale authority (default 300 ms)
```

Test it with the iPhone repo's fake sender (no phone needed):
`python3 iPhone_rc/scripts/send_fake_head_tracking.py --host <this-pc> --port 5602 --pattern sine`
— the console shows `[headtrack] state=active_log_only rate=30/s ...` lines and state
transitions (`idle/inactive/not_centered/active_log_only/stale/invalid`).

The ⚙ settings menu has the same switch ("head-track logging — diagnostic only, no
camera control"), off by default; a set `W17_HEADTRACK` env var (even `0`) overrides it.
While the listener is active, the HUD session panel shows an amber
`HEAD-TRACK LOG · NO CONTROL` chip — driven by the listener's on/off state only, never
by received packets. Either way the receiver stays LOG-ONLY — its only side effect
beyond logs is exposing the last sender's IP as an address *suggestion* in the setup
flow (user-confirmed, never packet contents).

### Mapper head-intent diagnostics subscriber (optional, off by default, DISPLAY-ONLY)

In the production VR-FPV topology the **mapper** (the owned elrs-joystick-control fork,
`w17-mapper`) owns UDP 5602 head-intent ingest and republishes a **read-only** diagnostic
snapshot over its existing gRPC service on `:10000`. This app can *subscribe* to that
stream and render it — it never binds 5602 itself and never talks back to the mapper.

```
W17_MAPPER_HEADINTENT=1              # master enable (unset = off, no gRPC client)
W17_MAPPER_GRPC_ADDR=127.0.0.1:10000 # mapper gRPC endpoint (default loopback)
```

- **Subscriber-only, display-only.** The consumer runs in the Electron **main** process
  (`main/HeadIntentDiagnosticsClient.js` over `@grpc/grpc-js` + `@grpc/proto-loader`,
  reading `proto/head_intent_diagnostics.proto`). It calls exactly one RPC — the read-only
  server-streaming `WatchHeadIntentDiagnostics` — and the mirrored proto declares **no
  setter**, so there is no control path even at the wire level. Snapshots go one-way to
  the renderer, which only draws them (`shared/headIntentView.mjs`); it never recomputes
  freshness or reinterprets `receive_age_ms` — the mapper is authoritative.
- **Mutual exclusivity (topology (a)).** UDP 5602 has exactly one owner. Enabling this
  consumer means the **mapper** owns 5602, so the local W3 receiver (`W17_HEADTRACK`) is
  **force-disabled** while `W17_MAPPER_HEADINTENT=1` — even if the W3 wish/env would
  otherwise enable it (a second bind on 5602 would fail anyway). Turn the consumer off to
  return to Electron-owns-5602 (log-only W3) mode.
- **Robustness.** Reconnects with bounded backoff on stream end/drop; a mapper restart, a
  disabled ingest (`UNAVAILABLE`), or the mapper's 4-stream cap (`RESOURCE_EXHAUSTED`) all
  render as clear HUD display states (`MAPPER OFFLINE / INGEST OFF`, `STREAM BUSY · CAP 4`,
  `RECONNECTING`), never crashes — and never affect the elrs launcher.
- The HUD session panel shows a `HEAD-INTENT · <state> · NO CONTROL` chip while the
  consumer is enabled; hidden otherwise. See `docs/head_intent_diagnostics.md`.

### Troubleshooting (dev environment)

- **"Electron failed to install correctly"** — your npm blocked Electron's postinstall (a
  lavamoat `allowScripts` gate, corporate npm, or `ignore-scripts`), so the binary never
  extracted. `npm run setup` repairs it by extracting the cached download directly. (If the
  cache is empty, run `node node_modules/electron/install.js` once to download, then
  `npm run setup`.)
- **App boots as bare Node / `Cannot read properties of undefined (reading 'whenReady')`** —
  your terminal exports `ELECTRON_RUN_AS_NODE=1` (the **VS Code integrated terminal** leaks
  this because VS Code is itself Electron). `npm start` / `npm run demo` go through
  `scripts/run.js`, which strips that variable, so use those rather than `electron .` directly.

**Before first real use, work through `docs/SETUP.md`** — it lists the hardware verifications
that gate the video pipeline (chiefly: is the camera emitting H.264 or H.265? WebRTC needs
H.264). `docs/TELEMETRY.md` defines the telemetry contract for the car firmware.

## Layout

| path | role |
|---|---|
| `shared/` | pure, unit-tested: CRSF parser (ported from the firmware), telemetry types, replay source, feel constants, iPhone snapshot builder |
| `main/` | Electron main: mediamtx supervisor, telemetry source, IPC push, iPhone telemetry bridge (UDP send), read-only head-intent diagnostics subscriber |
| `renderer/` | the HUD page, WHEP video client, telemetry overlay |
| `mediamtx/` | pinned config (binary fetched, not committed) |
| `proto/` | subscriber-only mirror of the mapper's head-intent diagnostics `.proto` + its canonical drift-guard snapshot |
| `test/` | vitest specs, reusing the firmware's golden CRSF vectors |

Architecture, tradeoffs, and the design-review findings are recorded in the plan and in
`docs/`.
