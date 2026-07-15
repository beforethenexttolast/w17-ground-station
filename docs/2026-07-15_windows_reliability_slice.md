# Windows ground-station reliability slice — 2026-07-15

Durable tracker for the reliability work triggered by five real Windows observations.
Implemented and tested on **macOS**; the physical Windows/Pixel behaviour is **UNVALIDATED**
here by construction. Canonical Windows validation runbook: see the paste-ready
"real-Windows validation" prompt delivered with this slice (also summarised in
`../CURRENT_STATUS.md`). This slice changed **no** bridge schema, canonical contract, control
path, firmware, mapper, or iPhone code.

## 1. The five Windows observations → diagnosed code-level cause → fix

| # | Observation (real Windows) | Diagnosed code-level cause | Fix (this slice) |
|---|---|---|---|
| 1 | App should launch full screen | `createWindowOptions` never set `fullscreen`; the window opened at 1280×720 | `resolveFullscreen({isPackaged,env})` → `createWindowOptions({fullscreen})` opens full-screen in the packaged build (NOT kiosk); `W17_FULLSCREEN` is the dev override; `fullscreenKeyAction` + a `before-input-event` handler give F11 restore/exit (2A) |
| 2 | A Wi-Fi adapter connected while the Network page was open never appeared until the page was re-entered | Adapter list was pulled once on PIT WALL entry (`refreshAdapters`); no live source | `main/adapterMonitor.js` (main-process bounded polling, whole-app lifetime, not page-coupled) pushes `adapter-state`; the renderer re-renders the ADAPTER card live (2B) |
| 3 | Wi-Fi-dongle disconnection behaviour was undefined | No removal handling; a live hotspot could keep claiming LIVE with its adapter gone | Monitor `removed[]` diffs + `createAdapterCoordinator` → `hotspotLifecycle.markInterrupted` (all adapters gone) or re-verify (some remain); `wifiManager.join` aborts EARLY (`kind:'adapter-missing'`) after `JOIN_MISSING_POLLS`; the card marks a vanished **selected** adapter NOT DETECTED and selects nothing (no auto-switch) (2C) |
| 4 | Hotspot "started" but a Google Pixel stalled at "Obtaining IP address" and failed to connect (both USB dongle and internal adapter) | A successful start **command** was presented as success; nothing checked DHCP/ICS readiness | `main/hotspotVerify.js` classifies local readiness (WinRT tether state, ICS `192.168.137.x` gateway, `SharedAccess`/`icssvc` service state) into `verified`/`degraded`; `hotspotLifecycle` gains `idle→verifying→verified/degraded` + `interrupted`; the pane shows VERIFYING / NOT READY FOR CLIENTS / READY, never a bare success (2D). **No blind sleeps** — verification is event-triggered; no physical DHCP claim is made |
| 5 | An unusual-auth network produced a long error that overlapped other UI text | `.netstatus`/`.hint` had no width/wrap bound; the full error was written straight into the status line | `classifyJoinError` → terse summary in a width-bounded, wrapping `.netstatus`; the full (redacted) reason in an expandable, scrollable `.errdetail`; old errors clear when a new op starts (2E) |

Cross-cutting: `shared/redact.js` scrubs known secrets from any command output before it can
reach a status line, a details box, or a log (defensive backstop; the managers already never
echo credentials).

### 1.1 Pixel / hotspot root-cause distinction (correction — do not overstate)

The observation-#4 fix must not be read as a claim that ICS or DHCP conclusively caused the
physical Pixel failure. Recorded precisely:

- **Proven code/UI root cause:** a successful hotspot-**start command** was treated as
  client-readiness even though ICS state, the gateway address, the required services, and DHCP
  readiness were never verified. That is a real defect this slice fixes, independent of what the
  Pixel's specific failure turns out to be.
- **Leading physical hypothesis (NOT proven):** missing/broken ICS, no gateway assignment on
  the hotspot subnet, a DHCP service not running, missing/inadequate driver/AP-mode support, or
  adapter/backend behaviour. The local readiness checks were designed around these because they
  are the common silent causes — but "designed around" is not "measured".
