# iPhone ↔ Windows bridge — integration test plan (W2 + W3)

**Documentation only.** Covers bench validation of the two shipped bridge halves:
**W2** (Windows → iPhone telemetry snapshots, UDP 5601) and **W3** (iPhone → Windows
head-tracking intent, UDP 5602, **log-only**). Nothing in this plan commands hardware,
and no test in it may produce CRSF, servo, pan/tilt, or vehicle output — active pan/tilt
remains **blocked until the separate safety milestone**.

Contract: [`windows_bridge_contract.md`](windows_bridge_contract.md) (Windows copy;
authoritative source in `iPhone_rc/docs/` + `schemas/` + `examples/`). Design record:
[`iphone_bridge_readiness.md`](iphone_bridge_readiness.md) (historical). iPhone-side
companions: `iPhone_rc/docs/WINDOWS_BRIDGE_LOG_ONLY_TEST.md`,
`REAL_IPHONE_BENCH_TEST_PLAN.md`, `SIMULATOR_TESTING.md`.

_(Historical marker: W1–W3 were first pushed at ground-station `08b3300` when the suite was
118 tests, 2026-07-08. The suite has grown substantially since — read the current total from
README/CI rather than any number frozen here.)_

---

## 1. Test setup

### Pieces

| Piece | Where | Role |
|---|---|---|
| Windows ground station | `w17-ground-station`, `npm start` / `npm run demo` | sends 5601, listens 5602 (both **off by default**, env-enabled) |
| iPhone FPV HUD app | `iPhone_rc` (Xcode → device/Simulator) | displays telemetry; sends head-tracking intent |
| Fake telemetry receiver | any host: `python3` one-liner or `nc -ul 5601`; or `iPhone_rc/scripts/receive_head_tracking.py --port 5601` adapted | verify W2 packets without a phone |
| Fake iPhone head-tracking sender | `iPhone_rc/scripts/send_fake_head_tracking.py` | drive W3 without a phone (patterns: static/sine/sweep/noisy; `--uncentered`, `--disable-after`, `--malformed`) |
| Fake Windows telemetry sender | `iPhone_rc/scripts/send_demo_telemetry.py` (profiles normal/noisy/stale, `--drop-after`, `--malformed`) | test the iPhone HUD without the ground station |
| Real iPhone | later phase | end-to-end over real Wi-Fi |

### Network / config

- Both machines on one network (bench: same Wi-Fi/LAN; later: the camera AP — measure separately).
- Windows env (all default-off; see README "iPhone telemetry bridge" / "head-tracking receiver"):
  ```
  W17_IPHONE_BRIDGE=1  W17_IPHONE_ADDR=<iphone-ip>  W17_IPHONE_PORT=5601  W17_IPHONE_RATE_HZ=10
  W17_HEADTRACK=1      W17_HEADTRACK_PORT=5602      W17_HEADTRACK_BIND=0.0.0.0  W17_HEADTRACK_STALE_MS=300
  ```
- **Windows firewall:** allow inbound UDP 5602 for the app (Node/Electron). Outbound 5601 is normally unblocked. Record the rule you created.
- **iPhone Local Network permission:** first UDP use prompts — allow it. If denied: iOS Settings → Privacy & Security → Local Network → FPV HUD (per `REAL_IPHONE_BENCH_TEST_PLAN.md`).
- **iPhone motion permission:** Core Motion usage prompt must be accepted for real head tracking; Simulator uses mock motion.
- Record both IPs; the iPhone app needs the Windows host IP + port 5602 in its settings.

---

## 2. W2 — telemetry snapshot tests (Windows → iPhone, UDP 5601)

Precondition: `npm test` green (includes the golden-packet, omission, stale-warning, and
integer-normalization suites in `test/telemetrySnapshot.test.js` / `test/iphoneBridge.test.js`).

