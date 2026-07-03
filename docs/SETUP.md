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

## 4. Telemetry return path (deferrable — HUD works without it)

The HUD is fully alive from the gamepad; telemetry only adds car-side truths (real speed,
battery, armed/failsafe, link quality). Two candidate sources (see `docs/TELEMETRY.md`):

- **WiFi (recommended):** the car ESP32 publishes a small JSON/UDP packet over the OpenIPC
  5.8 GHz AP the laptop is already on. No serial contention. Cleanest — build a
  `WebSocketSource`/`UdpSource` and point `main.js` at it.
- **CRSF serial (only if it works):** telemetry returns on the *same FT232 port*
  elrs-joystick-control holds for control. **Verify whether elrs-joystick-control can forward
  the telemetry it receives** (a `--telemetry`/UDP/stdout flag). If yes, a `CrsfSerialSource`
  consumes that (the `shared/crsf.js` parser is ready). If no, use the WiFi path.

Until then, `npm run demo` runs the built-in replay source so you can see the full overlay.

## 5. Offline demo (no car, no camera)

Exercise the exact WHEP path with a local file:

```
./mediamtx/mediamtx mediamtx/mediamtx.yml
ffmpeg -re -stream_loop -1 -i demo.mp4 -c:v libx264 -tune zerolatency -f rtsp rtsp://127.0.0.1:8554/cam
npm run demo    # gamepad drives the widgets; replay source drives the overlay
```

## Gift-day fallback (validate this regardless)

`elrs-joystick-control` for control + **VLC** (or a browser) pointed at the camera's RTSP URL.
Zero code from this repo; robust to the H.265 issue. The app is polish on top, never a
prerequisite for driving.
