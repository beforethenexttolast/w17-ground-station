# First launch on the giftee's PC

What the person actually receiving the car sees the first time they install and open the
W17 Ground Station, and what to tell them in advance so none of it reads as broken. This is
the giftee-facing counterpart to `SETUP.md` (which is written for whoever is setting the
system up) and `setup_flow_bench_checklist.md` (which validates the same moments on the
bench, before handover). `[win-TBD]` marks anything below that has not yet been observed on
a real Windows install — see the readiness program status: A2 is NOT-EXECUTED and no real
Windows run has happened yet, so this document is reasoned from the checked-in source and
config, not from having watched it happen.

## 1. Installing — the SmartScreen prompt

The installer is the unsigned NSIS `.exe` described in the README CI section and
`CODESIGNING.md` (built by `npm run build`, or the `w17-ground-station-nsis-unsigned` CI
artifact). The first time it runs, Windows SmartScreen shows a blue **"Windows protected
your PC"** screen naming an "unknown publisher." This is expected — the installer is not
code-signed (`CODESIGNING.md` explains why that's an accepted trade-off for a one-off
personal gift) — not a sign that anything is wrong or that the file is unsafe.

**Tell the giftee in advance:** click **More info**, then **Run anyway**. This appears once
per installer file (a fresh download prompts again). `[win-TBD]` exact wording varies by
Windows build; the shape (More info → Run anyway) is SmartScreen's standard unsigned-app
flow and has not been screenshotted against this specific installer yet.

## 2. First network prompts — Windows Firewall

Three separate processes open network sockets and each can independently trigger a
**"Windows Defender Firewall has blocked some features of this app"** dialog the first time
they do:

- **`W17 Ground Station.exe`** (the Electron app) — for Wi-Fi scanning/join and the hotspot
  lifecycle (PIT WALL, `netsh`/PowerShell-backed), and for the optional iPhone telemetry
  bridge (UDP, off by default) and the mDNS discovery query (`main/HudDiscovery.js`, only
  while PIT WALL is open).
- **`mediamtx.exe`** — a separate child process (`main/mediamtx.js` supervises it) that
  listens on the ports pinned in `mediamtx/mediamtx.yml`: TCP `8554` (RTSP), TCP `8889`
  (WHEP/HTTP, what the HUD's video element actually connects to), and UDP `8189` (WebRTC
  ICE). This is what makes the video pipeline work at all — if this prompt is dismissed
  with "Cancel" instead of "Allow access," the picture will not appear (a soft-fail, not a
  crash — the HUD, controller, and telemetry keep working). The soft-fail covers all three
  shapes of "no video": a *missing* binary (`main/mediamtx.js` checks `existsSync` before
  spawning), one that spawns and later exits (auto-restarted every 2 s), and — since the
  correctness-4 fix — one that is *present but cannot run at all*, e.g. quarantined by
  antivirus/SmartScreen without being deleted, or carrying the mark-of-the-web. That last
  shape fails asynchronously with an `'error'` event after `spawn()` has already returned
  cleanly; `MediamtxSupervisor._spawn()` now attaches an identity-guarded `'error'` handler
  beside the `stdout`/`stderr`/`exit` ones, logs `could not start (<code>); video is off`,
  and re-tries every 2 s. Before that handler existed it was an uncaught exception in the
  main process — the whole viewer died — so this is the shape to re-check on the bench if
  the app ever disappears at launch (`test/mediamtxSupervisor.test.js` pins it).
  **The phone uses this same prompt.** Under owner adjudication OD-16 the phone's cockpit
  view pulls WHEP from *this* process over the car Wi-Fi hotspot, so the answer has to
  cover the hotspot adapter, not only the laptop's own loopback: **Allow access** with
  **Private networks** ticked. `mediamtx/mediamtx.yml` already binds `:8889` on every
  interface (a bare `:port` is all interfaces), and now advertises `192.168.137.1` — the
  address the phone is *expected* to see this laptop at — as an ICE host candidate beside
  `127.0.0.1`, so the phone is offered an address it can actually reach. `[win-TBD]` the
  `.1` itself is Windows ICS convention, not something this repo checks: `main/hotspot.js`
  `icsHostIp()` and `main/hotspotVerify.js` `icsGateway()` both match the **`192.168.137.`
  /24**, whatever the last octet turns out to be. If this prompt is
  declined, the laptop's own picture still works and the PHONE's does not, which is the
  confusing failure to watch for. `[win-TBD]` not yet observed on real Windows.