| # | Test | How | Pass when |
|---|---|---|---|
| 2.1 | Windows sends on 5601 | `W17_IPHONE_BRIDGE=1 W17_IPHONE_ADDR=<ip> npm run demo`; watch receiver/phone | one JSON datagram ~every 100 ms at the configured address:5601 |
| 2.2 | iPhone shows fresh telemetry | app in UDP mode, packets flowing | HUD values track the demo timeline; packet age updates in Debug/Setup; malformed count does **not** rise |
| 2.3 | Stale behavior (~1 s) | stop the ground station (or kill Wi-Fi) briefly | iPhone shows stale warning ≤ ~1 s after silence, values visually degraded |
| 2.4 | Lost behavior (~3 s) | keep it stopped > 3 s | `TELEMETRY DATA LOST >3S`; battery/LQ/RSSI/SNR/gear/ERS/speed clear to `--` placeholders |
| 2.5 | Source-stale honesty | keep Windows running but kill its telemetry source (unplug serial / stop replay feed) while the mirror keeps packets flowing | packets continue but **omit car fields** + `stale_data_warnings:["telemetry"]`; phone must not show old car values as fresh |
| 2.6 | Omitted unknowns | run with a partial source (e.g. battery only) | absent fields are missing from the JSON (never `0`/`null`); phone shows unknowns, not zeros |
| 2.7 | **Int fields stay integers** | capture ≥ 30 s of packets incl. demo interpolation; assert types | `link_quality`, `ers_percent`, `gear`, `rssi_dbm`, `timestamp_ms` are always JSON integers (no `.`) |
| 2.8 | **Double fields stay fractional** | same capture | `battery_v`, `speed_kmh`, `snr_db`, `camera_yaw_deg`, `camera_pitch_deg`, `throttle`, `brake`, `steering` keep fractional precision (not force-rounded) |
| 2.9 | Windows HUD unchanged | run with and without `W17_IPHONE_BRIDGE` | on-screen HUD identical in both runs; with the flag unset, **no socket is opened** and behavior is exactly pre-W2 |

Packet-capture snippet for 2.7/2.8 (run on any host):
`python3 -c "import socket,json; s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.bind(('0.0.0.0',5601)); [print(json.loads(s.recvfrom(4096)[0])) for _ in range(50)]"`

---

## 3. W3 — head-tracking log-only tests (iPhone → Windows, UDP 5602)

Start: `W17_HEADTRACK=1 npm start` → expect
`[headtrack] LOG-ONLY receiver listening on 0.0.0.0:5602 (stale > 300 ms; no control output)`.
All commands below run from `iPhone_rc/`. (These mirror `WINDOWS_BRIDGE_LOG_ONLY_TEST.md`.)

| # | Test | How | Pass when |
|---|---|---|---|
| 3.1 | Valid packets logged | `python3 scripts/send_fake_head_tracking.py --host <pc> --port 5602 --pattern sine` | `state: idle -> active_log_only`; 1 Hz rate lines show seq/age/yaw/pitch/roll/enabled/centered; gaps=0 |
| 3.2 | Disabled tracking | `--disable-after 2` | `state: active_log_only -> inactive`; packets still counted valid; no other effect |
| 3.3 | Uncentered | `--uncentered` | `state: ... -> not_centered`; logged only |
| 3.4 | Uncalibrated | hand-send a packet with `"calibrated": false` (e.g. via `nc -u` or a python one-liner — the fake sender has no flag for this optional field) | `not_centered`; logged only |
| 3.5 | Malformed rejected | `--malformed` | `[headtrack] rejected packet: malformed-json`; invalid count +1; last valid state preserved |
| 3.6 | Missing required fields rejected | hand-send `{"seq":1}` etc. | rejected with a distinct reason (`bad-timestamp`/`bad-angles`/`bad-tracking-enabled`…); flood-capped at 5 logs/window while all are counted |
| 3.7 | Stale at the 300 ms boundary | stop the sender | `state: active_log_only -> stale` shortly after the 300 ms receive-age boundary (age ≤ 300 fresh, ≥ 301 stale); rate line age grows |
| 3.8 | Seq diagnostics | restart the sender (seq resets to 1) | regression logged as a diagnostic count, not a fault; packets still accepted |
| 3.9 | **No control output — ever** | throughout 3.1–3.8 | no CRSF/servo/pan-tilt/vehicle effect exists (there is no code path; `test/noControlPath.test.js` pins it); only log lines + `getDiagnostics()` |

