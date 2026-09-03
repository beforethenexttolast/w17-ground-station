# w17-ground-station

Ground-station app for the 1/10 FPV Mercedes W17 RC car — the laptop-side companion to
[w17-control-fw](https://github.com/beforethenexttolast/w17-control-fw) (car ESP32 #1) and
w17-soundlight-fw (car ESP32 #2).

An **Electron** app that overlays a Mercedes-livery F1 HUD on the live FPV video:
- **Video** — OpenIPC camera RTSP → a bundled **mediamtx** → **WebRTC/WHEP** rendered as the
  full-screen background (low latency; WebRTC not HLS). Two selectable profiles — DRIVE
  ("racing feel", lowest latency, the default) and SHOWPIECE ("cinema look", smoothest
  picture) — switchable on GARAGE and in ⚙; see `docs/video_profiles.md`.
- **HUD** — throttle/brake/steering/DRS/boost/overtake/gear mirrored live from the DualShock
  (Gamepad API), plus a simulated speed/rpm/ERS animation, all in the F1 dash style.
- **Telemetry overlay** — real speed, gear, drive mode, ERS%, battery and link quality from the
  car replace the simulated values when a telemetry source is connected. Link loss is derived
  on the ground (LQ 0 → "LINK LOST"; a stalled stream → "TELEMETRY LOST" holding the last real
  values dimmed — the HUD never silently falls back to simulation once telemetry has been live).

## Viewer only — it does NOT drive the car

Control stays with **elrs-joystick-control** (DualShock → CRSF → ELRS TX module), which runs
alongside. This app reads the gamepad purely to *mirror* inputs on-screen. A bug here can never
stop a drive program launched from GRID's own LAUNCH button — that path is detached and
launch-only by construction (deliberate gift-day safety). RACE DAY's managed child is the one
exception: this app started it, so this app (STOP RACE DAY, or app teardown) can and does stop
it again — see RACE DAY below. The zero-code fallback (elrs-joystick-control + VLC on the raw
stream) is always available.

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
npm run demo:low-battery    # same replay backend on the low-battery timeline: the pack
                            #   sags through BATTERY LOW and BATTERY CRITICAL (incl. the
                            #   hysteresis hold) so the banner is demoable without
                            #   draining a real pack
npm run build               # package a Windows .exe (electron-builder; unsigned by
                            #   default -- code-signing is opt-in, see docs/CODESIGNING.md)
npm run proto:check         # verify the head-intent proto mirror matches ../w17-mapper
                            #   (dev-only; not part of the hermetic test suite)
npm run feel:check          # verify the ERS/gearbox feel constants still match
                            #   ../w17-control-fw's headers (dev-only, cross-repo;
                            #   --strict makes an absent checkout fail instead of skip.
                            #   Exit 1 = drifted, 2 = could not check, matching
                            #   control-fw's own tools/link2_copy_check.sh)
```

Both cross-repo checks pair with a **hermetic** test that runs in every CI against a
checked-in snapshot, so the snapshot is the single point of coupling and the suite never
needs a sibling checkout: `test/protoDrift.test.js` for the mapper contract and
`test/feelConstantsDrift.test.js` for the firmware feel values. Adopt an intended
upstream change with `npm run proto:sync` / `npm run feel:sync`, then make the hermetic
half green again.

(Two different "demos": the floating **▶ HUD preview · simulated** button on the setup
gate just plays simulated inputs/physics into the HUD, while `npm run demo` feeds the
replay **telemetry** source — live-looking car data, no car.)

Runs on Windows, macOS and Linux (Electron is cross-platform; the `.exe` is just the
deployment target). CI runs the full suite on Ubuntu (fast gate) and, on windows-latest,
runs the suite **plus** `npm run smoke:electron` (a real boot of the app under a scrubbed,
Wi-Fi-simulated environment) **plus** an `electron-builder --dir` package build, **plus**
the unsigned NSIS installer (`npx electron-builder --win nsis --publish never`,
`.github/workflows/ci.yml:67`) — **this is the gift-kit deliverable**, uploaded on every
green run as the `w17-ground-station-nsis-unsigned` artifact (`.exe` + `.blockmap`,
`if-no-files-found: error` so a silent packaging regression fails loudly); smoke logs
upload separately as `electron-smoke-logs` on failure. So the deployment target proves
tests, runtime boot, packaging, and the installer every push. CI does **not** prove real
Wi-Fi, camera, iPhone, ELRS, or Windows DPAPI behavior — those are bench items
(`docs/setup_flow_bench_checklist.md`). The GUI + WebRTC video are verified on the target
machine. `[fix-wave: boundaries-1]` the windows-latest job does not yet run
`node scripts/fetch-mediamtx.js` before packaging, so today's CI-built installer ships
**without** the bundled `mediamtx.exe` — the artifact currently has no working video relay
until that fix lands; a local `npm run build` is unaffected as long as `npm run setup` (or
`npm run fetch-mediamtx`) ran first, since that populates `mediamtx/` on disk before
`electron-builder.yml` copies it in.

### Pre-ride setup flow (pit wall)

The app opens into a five-step, F1-styled setup for an *iPhone Cockpit* session (four for
*Desktop FPV* — PIT WALL is skipped entirely, per `shared/setupSteps.mjs`) instead of a
bare start button. `boot()` always lands on GARAGE first, even for a returning driver —
there is no direct-to-GRID boot path; see the returning-driver card below.

1. **GARAGE** — pick the session: *Desktop FPV* (laptop only) or *iPhone Cockpit* (adds
   the telemetry bridge + network step; live HUD on the iPhone today, the planned FPV/VR
   view later). Persisted values stay `solo` / `iphone-hud` — display labels only.
   A completed prior session shows a **WELCOME BACK — LAST SESSION READY** card here with
   a **STRAIGHT TO THE GRID ▸** button (resumes directly, re-running the GRID checks) and,
   beside it, the **RACE DAY ▸ BRING EVERYTHING UP** control described below.
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
   suggestion chip appears when the log-only head-track listener is hearing the phone,
   or when the HUD announces itself over Bonjour/mDNS on this step). A suggestion is
   only ever *offered* — clicking fills the field, nothing is applied automatically.
   On macOS/Linux this step is guide-mode: instructions + verify.
3. **SEAT FIT** — connected gamepads are detected automatically (first pad tagged *auto*)
   with a manual override; the layout preset (DualShock / Xbox / generic) is auto-suggested
   from the pad type and shown as a visual button-mapping preview (informational only — no
   camera/pan-tilt mapping) next to a live test strip. Pressing a button lights it up in
   the preview, proving the mapping instantly. Keyboard fallback remains.
   An **input type** switch (GAMEPAD / WHEEL / BOTH, chosen per session) adds optional
   **steering-wheel** support: a generic wheel profile with manual axis/button assignment +
   pedal rest/full calibration and a live wheel/pedal input preview. The wheel mirrors
   **steering / throttle / brake only** on the HUD (camera pan/tilt stays gamepad-only); it
   is a display mirror like everything else here — no control path. Activation always boots
   GAMEPAD and is never saved; only the calibrated wheel profile persists.
4. **SETUP** — mode & camera display preferences, split from SEAT FIT
   (`renderer/index.html` `data-step="setup"`): **DRIVE MODE** is a persisted *display*
   preference for how the HUD previews throttle/gears/energy (NORMAL/SIMULATION/FULL SIM)
   — not a control command, the car's own reported drive mode always wins in the HUD once
   telemetry is live. **CAMERA MODE** shows the setup-time AVAILABLE/REQUESTED default
   (manual, right-stick) beside an ACTIVE AUTHORITY line that stays "NOT REPORTED BY
   MAPPER" — this viewer never observes which source the mapper actually picks. Head
   Tracking is listed but LOCKED (no safe control path yet).
5. **GRID** — pre-race checklist: video lock, controller, telemetry (when configured),
   iPhone reachability (iPhone mode), elrs-joystick-control detected (with a LAUNCH
   button). A summary strip shows what's configured (mode · network · adapter · pad) and
   every failing check carries a one-line fix hint. START enables when required checks
   pass; an amber **START ANYWAY** always works — the viewer must never lock you out of
   driving. Then five red lights… lights out.

### RACE DAY (one-action bring-up, GARAGE)

Alongside the returning-driver **STRAIGHT TO THE GRID** card, GARAGE also shows a
**RACE DAY ▸ BRING EVERYTHING UP** control (`main/raceDayOrchestrator.js`,
`shared/raceDayView.mjs` for the plain-language step lines). One press sequences three
existing authorities in order — nothing here is a new one:

1. **Car Wi-Fi** — if the saved network plan is the hotspot, starts (or re-verifies) it
   through the same hotspot lifecycle PIT WALL uses.
2. **Drive program** — starts the configured drive program (the mapper /
   elrs-joystick-control binary) as a **managed child** (`main/mapperRunner.js`) with the
   saved controller profile, *if* it isn't already running (either race-day-managed or
   detected running externally, e.g. launched from GRID's own LAUNCH button).
3. **Phone link** — switches on the W2 telemetry bridge per settings, for iPhone sessions
   that opted in.

The drive-program location, the saved controller-profile path, and the "switch the phone
link on too" checkbox are set once in the ⚙ **RACE DAY** fields (see the ⚙ inventory
below) — the giftee only ever presses the one GARAGE button. The sequence halts at the
first failing step (nothing already up is wound back); pressing RACE DAY again re-runs
idempotently. **STOP RACE DAY** is keyed on the managed drive-program child appearing to
run (`shared/raceDayView.mjs:135` `stopVisible`) and stops *only* that child — the
hotspot stays governed by PIT WALL / the quit dialog, exactly as before this feature.

`[fix-wave: lifecycle-concurrency-3]` **Today's truth:** the button is not a live gauge
in the moment right after you press it. `MapperRunner.stop()` (`main/mapperRunner.js:
162-172`) signals the child but leaves `_proc` set until the child's own `exit` event
fires later; the orchestrator winds its own step to `idle` synchronously
(`main/raceDayOrchestrator.js` `stop()`), so by the time that real `exit` event arrives
the liveness mirror's guard (`:104-111`, `this._steps.mapper.status !== 'ok'`) is already
true and it never re-emits. So a fresh snapshot pushed to the renderer right after STOP
can still report the child as running, and **STOP RACE DAY** can stay visible for a
window after the stop was requested rather than disappearing immediately.

**Command-line policy (the line this feature deliberately draws, and no further):** race
day may manage the drive program's **process** — start, liveness, stop — but never *sends*
it anything. The child's stdin is closed outright (no writable handle exists), there is no
IPC/RPC channel to it and nothing is ever written to the mapper's diagnostic UDP port
(W3 stays exactly as documented above). The **only** command-line flag race day can ever
pass is `-config-file-path <saved profile>` — `MAPPER_ARG_WHITELIST` in
`raceDayOrchestrator.js` is a closed list of exactly that one flag, and the child's
environment is scrubbed of the entire `W17_*` namespace before spawn
(`main/mapperRunner.js` `_childEnv()`) so an experimental mapper flag can never reach it
by inheritance either. `test/noControlPath.test.js` and `test/raceDayOrchestrator.test.js`
pin both the whitelist and the closed-stdin/no-IPC shape structurally — if a change trips
them, the change is wrong.

This is a **different contract** from the GRID's own **ELRS CONTROL** row further down:
that row's LAUNCH button starts the drive program *detached* and is structurally unable to
stop it or talk to it (the launch-only doctrine, unchanged) — a bug in this app can never
stop a program launched that way. RACE DAY's managed child is the opposite case: this app
started it, so this app (STOP RACE DAY, or app teardown) can and does stop it again. Only
one of the two launch paths applies to any given running instance.

`[fix-wave: SYN-2]` **Today's truth:** starting the drive program is not the same as
confirming the actual radio link to the car is up — race day's MAPPER step turns "ok" once
the process is running (or was already running), but nothing in this sequence confirms a
CRSF frame is actually leaving the PC over the station-box serial link. Do not read a green
RACE DAY card as proof the car will respond to the controller; that gap is a tracked,
gift-blocking fix (`SYN-2`) still open as of this pass.

Choices persist in `settings.json` under Electron's userData dir; **env vars always
override persisted settings** (dev/CI behavior unchanged). The one persisted secret — the
hotspot password — is **encrypted at rest** via Electron `safeStorage` (Windows DPAPI /
macOS Keychain / Linux libsecret); it is never written to disk in plaintext (including the
`.bak`), there is no app-managed key, and when secure storage is unavailable the password
is kept for the session only rather than persisted. Transient Wi-Fi *join* passwords are
never persisted at all. The ⚙ menu (`RACE OPS · SETTINGS`, `renderer/index.html`
`#settingsMenu`) is a modal (backdrop click / Escape closes) holding, top to bottom:

- **RADIO SOUNDS** — off by default.
- **START LIGHTS** — the five-red-lights countdown before the HUD. **Off by default**
  (`shared/settings.js` `startLightsEnabled: false`) — the gift-day handover checklist
  (`w17-handover-checklist.md` at the workspace root; landing with the readiness program)
  is what switches it on; off = straight into the HUD.
- **HEAD-TRACK LOGGING** — diagnostic only, no camera control (W3, see above); off by
  default, an env badge shows when `W17_HEADTRACK` overrides it.
- **ELRS PATH** — where the GRID's own convenience LAUNCH button finds the drive program
  (launch-only: this app starts *that* instance detached and structurally cannot stop or
  talk to it — see the RACE DAY subsection above for the *different*, managed launch path).
- **TELEMETRY** — source (`none` / `replay` / `crsf-serial`) and COM port, each with an env
  badge when `W17_TELEMETRY_SOURCE` / `W17_TELEMETRY_PORT` locks it.
- **LOW BATTERY** — warn/critical pack-voltage thresholds for the HUD banner (defaults suit
  a 2S LiPo: warn 7.0 V, critical 6.6 V; `shared/lowBattery.mjs`). Rehearse the banner with
  `npm run demo:low-battery` (below) without draining a real pack.
- **VIDEO STYLE** — the same DRIVE/SHOWPIECE choice as the GARAGE selector, reachable
  mid-session; switching restarts the video feed (`docs/video_profiles.md`).
- **RACE DAY** — the drive-program location and the saved controller-profile path that the
  one-action RACE DAY button (above) launches with; set once during gift-kit install.
- **PHONE LINK ON RACE DAY** — whether RACE DAY also switches the phone telemetry bridge on
  (iPhone sessions only).
- **RE-RUN SETUP** button — re-enters the setup flow from GARAGE without losing settings.

Zero-config iPhone discovery (`_w17hud._udp.local.`) is implemented — see
`docs/proposals/iphone_mdns_discovery.md` "As built". It queries only while PIT WALL is the
active step, adds no dependency, and produces user-confirmed hints only; real-device
verification is still pending.

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

### Other environment variables (dev/ops)

Env-only knobs (never persisted settings), on top of `W17_WIFI_SIM`,
`W17_IPHONE_BRIDGE*`, `W17_HEADTRACK*`, `W17_MAPPER_HEADINTENT*` and
`W17_TELEMETRY_SOURCE`/`W17_TELEMETRY_PORT` documented above:

```
W17_FULLSCREEN=1            # force the main window full screen (dev); 0 forces
                            #   it windowed even on a packaged build. Unset:
                            #   packaged = full screen, dev run = windowed
                            #   (main/appWiring.js resolveFullscreen)
W17_MEDIAMTX_DIR=/path/dir  # look for mediamtx(.exe) + mediamtx.yml in this
                            #   directory instead of the usual dev/packaged
                            #   location (used by the smoke test to exercise
                            #   the missing-binary soft-fail deterministically)
W17_WHEP_URL=http://host:8889/cam/whep  # override the WHEP endpoint the HUD
                            #   connects to (default 127.0.0.1:8889/cam/whep)
W17_REPLAY_TIMELINE=low-battery  # which scripted timeline W17_TELEMETRY_SOURCE=replay
                            #   plays (an unknown name falls back to the
                            #   standard demo loop, logged, not a hard error);
                            #   `npm run demo:low-battery` sets this for you —
                            #   see the Run section above
```

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