- **the drive program** (`elrs-joystick-control.exe` — the one that actually drives the
  car) — started either by the GRID's **LAUNCH** button or by **RACE DAY**, and it opens
  two listeners of its own: a gRPC port and an HTTP/grpc-web port. `[fix-wave: MAP-8]`
  **Today's truth:** it binds them on ALL interfaces — the `10000`/`3000` defaults come
  from `w17-mapper/cmd/elrs-joystick-control/main.go:42,45` (`--webapp-port`,
  `--grpc-port`, which race day's `MAPPER_ARG_WHITELIST` never overrides), and the two
  bind sites are `pkg/server/controller.go:81` (`net.Listen("tcp", fmt.Sprintf(":%d",
  c.gRPCPort))`) and `pkg/http/controller.go:65` (`Addr: fmt.Sprintf(":%d",
  c.webAppPort)`) — both `[::]`, which `pkg/http/controller.go:101` prints literally at
  startup. On race day that ALL-interfaces bind is the laptop that the phone's hotspot has
  joined; the ruled fix (OD-8) makes `127.0.0.1` the default. Every legitimate client
  already dials localhost — this ground station uses `127.0.0.1:10000`
  (`main/headIntentDiagnosticsConfig.js:23`) — so **Private networks** is the only answer
  this prompt ever needs, and declining it does not stop the car being driven.

**Tell the giftee in advance:** click **Allow access** (Private networks is enough — the
gift's use case is a private/hotspot network, never a public one) for the prompts if they
appear. `[win-TBD]` whether all three processes actually prompt, in what order, and the exact
dialog text — not yet observed on real Windows; the sockets each process opens are the
code-verified fact above, not the OS's prompting behavior around them.

## 3. First boot — what appears

The window opens **full screen** by default on a packaged build (`main/appWiring.js`
`resolveFullscreen`: `isPackaged` → full screen unless `W17_FULLSCREEN=0` is set, which a
giftee build never sets) and lands on **GARAGE** (`renderer/setupFlow.js` `boot()` always
shows GARAGE first — there is no direct-to-GRID boot path, even later, once a session has
been completed once; see the README "Pre-ride setup flow" section for the full step list).
A brand-new install has no completed session yet, so GARAGE shows only the two mode cards
(**DESKTOP FPV** / **IPHONE COCKPIT**) — the **WELCOME BACK** card and the **RACE DAY**
button only appear after a session has been set up and completed once. That first setup
pass is what a helper does before handover — the gift-day handover checklist
(`w17-handover-checklist.md` at the workspace root; landing with the readiness program)
covers this step and the START LIGHTS default below, not something the giftee should need
to do cold.

## 4. Full-screen controls (F11 / Escape)

This is **not** Electron's kiosk mode — the window frame and a restore path both stay
available (`main/appWiring.js` `fullscreenKeyAction`, wired in `main/main.js`
`createWindow()`):

- **F11** toggles full screen on or off, in either state.
- **Escape** exits full screen, but **only while already full screen** — a plain Escape
  press in windowed mode is left alone (it still reaches the renderer, e.g. to close the ⚙
  menu, which also closes on Escape).

One consequence worth telling a helper (not necessarily the giftee): because the main
process intercepts Escape whenever the window **is** full screen, pressing Escape to close
the ⚙ menu while full screen exits full screen instead of closing the menu — the menu also
closes via a **backdrop click**, which is unaffected. This has not been observed to cause a
real problem (the frame reappears, the app keeps running, F11 goes back full screen), just
a slightly different feel from windowed mode.

## 5. What the giftee sees after that

From GARAGE, the flow is the one documented in the README "Pre-ride setup flow" section —
GARAGE → (PIT WALL, iPhone sessions only) → SEAT FIT → SETUP → GRID → five red lights, once
a helper has switched START LIGHTS on in ⚙ (it ships OFF by default) → lights out into the
live HUD. Every screen carries a plain-language "what's wrong — what to
do" hint on any failing check (`shared/checklist.mjs` / the GRID summary strip), and an
amber **START ANYWAY** always lets the giftee drive past a check that refuses to go green.
Once a session has been completed once, later launches land on GARAGE's **WELCOME BACK**
card, and the **RACE DAY ▸ BRING EVERYTHING UP** button (README "RACE DAY" section) is the
one-press path a helper sets up in advance so the giftee's own day-to-day routine is just
that one button, not the full setup flow. The RACE DAY card no longer confirms only that the
drive program started: the DRIVE PROGRAM line reads the mapper's own read-only link-state
stream and says "running" only while that stream reports the radio up
(`main/raceDayOrchestrator.js` `_linkCheck`).

`[bench-TBD]` the wait before that decision (`LINK_UP_WAIT_MS = 5000`,
`main/raceDayOrchestrator.js`) is **not validated** — nothing in this chain has run on any
machine (A2 NOT-EXECUTED), so how long a cold drive program takes to enumerate its controller
and open the transmitter's serial port on the gift laptop is unknown. Because of that, a
**first** bring-up whose window closes with the radio still off reports "running — the radio
is not on yet, give it a moment" (green, sequence carries on) and upgrades itself the moment
the radio answers; only a radio that has come up once in this session can produce the
red "check the cable to the little radio box" line, which still halts the sequence (OD-5).
`scripts/windows-validation/50-race-day.ps1` (WS3) is where the real port-open latency gets
recorded; the constant is settled only after that.

If anything above goes wrong, the **zero-code fallback** always exists and needs none of
this app: `elrs-joystick-control` for control plus VLC (or a browser) pointed at the
camera's RTSP URL (README "Viewer only", `SETUP.md` "Gift-day fallback").
