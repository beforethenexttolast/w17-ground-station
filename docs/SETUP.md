# Setup & bench verification

The app's pure logic (CRSF parse, telemetry, HUD) is unit-tested and runs anywhere. The
**video pipeline and telemetry depend on hardware facts that must be verified on the bench** —
several can force a config or architecture change, so do them first.

## 1. Camera codec — H.264 vs H.265 (HIGHEST RISK, do this first)

Chromium/Electron WebRTC generally **cannot decode H.265/HEVC**. The OpenIPC SSC338Q commonly
defaults to H.265. If so, WebRTC video will not play.

- Check the camera's `majestic.yaml` → `.video0.codec`.
- **Preferred fix:** set it to `h264` if the SSC338Q build supports it — keeps the whole
  WebRTC path intact and lowest-latency.
- **Fallback:** transcode H.265→H.264 with ffmpeg feeding mediamtx (adds CPU + tens of ms).
- Note: **VLC decodes H.265 fine**, so the zero-code fallback (VLC on the raw RTSP) survives
  this issue even if the Electron app can't — good to confirm as your safety net.

## 2. Camera stream URL / format

Get the real stream URL from `majestic_fpv.yaml`. Majestic usually serves **RTSP**
(`rtsp://<cam-ip>:554/...`), which mediamtx ingests natively — set it as `paths.cam.source`
in `mediamtx/mediamtx.yml`. Some low-latency setups push raw RTP/UDP instead (needs a
different mediamtx source). Confirm which, and the exact path.

## 3. mediamtx / WHEP

`npm run fetch-mediamtx` pins **v1.9.3**. Confirm the WHEP endpoint answers at
`http://127.0.0.1:8889/cam/whep` once a source is publishing. If you bump the version, re-check
the `webrtc*` keys in `mediamtx.yml` against that release's docs.

## 4. Telemetry (battery + link quality, over the ELRS backchannel)

The HUD is fully alive from the gamepad; telemetry only adds the car-side truths it can't infer
— here, **real battery voltage + link quality**. The control-board firmware already emits a CRSF
battery frame up to RP1; the ground TX module reports link statistics natively. Enable the
ground-station reader with `W17_TELEMETRY_SOURCE=crsf-serial W17_TELEMETRY_PORT=COMx`. The
one setup task is getting a reader onto the CRSF serial that elrs-joystick-control already holds
exclusively (see `docs/TELEMETRY.md`):

- **First check:** does `elrs-joystick-control` expose/forward telemetry (a UDP/log/stdout
  flag)? If so, point the source there — simplest, viewer-only intact.
- **Otherwise:** install **com0com** (+ `hub4com`) on Windows — one owner mirrors the physical
  FT232 port to two virtual ports; elrs-joystick-control opens one, set `W17_TELEMETRY_PORT` to
  the other. Confirm `CrsfSerialSource` logs `CRSF serial open` and the HUD's battery/LQ go live.
- Verify the TX module actually emits LINK_STATISTICS (0x14) + the car's battery (0x08) on that
  serial (a few Hz is plenty). ELRS telemetry rate is more than enough for a battery gauge.

`serialport` is a native module — after `npm install` run `npx electron-rebuild` (or
`npm run setup` if wired) so it matches Electron's ABI. If it's missing/unbuilt the app still
runs (gamepad HUD; telemetry just stays simulated). Until the bench, `npm run demo` runs the
built-in replay source so you can see the full overlay.

## 5. Offline demo (no car, no camera)

Exercise the exact WHEP path with a local file:

```
./mediamtx/mediamtx mediamtx/mediamtx.yml
ffmpeg -re -stream_loop -1 -i demo.mp4 -c:v libx264 -tune zerolatency -f rtsp rtsp://127.0.0.1:8554/cam
npm run demo    # gamepad drives the widgets; replay source drives the overlay
```

## 6. Network & hotspot for the iPhone bridge (Windows)

The in-app PIT WALL step drives this, but the facts to verify on the bench:

- **Client isolation:** guest/office APs often block device-to-device traffic — the
  bridge needs PC ↔ iPhone UDP. The GRID "IPHONE REACHABLE" check (one ping/s) is the
  authoritative test; if it never goes green on a network, use the hotspot.
- **Hotspot backends:** the app prefers Windows **Mobile Hotspot** (WinRT tethering via
  PowerShell) and falls back to legacy `netsh wlan hostednetwork`, which the RT5370 USB
  dongle's driver family still supports. `netsh wlan show drivers` → "Hosted network
  supported: Yes" confirms the fallback path. `hostednetwork` needs the app elevated
  (run as administrator) — the UI says so instead of failing silently.
- **One radio can't do both jobs well:** hosting a hotspot and staying joined to the
  camera's AP on the same adapter is unreliable. The supported topology is the RT5370 as
  a dedicated hotspot dongle while the built-in adapter talks to the camera.
- **Localization:** network scanning parses `netsh` structurally and survives non-English
  Windows; if hotspot capability can't be determined, the UI degrades to guide mode.
- elrs-joystick-control's path can be set in the ⚙ menu; the app only ever *starts* it
  (detached) and detects it via `tasklist` — it never stops or talks to it.

## Gift-day fallback (validate this regardless)

`elrs-joystick-control` for control + **VLC** (or a browser) pointed at the camera's RTSP URL.
Zero code from this repo; robust to the H.265 issue. The app is polish on top, never a
prerequisite for driving.
