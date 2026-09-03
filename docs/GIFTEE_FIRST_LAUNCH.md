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

Two separate processes open network sockets and each can independently trigger a
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

**Tell the giftee in advance:** click **Allow access** (Private networks is enough — the
gift's use case is a private/hotspot network, never a public one) for both prompts if they
appear. `[win-TBD]` whether both processes actually prompt, in what order, and the exact
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
that one button, not the full setup flow. `[fix-wave: SYN-2]` a green RACE DAY card today
confirms the drive program started, not that the car's radio link is up — see the README
RACE DAY section and the bench checklist §12 for the current, tracked gap.

If anything above goes wrong, the **zero-code fallback** always exists and needs none of
this app: `elrs-joystick-control` for control plus VLC (or a browser) pointed at the
camera's RTSP URL (README "Viewer only", `SETUP.md` "Gift-day fallback").
