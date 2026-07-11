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
npm test                    # pure-core unit tests (no hardware)
npm start                   # launch the app (video needs the camera; see docs/SETUP.md)
npm run demo                # launch with the replay telemetry source (live-looking, no car)
npm run build               # package a Windows .exe (electron-builder; unsigned by
                            #   default -- code-signing is opt-in, see docs/CODESIGNING.md)
```

Runs on Windows, macOS and Linux (Electron is cross-platform; the `.exe` is just the
deployment target). Cross-platform is proven by CI + the pure-core tests; the GUI + WebRTC
video are verified on the target machine.

### Pre-ride setup flow (pit wall)

The app opens into a four-step, F1-styled setup instead of a bare start button:

1. **GARAGE** — pick the session: *Desktop FPV* (laptop only) or *iPhone Cockpit* (adds
   the telemetry bridge + network step; live HUD on the iPhone today, the planned FPV/VR
   view later). Persisted values stay `solo` / `iphone-hud` — display labels only.
2. **PIT WALL** *(iPhone mode, Windows)* — scan and join a WiFi network, or start a local
   hotspot (SSID `W17-GRID` by default; Mobile Hotspot backend preferred, legacy
   `hostednetwork` fallback for the RT5370 dongle). An ADAPTER row always shows which
   WLAN adapter netsh will use: readonly with one adapter, a picker with several
   (pinning scan/join to the chosen interface, persisted), and a dongle
   troubleshooting hint when none is detected or listing fails. RESCAN re-detects
   adapters as well as networks, so plugging the dongle in mid-step just works.
   The client-isolation warning is a one-line hint (full text on hover) — pick a network
   that allows device-to-device traffic. Enter/confirm the iPhone's IP (validated; a
   suggestion chip appears when the log-only head-track listener is hearing the phone).
   On macOS/Linux this step is guide-mode: instructions + verify.
3. **SEAT FIT** — connected gamepads are detected automatically (first pad tagged *auto*)
   with a manual override; the layout preset (DualShock / Xbox / generic) is auto-suggested
   from the pad type and shown as a visual button-mapping preview (informational only — no
   camera/pan-tilt mapping) next to a live test strip. Keyboard fallback remains.
4. **GRID** — pre-race checklist: video lock, controller, telemetry (when configured),
   iPhone reachability (iPhone mode), elrs-joystick-control detected (with a LAUNCH
   button). START enables when required checks pass; an amber **START ANYWAY** always
   works — the viewer must never lock you out of driving. Then five red lights… lights out.

Choices persist in `settings.json` under Electron's userData dir; **env vars always
override persisted settings** (dev/CI behavior unchanged). The ⚙ menu is a modal
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
Either way the receiver stays LOG-ONLY — its only side effect beyond logs is exposing
the last sender's IP as an address *suggestion* in the setup flow (user-confirmed,
never packet contents).

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
| `main/` | Electron main: mediamtx supervisor, telemetry source, IPC push, iPhone telemetry bridge (UDP send) |
| `renderer/` | the HUD page, WHEP video client, telemetry overlay |
| `mediamtx/` | pinned config (binary fetched, not committed) |
| `test/` | vitest specs, reusing the firmware's golden CRSF vectors |

Architecture, tradeoffs, and the design-review findings are recorded in the plan and in
`docs/`.
