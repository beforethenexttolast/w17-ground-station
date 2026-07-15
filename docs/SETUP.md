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
  authoritative test; if it never goes green on a network, use the hotspot. The check
  proves the *network path* only (it classifies a `TTL=` echo reply as reachable, a
  Windows router-originated "Destination host unreachable" as unreachable, and no reply
  as timeout) — live telemetry on the iPhone is the real evidence, and iOS Local Network
  permission can still block UDP receive even when ping is green.
- **Network security scope (what the join flow accepts):** each scanned network is
  classified before you can join it.
  - **Open (unencrypted):** supported — both new and saved open networks join (an open
    profile is installed only when Windows has no saved one), always behind an
    `OPEN NETWORK — unencrypted` warning; no password, no credential persisted.
  - **WPA2-PSK:** supported (password path).
  - **WPA2/WPA3 transition:** supported through the WPA2-compatible path.
  - **WPA3-only (SAE):** **rejected** before any OS call with a clear message ("use a
    WPA2 network or start the W17 hotspot"), never a raw netsh error.
  - **Enterprise (802.1X):** **rejected** (not supported).
  - **Unknown/unidentifiable security:** a *new* such network is **rejected conservatively**
    (never treated as WPA2), but a network Windows already has a **saved profile** for is
    joined through that stored profile.
  - **Hidden networks:** manual SSID entry is **out of scope**; a hidden network yields a
    clear unsupported message, never a raw error.
- **Hotspot backends:** the app prefers Windows **Mobile Hotspot** (WinRT tethering via
  PowerShell) and falls back to legacy `netsh wlan hostednetwork`, which the RT5370 USB
  dongle's driver family still supports. `netsh wlan show drivers` → "Hosted network
  supported: Yes" confirms the fallback path. `hostednetwork` needs the app elevated
  (run as administrator) — the UI suggests it from a locale-neutral elevation check
  instead of failing silently.
- **Hotspot lifecycle (start, stop, quit):** the hotspot has an explicit
  STARTING → LIVE → STOPPING lifecycle owned by the main process. **STOP HOTSPOT** sits
  beside START; a failed stop keeps the app's ownership and stays retryable. The app only
  ever stops a hotspot **it** started — an externally-owned hotspot is never touched.
  Quitting while an app-owned hotspot is live prompts a dialog (*STOP AND QUIT / LEAVE
  RUNNING / CANCEL*); it never appears for a hotspot the app did not start.
- **Hotspot credential at rest:** the hotspot password is encrypted via Electron
  `safeStorage` (DPAPI on Windows) and never written to disk in plaintext (see §7). When
  secure storage is unavailable it is kept for the session only, not persisted.
- **One radio can't do both jobs well:** hosting a hotspot and staying joined to the
  camera's AP on the same adapter is unreliable. The supported topology is the RT5370 as
  a dedicated hotspot dongle while the built-in adapter talks to the camera. The PIT WALL
  ADAPTER row is always shown: readonly with one WLAN adapter, a picker with several
  (scan/join pinned to the chosen interface), a "saved adapter not detected" prompt when a
  remembered adapter is gone, and a dongle hint when none is present.
- **Localization:** network scanning parses `netsh` structurally and survives non-English
  Windows; error/elevation classification is locale-neutral (no English-keyword matching);
  if hotspot capability can't be determined, the UI degrades to guide mode.
- elrs-joystick-control's path can be set in the ⚙ menu; the app only ever *starts* it
  (detached) and detects it via `tasklist` — it never stops or talks to it.

## 7. Hotspot credential storage (Windows DPAPI via Electron safeStorage)

The only persisted secret is the hotspot password. It is stored **encrypted at rest** and
never in plaintext:

- Encryption uses Electron `safeStorage`, which on Windows is backed by **DPAPI** (the
  OS-account key) — there is **no app-managed encryption key**. On macOS it is Keychain,
  on Linux libsecret.
- On disk `settings.json` holds only a versioned ciphertext token; the plaintext field is
  blanked, including in the `.bak`. There is **no plaintext persistence fallback**.
- If `safeStorage` is unavailable, a password entered in this session is kept **in memory
  for the session only** and is gone on restart (never written).
- A legacy plaintext password from an older build is migrated on first load (encrypted if
  possible, otherwise dropped from disk and kept for the session).
- Ciphertext that can't be decrypted here (a settings file copied from another Windows
  account or machine, or corruption) causes a clean **re-enter** prompt — unrelated
  settings stay intact and the app does not crash.
- Environment-provided credentials are **not** copied into `settings.json`, and transient
  Wi-Fi *join* passwords are never persisted at all.

The real Windows DPAPI round-trip (and the cross-account "re-enter" behavior) is a bench
item — see `setup_flow_bench_checklist.md`.

## Gift-day fallback (validate this regardless)

`elrs-joystick-control` for control + **VLC** (or a browser) pointed at the camera's RTSP URL.
Zero code from this repo; robust to the H.265 issue. The app is polish on top, never a
prerequisite for driving.