Reference session (already observed on this machine, real fake-sender vs real receiver):
`idle → active_log_only → stale → not_centered → stale`, 81 packets / 80 valid / 1 invalid
(`malformed-json`), seq regression = 1 diagnostic.

---

## 4. Safety gates (assert before, during, after every session)

- **No firmware changes:** `git -C w17-control-fw status` and `git -C w17-soundlight-fw status` clean; firmware never sees iPhone UDP/JSON.
- **No CRSF pan/tilt output:** the ground station contains no RC-channel encoder (regression test asserts it); elrs-joystick-control's ch9/ch10 remain right-stick only.
- **No servo movement** attributable to any bridge test — the car/bench servos must be physically unpowered or observed motionless during W3 tests.
- **No active control path:** the receiver's public surface is `{start, stop, state, getDiagnostics}`; nothing consumes its data (module-graph test).
- **Windows remains authority:** DualShock → elrs-joystick-control is untouched; the bridge is viewer/logger only.
- **Active pan/tilt stays blocked** until the separate safety milestone (firmware blockers: `w17-control-fw/project-review/iphone_pan_tilt_firmware_readiness.md` §8).

---

## 5. Evidence to capture per session

1. Terminal logs: ground-station console (`[iphone]` + `[headtrack]` lines), fake-sender stdout.
2. iPhone screen recording of fresh → stale → lost telemetry, and Debug/Setup packet-age/malformed counters.
3. Packet samples: ≥ 1 captured JSON datagram per direction (raw text), incl. one stale-flagged W2 packet.
4. `npm test` output (green; the current total is in README/CI — do not expect a frozen count).
5. Windows config: the exact env vars used.
6. Firewall rule screenshot/state + iOS Local Network & Motion permission state.
7. Git state of all repos (`status`, `rev-parse HEAD`) before/after — proving docs-only/no-drift.

---

## 6. Pass/fail criteria

**PASS** when all of:
- W2: 2.1–2.9 pass (fresh/stale/lost/omission/type discipline; Windows HUD unchanged; disabled-by-default proven).
- W3: 3.1–3.9 pass (all eight states reachable where testable; malformed/stale/disabled/uncentered handled safely; log-only proven).
- Safety gates §4 all hold; `npm test` green.

**FAIL / stop immediately** if: any iPhone packet correlates with any control/servo/CRSF change; W2 packets carry fractional Int fields or fake zeros; stale car data is shown as fresh on the phone; or any repo outside `w17-ground-station` shows modifications.

**Not covered here (still required):** real-device iPhone validation — real CoreMotion axes/signs in the mounted orientation, real Wi-Fi latency/loss, Local Network + Motion prompts on device, app-restart calibration gating (`REAL_IPHONE_BENCH_TEST_PLAN.md`).

---

## 7. Next milestones (in order)

1. **Real iPhone bridge validation** — run §2/§3 with the physical phone; record axis signs and packet rates for the future mapping design.
2. **APFPV/video spike** — iPhone video path (`iPhone_rc/docs/apfpv_real_video_spike_plan.md`); independent of control, unaffected by this plan.
3. **Active pan/tilt safety design — later, not now.** Paper design first (arbitration, rate limits, stale-decay-to-center, manual override), then the firmware §8 blockers, then bench-only servo sweeps. No implementation until that milestone is explicitly approved.
