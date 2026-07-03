# w17-ground-station

Ground-station app for the 1/10 FPV Mercedes W17 RC car — the laptop-side companion to
[w17-control-fw](https://github.com/beforethenexttolast/w17-control-fw) (car ESP32 #1) and
w17-soundlight-fw (car ESP32 #2).

An **Electron** app that overlays a Mercedes-livery F1 HUD on the live FPV video:
- **Video** — OpenIPC camera RTSP → a bundled **mediamtx** → **WebRTC/WHEP** rendered as the
  full-screen background (low latency; WebRTC not HLS).
- **HUD** — throttle/brake/steering/DRS/boost/overtake/gear mirrored live from the DualShock
  (Gamepad API), plus a simulated speed/rpm/ERS animation, all in the F1 dash style.
- **Telemetry overlay** — real speed, battery, ERS%, link quality and failsafe from the car
  replace the simulated values when a telemetry source is connected.

## Viewer only — it does NOT drive the car

Control stays with **elrs-joystick-control** (DualShock → CRSF → ELRS TX module), which runs
alongside. This app reads the gamepad purely to *mirror* inputs on-screen. A bug here can never
stop the car — deliberate gift-day safety. The zero-code fallback (elrs-joystick-control + VLC
on the raw stream) is always available.

## Run

```
npm install
npm run fetch-mediamtx     # download the pinned mediamtx binary for your OS
npm test                    # pure-core unit tests (no hardware)
npm start                   # launch the app (video needs the camera; see docs/SETUP.md)
npm run demo                # launch with the replay telemetry source (live-looking, no car)
npm run build               # package a Windows .exe (electron-builder)
```

**Before first real use, work through `docs/SETUP.md`** — it lists the hardware verifications
that gate the video pipeline (chiefly: is the camera emitting H.264 or H.265? WebRTC needs
H.264). `docs/TELEMETRY.md` defines the telemetry contract for the car firmware.

## Layout

| path | role |
|---|---|
| `shared/` | pure, unit-tested: CRSF parser (ported from the firmware), telemetry types, replay source, feel constants |
| `main/` | Electron main: mediamtx supervisor, telemetry source, IPC push |
| `renderer/` | the HUD page, WHEP video client, telemetry overlay |
| `mediamtx/` | pinned config (binary fetched, not committed) |
| `test/` | vitest specs, reusing the firmware's golden CRSF vectors |

Architecture, tradeoffs, and the design-review findings are recorded in the plan and in
`docs/`.