- **Actual Pixel failure cause: UNPROVEN.** It remains unproven until the real-Windows
  validation captures, on the real host, the gateway address, the ICS + `SharedAccess`/`icssvc`
  service states, the adapter/backend in use, and the Pixel's actual lease result (SSID join →
  auth → IPv4 lease → gateway/DNS → local-service reachability).
- **The verified/degraded state model stands on its own merits:** it correctly stops the app
  from presenting an unverified hotspot as client-ready, and surfaces a degraded state when a
  local readiness signal is bad or unreadable. It does **not** by itself prove end-to-end DHCP —
  `verified` means "nothing locally wrong", never "a client obtained a lease".

## 2. What was implemented on macOS (files)

New: `main/adapterMonitor.js`, `main/hotspotVerify.js`, `shared/redact.js` (+ their tests).
Changed: `main/appWiring.js` (window options + `resolveFullscreen`/`fullscreenKeyAction` +
`wireAdapterPush` + `createAdapterCoordinator` + two IPC handlers), `main/main.js` (full-screen
+ F11 + monitor start/teardown + coordinator wiring), `main/preload.cjs` (+`adapterState`,
`onAdapterState`, `hotspotVerify`), `main/hotspot.js` + `main/wifiManager.js` (secret redaction
+ join error `kind`s), `main/hotspotLifecycle.js` (readiness/interrupted model),
`shared/wifiView.mjs` (readiness pane + `classifyJoinError`), `renderer/setupFlow.js` +
`renderer/index.html` + `renderer/hud.css` (live adapter card, readiness/REVERIFY, error UX).

## 3. Automated evidence (macOS host)

- `npm test` (vitest): **798/798** across 46 files (was 746; +52 reliability tests, and the WIP
  had left the suite at 5 red — now repaired by completing the wiring).
- `npm run smoke:electron`: **4/4** real Electron boot scenarios (normal/corrupt-settings/
  forced-failure/timeout); live preload surface = **24 methods**; console-clean; clean exit.
- `npm run proto:check`: OK — checked-in proto snapshot still matches the live mapper (this
  slice touches no proto).

## 4. What macOS testing PROVES

Parsing + state classification + view-model decisions + wiring choreography are correct against
representative Windows command output and injected fakes: readiness classification (verified vs
degraded; missing gateway; inactive ICS; missing/failed service; probe/command failure), adapter
appear/remove/reinsert/dedupe/stable-identity/emit-on-change/bounded-polling/no-overlap/cleanup,
join early-abort on adapter removal, coordinator markInterrupted vs re-verify, secret redaction,
full-screen config + override + F11 action, and the error summary/detail/clear UX. The app boots
full-screen-capable and clean on real Electron.

## 5. What macOS testing CANNOT prove (Windows/hardware evidence still MISSING)

- Real netsh/WinRT adapter arrival & removal timing and the exact **physical adapter that backs
  a live hotspot** (the coordinator's markInterrupted-vs-reverify split is conservative because
  this mapping is not locally provable — a Windows validation item).
- Real Windows Mobile Hotspot / hosted-network start, ICS enablement, `SharedAccess`/`icssvc`
  states, and the `192.168.137.x` gateway actually appearing.
- **Pixel DHCP end-to-end: still UNPROVEN** — that a client SSID-joins, authenticates, gets an
  IPv4 lease + gateway + DNS, and reaches the local service. "verified" means "nothing locally
  wrong", never "a client connected".
- Real localized-Windows auth-error text and the on-screen non-overlap at real resolutions.
- Real multi-monitor full-screen placement.

## 6. Exact next-session action

Run the paste-ready **real-Windows validation prompt** (delivered with this slice) on the actual
Windows host: verify full-screen + F11; adapter insert/remove/reinsert while PIT WALL is open;
hotspot on internal vs USB adapter; the Pixel DHCP path (SSID → auth → IPv4 → gateway/DNS →
local service); that app state matches Windows state incl. the degraded state when ICS/DHCP
readiness fails; the non-overlapping auth error; and redacted-only logs. Collect the redacted
diagnostics bundle it specifies. These two CB8 commits + this slice have **not** run Windows CI
yet (CI is green through `0e85702`).
