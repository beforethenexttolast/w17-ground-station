# Pre-hardware hardening audit — w17-ground-station

**Status: working document for the 2026-07 pre-hardware hardening pass. Uncommitted
until user review. Updated after every completed batch.**

| | |
|---|---|
| Repository / branch | `w17-ground-station` / `main` |
| Commit audited | `cf038c2` ("docs: add adapter and simulation bench checks") |
| Original audit date | 2026-07-12 (same session, morning) |
| Revalidation date | 2026-07-12 (afternoon) — working tree byte-identical to `cf038c2`, `git status` clean |
| Tests before implementation | `npm test` → **263/263 green** (24 files), re-run at revalidation: 263/263 |
| Original executive verdict | **Ready with minor pre-bench corrections** — architecture coherent, safety boundaries real and structurally enforced, B1–B8 matches plan; one HIGH defect (Mobile Hotspot PS) + two MEDIUM defects (global key handlers, multi-adapter status) invisible to tests/sim by construction |

Hard boundaries in force for the entire pass (from `CLAUDE.md` + user instructions):
W3/5602 stays LOG-ONLY; `noControlPath.test.js` stays green and may only be
strengthened; no pan/tilt or camera-control mapping; no car-control path; no CRSF
encoder; `docs/windows_bridge_contract.md` §1–§7 untouchable; canonical contract
authority is iPhone-side; ground station remains viewer/setup/launcher only; simulation
never counts as hardware evidence; persisted mode values stay compatible; no error
concealment behind optimistic fallbacks; nothing committed/pushed without user review.

---

## 1. Original findings (complete, with evidence) + revalidation

Revalidation legend: **STILL PRESENT** / ALREADY FIXED / PARTIALLY FIXED / N/A /
REQUIRES HARDWARE / REQUIRES USER DECISION. Since the tree is unchanged from
`cf038c2`, every finding revalidates as originally reported; the column records the
*actionability* split.

### HIGH

**H1 — Mobile Hotspot PowerShell script very likely broken on stock Windows PowerShell 5.1.**
- Evidence: `main/hotspot.js:24-48` (`PS_AWAIT_HELPER`, `PS_START`, `PS_STOP`). Two independent problems:
  1. `Await` reflects over `[System.WindowsRuntimeSystemExtensions]` but the script never runs
     `Add-Type -AssemblyName System.Runtime.WindowsRuntime`; in a fresh `-NoProfile`
     PowerShell 5.1 process that assembly is not loaded → type lookup fails at runtime.
     (Every canonical WinRT-tethering snippet includes the `Add-Type` line.)
  2. `ConfigureAccessPointAsync()` returns `IAsyncAction` (documented WinRT signature), not
     `IAsyncOperation`1`; `Await` only finds the `IAsyncOperation`1` overload of `AsTask`,
     so the configure call throws even with the assembly loaded. Canonical snippets carry a
     separate `AwaitAction` for exactly this reason.
- Failure mode: PowerShell default error handling continues past failed statements;
  `$manager.StartTetheringAsync()` is still *invoked* (arguments evaluate before `Await`
  fails) → **tethering can start with the OLD Windows-configured SSID/password, not
  W17-GRID**, while the script prints `START_` without `Success` → app reports mobile
  backend failed → falls back to `hostednetwork` (unsupported on most post-2018 drivers)
  → error shown. Operator sees "failed"; hotspot silently on with wrong credentials.
- Why tests can't catch it: `test/hotspot.test.js` and `main/wifiSim.js` fake the `run`
  seam and canned-return `TETHER_OK`/`START_Success`; the script text never executes.
- Confidence: inferred with high confidence from documented API signatures + PS 5.1
  semantics; final proof is bench-only.
- Original recommendation: fix before bench — `Add-Type`, `AwaitAction` helper (or poll
  `GetCurrentAccessPointConfiguration` instead of awaiting), `$ErrorActionPreference='Stop'`
  + try/catch so partial execution can never half-start tethering.
- **Revalidation: STILL PRESENT at revalidation → CODE-FIXED in Batch A1** (true WinRT
  behavior still REQUIRES HARDWARE — validate with `scripts/hotspot-diag.js` +
  checklist §3). See A1 completion notes and the transfer checkpoint below.
- Batch: **A1 — DONE (code), bench-pending**.

### MEDIUM

**M1 — Global keyboard handlers fight every text input in the setup flow.**
- Evidence: `renderer/hud.js:63-66` — window-level `keydown` calls `e.preventDefault()`
  on arrows and **space** unconditionally, including with a text field focused.
  `renderer/setupFlow.js:71-73` — window-level Enter clicks NEXT whenever gate+nav are
  visible, regardless of focus.
- Impact: cannot type spaces into SSID/passwords (silently dropped); arrows don't move
  the caret in IP/ELRS-path/COM fields; Enter after typing a Wi-Fi password *navigates to
  SEAT FIT* instead of joining, discarding the join. Real WPA2 passphrases contain spaces.
- Confirmed by code reading. Pre-existing HUD-era handlers that became a conflict when
  setup-flow inputs landed (`34a1446`); not a B1–B8 regression.
- Original recommendation: scope both handlers away from
  `input/select/textarea/contenteditable`; Enter in the password field triggers JOIN.
- **Revalidation: STILL PRESENT → FIXED in Batch A2.** Both global handlers now go
  through `shared/keyboardFocus.mjs` (pure focus policy): editable targets
  (input/select/textarea/contenteditable incl. nested) are never recorded/prevented;
  Enter advances only from a non-interactive focus; Enter in `netPassword` invokes JOIN.
  DOM-level tests (jsdom) pin the behavior end-to-end. Batch: **A2 — DONE**.

**M2 — Multi-adapter `status()` ambiguous; join verification adapter-order-dependent.**
- Evidence: `shared/wifiParse.js:60-73` — `parseNetshInterfaces` scans *all* interface
  blocks as one: last SSID wins, first percentage wins (fields from different adapters
  mixed). `main/wifiManager.js:113-121` — `join()` verifies success by polling this
  unpinned merged status (`status.ssid === ssid`).
- Impact: with built-in on the camera/home network and RT5370 joining W17-GRID (the
  supported topology, `docs/SETUP.md` §6), join-success detection depends on netsh
  enumeration order; a *successful* dongle join can report "not connected after 20s".
  Signal % can belong to the other adapter.
- Confirmed logic defect; whether it bites depends on enumeration order (coin-flip).
- Original recommendation: verify joins against the *pinned* interface via
  `parseNetshInterfacesList` (already per-adapter), or pass `iface` into `status()`.
  Add reversed-order two-adapter fixtures.
- **Revalidation: STILL PRESENT → FIXED in Batch A3.** The merged parser
  `parseNetshInterfaces` is DELETED; `status({iface})` selects one block from the
  per-adapter `parseNetshInterfacesList` (all connection fields from the same block;
  missing adapter = explicit `present:false` result; netsh failure = `ok:false` with
  reason, no longer silent "not connected"); `join({iface})` verifies against the
  pinned block only, with honest last-poll timeout errors. Reversed-order,
  both-connected, German, and transitional fixtures added; both block orders proven
  to give the same pinned result. Real netsh behavior REQUIRES HARDWARE (bench).
  Batch: **A3 — DONE (code), bench-pending**.

**M3 — UI can start a hotspot but never stop it; quit leaves it running.**
- Evidence: `hotspotStop` exists in `main/preload.cjs:25` + `main/main.js:173` but no
  renderer code calls it (grep-confirmed); `app.on('will-quit')` (`main/main.js:261-265`)
  stops headtracking/runtime/mediamtx but not the hotspot.
- Impact: machine keeps broadcasting W17-GRID after the session; hostednetwork keeps the
  RT5370 claimed; recovery is manual OS settings. Hidden state confuses the next session.
- Confirmed (dead IPC surface). Stop-on-quit may be deliberate (don't kill the phone's
  network mid-session) — but the stop *button* is missing regardless.
- **Revalidation: STILL PRESENT — REQUIRES USER DECISION** (quit policy). STOP button +
  lifecycle states proposed for approval. **→ FIXED in B1** (Q1/Q2 approved): full
  INACTIVE→STARTING→LIVE→STOPPING lifecycle authority in the main process
  (`main/hotspotLifecycle.js`), STOP HOTSPOT beside START in PIT WALL, and a quit-policy
  dialog (`main/quitPolicy.js`) that never leaves an app-owned hotspot running without
  asking. Batch: **B1 — DONE (code), WinRT behavior bench-pending**.

### LOW

**L1 — Elevation detection is English-only.**
- Evidence: `main/hotspot.js:133` — `/denied|elevat|administrator/` against localized
  netsh output; on non-English Windows the "run as administrator" guidance degrades to a
  raw error. Rest of repo parses locale-structurally; this line doesn't.
- **Revalidation: STILL PRESENT → FIXED in B2.** The English-keyword regex is deleted; a
  hostednetwork start failure is now classified generically (`kind:'start-failed'`,
  `backend:'hosted'`) in every locale, and the administrator hint is a SUGGESTION driven
  by a locale-neutral elevation FACT (a `WindowsPrincipal.IsInRole` PowerShell token,
  `ELEV_ADMIN`/`ELEV_LIMITED`), never by matching localized prose. EN and DE fixtures
  classify identically. Real localized-Windows behavior REQUIRES HARDWARE. Batch:
  **B2 — DONE (code), bench-pending**.

**L2 — Unknown *open* networks can't be joined.**
- Evidence: `main/wifiManager.js:90-123` — no-password path skips profile creation and
  `netsh wlan connect name=X` fails when no profile exists; the password path builds a
  WPA2-PSK profile only (`shared/wifiParse.js:160-183`). An unknown open network fails
  with a raw netsh error. WPA3-SAE-only networks also unsupported (WPA2 profile).
- **Revalidation: STILL PRESENT → FIXED in B3** (decision Q3). A normalized `security`
  model (`classifyWifiSecurity`) drives the flow: NEW and SAVED **open** networks join
  (open profile installed when there is no saved one; no password, no credential
  persisted), with an `OPEN NETWORK — unencrypted` warning; **WPA3-only** and
  **enterprise** are rejected BEFORE any OS call with stable kinds + controlled messages
  (never a raw netsh error); WPA2-PSK and transition (WPA2-compatible) are unchanged;
  empty/whitespace/malformed SSIDs are dropped. Real netsh open/WPA3 behavior REQUIRES
  HARDWARE. Batch: **B3 — DONE (code), bench-pending**.

**L3 — `videoPlaying` can go stale-true.**
- Evidence: `renderer/hud.js:323-324` — set on `'playing'`, cleared only on `'emptied'`;
  a dying stream fires `waiting`/`stalled`, not `emptied` → GRID VIDEO LOCK (and W2
  `video_lock`) stays green between stream death and WHEP reconnect.
- **Revalidation: STILL PRESENT → FIXED in C1.** A pure state model
  (`shared/videoState.mjs`) over the media events + WHEP transport signals makes `playing` the
  only confident-green state; `waiting`/`stalled`/transport-`dropped`/`error` all clear it, so a
  frozen/reconnecting stream reports `video_lock:false`. GRID, HUD, and W2 read one authority.
  Real WebRTC-drop behavior REQUIRES HARDWARE (camera → WHEP). Batch: **C1 — DONE (code),
  bench-pending**.

**L4 — Windows `ping` exit-code semantics can false-green IPHONE REACHABLE.**
- Evidence: `main/hostProbe.js:22-31` — exit 0 ⇒ reachable; Windows ping returns 0 for
  router-originated "Destination host unreachable" replies. Flat hotspot subnet gives
  timeouts (correct red); routed/office networks can false-green.
- **Revalidation: STILL PRESENT → FIXED in B4.** `classifyPing` no longer trusts exit code
  alone: a `TTL=` echo reply (locale-neutral) is the only `reachable`; a Windows exit-0
  reply WITHOUT `TTL=` (the router "Destination host unreachable" false-green) is classed
  `unreachable`; outcomes split into reachable/timeout/unreachable/invalid/
  command-unavailable/command-error/unknown, with conservative `unknown` where
  localization prevents certainty. UI wording proves the network path only (decision C4).
  Real Windows ping behavior REQUIRES HARDWARE. Batch: **B4 — DONE (code), bench-pending**.

**L5 — Doc/state drift.**
- Evidence: `../CURRENT_STATUS.md` records `3c16954`/217 tests (HEAD is `cf038c2`/263;
  update known-deferred by user). Bench host clone at `dab3039`, must pull ≥ `cf038c2`.
  `docs/setup_flow_bench_checklist.md` prereqs omit `npm run setup` (mediamtx fetch +
  Electron repair) and the `mediamtx.yml` camera-source edit — literal reading reaches
  §10 ("HUD fades in over live video") with video never possible.
  `docs/iphone_bridge_readiness.md` §4 describes a 400 ms stale timeout + re-arming
  centered gate superseded by the contract (300 ms, no re-arm) — implementation follows
  the contract; readiness doc is stale.
- **Revalidation: STILL PRESENT.** Batch: **F**.

**L6 — Hotspot password persisted in plaintext.**
- Evidence: `renderer/setupFlow.js:173-184` (`leavePitwall` saves `hotspot.password`
  every visit) → `settings.json` under userData. Wi-Fi *join* passwords are NOT persisted
  (only via netsh profile; temp XML deleted). Acceptable for a hobby tool; on disk though.
- **Revalidation: STILL PRESENT → FIXED in E1** (decision Q6). The hotspot password is
  now encrypted at rest via Electron safeStorage (DPAPI/Keychain/libsecret) — on disk only
  as a versioned `network.hotspot.passwordEnc` ciphertext token, plaintext blanked
  (incl. `.bak`); no plaintext fallback; legacy plaintext migrated (encrypt or quarantine);
  session-only when encryption is unavailable; undecryptable/corrupt degrades to re-enter
  without a crash and with unrelated settings intact; the value and ciphertext are never
  logged. Wi-Fi *join* passwords remain transient (never persisted). Real Windows DPAPI
  behavior REQUIRES HARDWARE. Batch: **E1 — DONE (code), DPAPI bench-pending**.

### DESIGN QUESTIONS (all REQUIRE USER DECISION)

**D1 — Replay telemetry visually indistinguishable from live car data on the HUD.**
`npm run demo` is deliberately "live-looking"; HUD shows LQ/battery with no demo marker
(`mode:"demo"` goes only into the iPhone packet). PIT WALL sim got a "SIMULATED WIFI"
tag for exactly this confusion risk. Options: session-panel REPLAY chip, watermark,
both, status quo. Batch: **C2**.

**D2 — GRID re-applies the session (starting the W2 UDP sender) on *entering* GRID,
before START.** Evidence: `renderer/setupFlow.js:391-409` `enterGrid()` →
`gs.applySession()` → `main/main.js:126-132` starts bridge if iphone-hud + addr.
Reachability check itself is ping-based and does NOT need W2. Effect: telemetry packets
flow to the phone during the checklist. Defensible (phone HUD shows live data while the
operator checks it) but undocumented. Batch: **C5**.

**D3 — Env-locked settings still editable in ⚙.** GRID radio note says "LOCKED BY ENV
VARS" once; the ⚙ telemetry/W3 controls stay enabled and silently lose to env.
Batch: **C3** (presentation choice: disabled + ENV badge showing effective value —
default proposed by auditor, user may veto).

### VERIFICATION GAPS

**V1 — no-control-path guard is an enumerated file list, not a directory sweep.**
- Evidence: `test/noControlPath.test.js:75-121` — hardcoded lists; a NEW `main/` module
  importing `HeadTrackingReceiver` passes CI until someone appends it. Plan relied on
  review discipline. Recommendation: glob `main/`+`shared/`+`renderer/` with explicit
  allowlist (`main.js` only), keeping all existing assertions.
- **Revalidation: STILL PRESENT → FIXED in D1.** The two enumerated lists are DELETED; the
  guard now walks `main/`+`shared/`+`renderer/` (symlink-safe, extension-classifying) and
  scans every discovered runtime module — a new file is included automatically. All prior
  semantic assertions are preserved. See the Batch D status section below. Batch: **D1 — DONE**.

**V2 — `main.js` and `renderer/setupFlow.js` have zero test coverage.**
- The two files where defects were found (M1 in untested renderer glue;
  `applyW3`/`w3ConfigFor`/IPC shapes in untested main.js). No Electron boot smoke test
  (CI package-smoke proves packaging, not boot).
- **Revalidation: STILL PRESENT → PARTIALLY FIXED in A2**: `renderer/setupFlow.js` (+
  `hud.js` key handlers) now run under jsdom in `test/setupFlowDom.test.js` — real
  index.html, real modules, mocked preload surface (the D2 harness, pulled forward).
  `main.js` remains uncovered. Batches: **D2** (extend DOM coverage), **D3** (boot
  smoke, Windows CI job preferred).
- **→ D2 COMPLETE (2026-07-14):** `main.js` decomposed onto dependency-injected seams
  (`main/appWiring.js` + `w3ConfigFor` in `main/headTrackingConfig.js`) that unit-test
  with fakes; IPC/preload/renderer symmetry pinned from all three sides
  (`test/ipcSurface.test.js`); session/config/shutdown integration covered
  (`test/appWiring.test.js`); renderer boot/timer/subscription races covered + two
  orphaned-interval defects FIXED. Remaining: a REAL Electron boot (preload execution,
  live ipcMain, sandbox flags at runtime) = **D3**. Batch: **D2 — DONE**.
- **→ D3 COMPLETE (2026-07-14, this session):** a deterministic REAL-Electron boot smoke
  (`scripts/smokeMain.js` + `scripts/electron-smoke.js` + `scripts/smokeShared.js`,
  `npm run smoke:electron`) proves the live boot end-to-end — window, load, preload
  execution, exact `window.groundStation` surface, runtime sandbox/contextIsolation/
  nodeIntegration/webSecurity/webviewTag flags, window.open + navigation denial, a real
  `config:get`/`settings:get` round trip, GARAGE readiness, console-clean — across
  normal / corrupt-settings / forced-failure / timeout scenarios, all PASS locally;
  windows-latest CI job extended (`npm test` + smoke + artifact-on-failure before the
  package step). CI execution itself pends the next push. Batch: **D3 — DONE**.

**V3 — IPHONE REACHABLE green ≠ HUD can receive UDP 5601.**
- ICMP proves L3 reachability; iOS Local Network permission can still block UDP receive.
  W2 is deliberately one-way, so the app *cannot* know. Checklist §8 partially covers it.
- **Revalidation: STILL PRESENT** (inherent limit — wording fix only). Batch: **C4**.

### Also recorded in the original audit (context, no action or covered above)

- Sim is specified-optimistic (`wifiSim` returns `START_Success` unconditionally) — the
  "sim is never bench evidence" rule is the documented mitigation (README + checklist).
- WPA3-SAE caveat folded into L2/B3. CSP pins connect-src to `127.0.0.1:8889`
  (`W17_WHEP_URL` override footgun — LOW, note only). `netsh` argv quoting for names
  with spaces is believed fine via argv arrays but bench-unverified (D4 adds static
  command-generation tests). PIT WALL entry latency: `wifi:capabilities` awaits a
  PowerShell WinRT probe with 20 s timeout (LOW/UX, see N3).

## 2. New findings discovered at revalidation (not in the original audit)

**N1 — Renderer IPC glue has zero error handling.** `grep catch renderer/setupFlow.js
renderer/hud.js` → no matches. Any IPC rejection (e.g., `settings:set` disk failure,
handler throw) is an unhandled rejection; if `boot()`'s `gs.getSettings()` rejects, the
gate renders blank with no step visible. LOW-MEDIUM robustness. Batch: **D2/A2**
(harden `boot()` + wrap save path minimally; test).
**→ FIXED in A2**: every async IPC call in `renderer/setupFlow.js` and `renderer/hud.js`
is deliberately guarded (narrow, one call per guard; real error logged, fixed
credential-free fallback rendered in the relevant UI region). `boot()` failure renders a
visible SETUP DATA UNAVAILABLE state with RETRY (`#bootError`); save failures warn on the
team radio and never block the flow; join/hotspot/settings-save rejections withhold raw
error detail from the log (their arguments carry credentials). jsdom tests cover all of it.

**N2 — `HotspotManager.stop()` drops ownership before the stop completes.**
`main/hotspot.js:146-156` clears `_activeBackend` before awaiting the command; a failed
stop loses the "we own an active hotspot" state, so retry is impossible. LOW.
**→ FIXED in A1**: `_activeBackend` is now cleared strictly AFTER a successful stop; a
failed stop returns `{ok:false, kind:'stop-failed', backend}` and retains ownership.
Test: `test/hotspot.test.js` "a FAILED stop retains ownership…".

**N3 — PIT WALL entry can block on the hotspot probe.** `enterPitwall()` awaits
`wifi:capabilities` → `hotspot.probeBackends()` (PowerShell WinRT, 20 s timeout) before
showing tabs; on a slow/broken PS the network step appears frozen. LOW/UX.
**→ FIXED in B1/N3**: `wifi:capabilities` no longer probes at all (it answers instantly
with platform + sim flag); the WinRT probe moved to its own non-blocking
`wifi:hotspot-probe` channel through the lifecycle authority (cached, single-flight,
`{refresh:true}` re-probe). PIT WALL renders immediately; the HOTSPOT pane shows
`CHECKING HOTSPOT SUPPORT…` until the probe lands and distinguishes
probing/supported/unsupported/failed/externally-active. Adapter + network UI stay usable
throughout. Batch: **B1/N3 — DONE**.

**N4 — `runCommand` timeout kill doesn't kill the Windows process tree.**
`main/runCommand.js:31-34` `child.kill()` only; a hung PowerShell can orphan WinRT work.
LOW. **→ FIXED in A1**: on win32 the timeout path now runs
`taskkill /pid <pid> /t /f` (falls back to `child.kill()` on taskkill spawn error / off
Windows). Tests: `test/runCommand.test.js` (timeout result shape, cross-platform).

## 3. Priority and batch plan

| Batch | Contents | Gate |
|---|---|---|
| A1 | H1 Mobile Hotspot PS rewrite (fail-closed, structured results, both awaiter kinds, `$ErrorActionPreference='Stop'`; static script assertions + result-shape tests; bench-diagnostic command) | objective — no approval needed |
| A2 | M1 keyboard scoping (+ Enter=JOIN, per user instructions), pure focus-helper + tests; minimal N1 hardening of boot/save | objective |
| A3 | M2 adapter-pinned status/join + reversed-order fixtures; adapter-UI discrepancy investigation report (present behavior → questions → proposals; NO redesign without approval) | objective (fix) + decision (UX) |
| B1 | M3 + N2 + N3: STOP HOTSPOT UI lifecycle, stop-state ownership fix; quit policy | **user decision: quit policy** |
| B2 | L1 locale-neutral elevation/error detection + non-English fixtures | objective |
| B3 | L2 open/WPA3/hidden/malformed SSID scope | **user decision: scope** |
| B4 | L4 ping semantics: classify reachable/timeout/unreachable/invalid/unavailable | objective |
| C1 | L3 video state model over media events + tests | objective — **DONE** |
| C2 | D1 replay/sim marking | Q4 logged — **DONE** |
| C3 | D3 env-locked settings presentation | Q8 logged — **DONE** |
| C4 | V3 reachability wording | **DONE** (landed in B4, re-validated in C) |
| C5 | D2 W2-on-GRID timing | Q5 logged — **DONE** (documented, unchanged) |
| D1 | V1 directory-sweep no-control-path guard (existing assertions preserved) | objective — **DONE** |
| D2 | V2/N1 setup-flow DOM tests (smallest env; likely jsdom via vitest) | objective — **DONE** |
| D3 | V2 Electron boot smoke (Windows CI job) | objective — **DONE** (local; CI execution pending push) |
| D4 | Command-generation tests (spaces, non-ASCII SSIDs, special-char passwords, argv separation, XML escaping) | objective — **DONE** |
| E1 | L6 credential storage policy + never-log guarantee | **user decision: policy** (never-log objective) — **DONE (code), DPAPI bench-pending** |
| F | L5 + all doc sync (checklist prereqs, CURRENT_STATUS pointer, readiness-doc stale note, adapter/hotspot/sim/permission docs; contract §1–§7 untouched) | objective |
| G | Wider proposal pass (proposals only, no unapproved implementation) | proposals |

## 4. User decisions (log)

| # | Topic | Decision | Date |
|---|---|---|---|
| Q1 | Hotspot quit policy (B1) | **(a) Ask on quit** — dialog ONLY when the app owns an active hotspot; buttons STOP HOTSPOT AND QUIT / LEAVE HOTSPOT RUNNING / CANCEL. Never shown for a hotspot the app did not start. | 2026-07-12 |
| Q2 | STOP HOTSPOT button + lifecycle (B1) | **Approved**: INACTIVE→STARTING→LIVE→STOPPING (+ actionable ERROR); STOP beside START; conflicting actions disabled during transitions; duplicate requests prevented; failed stop retains ownership + allows retry (UI stays LIVE); never stop externally-started hotspots; N2 fixed (`_activeBackend` cleared only after successful stop). | 2026-07-12 |
| Q3 | Wi-Fi network scope (B3) | **(a) Support saved AND new open networks** with an OPEN NETWORK security warning and no password field; WPA3-only rejected with "WPA3-only networks are not currently supported. Use a WPA2 network or start the W17 hotspot."; malformed/empty SSIDs skipped; hidden networks out of scope but must yield a clear unsupported message, never a raw netsh error. Tests: open/WPA2/WPA3-only/malformed/escaping. | 2026-07-12 |
| Q4 | Replay/sim visual treatment (C2) | **(a)** Compact persistent `TELEMETRY · REPLAY` chip in the HUD session panel while replay telemetry is active; not dismissible while replay runs; visible in screenshots; SIMULATED WIFI stays separate; no watermark. | 2026-07-12 |
| Q5 | W2 start timing (C5) | **(a) Keep GRID-entry start, document it**: wording must state W2 begins on GRID entry (iPhone mode + confirmed IP) as preflight evidence; ping proves path only; live phone data is the meaningful evidence; START begins the driving/HUD session. No new preflight packet type. | 2026-07-12 |
| Q6 | Credential storage policy (E1) | **safeStorage/DPAPI encryption, NO persistent-plaintext fallback**: transparent plaintext→encrypted migration; ciphertext everywhere incl. `.bak`; when OS encryption unavailable → keep in memory for session only, do not persist, warn concisely; undecryptable secrets (foreign account/machine) → no crash, clear/ignore secret, re-request password, preserve other settings; credentials never in logs/errors/diagnostics/snapshots/test output; redaction tests required. | 2026-07-12 |
| Q7 | Adapter UX direction (A3) | Likely cause accepted (macOS guide mode w/o sim) but **verify the actual launch path**. Approved direction: ALWAYS show an ADAPTER section in PIT WALL — Win: 0=NO WLAN ADAPTER + troubleshooting + RESCAN; 1=clearly styled selected-adapter card; 2+=obvious dropdown (border/chevron/hover/focus, SELECT/CHANGE ADAPTER wording); saved-missing=show saved name marked NOT DETECTED, require re-choose; show name/description/state/SSID/signal. Guide mode: show section with "Adapter selection is available in the Windows application" + `W17_WIFI_SIM` dev hint; never present host interfaces as usable adapters. Sim: deterministic 0/1/2-adapter scenarios, 2-adapter demonstrates selection. Show revised design before *substantial* visual redesign; objective visibility/error fixes may proceed. | 2026-07-12 |
| Q8 | Env-lock presentation (C3) | **Confirmed**: disabled control + amber ENV tag + effective value shown + tooltip naming the exact env var + explanation that env takes precedence. Disabled controls must stay readable/accessible; where disabled blocks focus/tooltip, use readonly + adjacent lock indicator. | 2026-07-12 |
| C4 | Reachability wording | **Confirmed, shorter UI string**: "Ping succeeded. This proves the network path only. Confirm live data on the iPhone; check iOS Local Network permission if it does not appear." Longer explanation goes to checklist/tooltip. | 2026-07-12 |

Additional execution orders (2026-07-12): address N1 (renderer IPC rejection handling +
visible boot-failure state), N2 (ownership retained after failed stop), N3 (PIT WALL
renders before the WinRT probe completes, visible probing state), N4 (prevent orphaned
PowerShell trees where reasonable). Batch order: A1 → A2 → A3 → B2/B4/C1/C4/D1/D2/D4 →
approved decision-gated work. All changes stay uncommitted; focused + full tests after
every batch.

## 5. Remaining hardware-only verification (after this pass)

Bench host (Windows + admin + RT5370): real netsh scan/join/profile quoting; Mobile
Hotspot WinRT behavior (H1 fix proof) incl. SSID actually broadcast; hostednetwork
fallback + elevation; tasklist detection + elrs survival; ping semantics on the real
network(s); firewall prompts (inbound UDP 5602); localized-Windows behavior if
applicable. Camera: H.264 check, RTSP URL, mediamtx WHEP. Car/ELRS: crsf-serial
telemetry via com0com. iPhone: W2 display, Local Network permission, W3 log-only runbook,
client-isolation negative test. All tracked in `docs/setup_flow_bench_checklist.md`.

**B3/B4 additions:** real `netsh wlan show networks mode=bssid` Authentication/Encryption
values on the bench (confirm the `security` classification for an actual open, WPA3-only,
enterprise, and WPA2/WPA3 transition AP — especially how a real transition AP reports its
Authentication); a real new-open-network join via the installed open profile; and real
Windows `ping` output — confirm a live host shows `TTL=` (→ reachable) and a
router-originated "Destination host unreachable" is classed `unreachable` not a false green,
including on a localized Windows build.

## 6. Change log

- 2026-07-12 — Audit document created at revalidation; tree = `cf038c2`, clean;
  baseline `npm test` 263/263. No code changes yet.
- 2026-07-12 — Q1–Q8 + C4 decisions recorded (§4).
- 2026-07-12 — **Batch A1 complete (code)**: H1 hotspot PowerShell rewrite (fail-closed,
  structured `kind` results, both awaiters), N2 ownership-after-success, N4 Windows
  tree-kill, sim token vocabulary updated, `test/hotspot.test.js` rewritten (10→23), new
  `test/runCommand.test.js` (4), new `scripts/hotspot-diag.js` bench tool. Focused tests
  48/48; full suite **280/280**. WinRT behavior remains bench-only. Details in the
  transfer checkpoint below. NOT committed.
- 2026-07-12 — **A1 independently verified** in a fresh cross-account session: tree
  matched this checkpoint byte-for-byte (same `git status`, HEAD `cf038c2`); skeptical
  re-review found no interrupted-edit debris, duplicate declarations, unreachable
  branches, token collisions, unsafe fallbacks, ownership errors, credential leaks, or
  PS/reflection faults; syntax checks OK; focused 48/48 and full 280/280 reproduced.
  No A1 changes were needed.
- 2026-07-12 — **Batch A2 complete**: M1 keyboard scoping via new
  `shared/keyboardFocus.mjs` (editable/interactive predicates + HUD key-mirror and
  Enter-nav handler factories) wired into `renderer/hud.js` + `renderer/setupFlow.js`;
  Enter in the Wi-Fi password field = JOIN; N1 renderer IPC-rejection hardening
  everywhere (visible `#bootError` + RETRY on failed initial settings load; fixed
  credential-free fallbacks for scan/join/hotspot/status/probe/apply/launch; save
  failures warn on team radio; credential-carrying channels withhold raw log detail);
  `renderer/index.html` + `hud.css` gained the boot-error block. New
  `test/keyboardFocus.test.js` (16) and `test/setupFlowDom.test.js` (8, real
  index.html + real renderer modules under jsdom with a mocked preload); `jsdom` added
  as a devDependency (D2's harness, pulled forward); `shared/keyboardFocus.mjs` added to
  the noControlPath guard list. Focused 72/72 (incl. A1 re-run); full suite **304/304**
  (27 files). NOT committed.
- 2026-07-12 — **A1 + A2 handoff re-verified in a fresh session** before A3: tree matched
  the checkpoint exactly (same `git status`, HEAD `cf038c2`, `git diff --check` clean);
  focused verification set (keyboardFocus/setupFlowDom/hotspot/wifiSim/runCommand/
  noControlPath) reproduced **72/72**. No A1/A2 changes needed.
- 2026-07-12 — **Batch A3 complete (code)**: M2 adapter-pinned status/join. Merged
  `parseNetshInterfaces` DELETED from `shared/wifiParse.js` (adapter status can no
  longer mix fields across blocks by construction); `main/wifiManager.js` `status()`
  gained `{iface}` pinning + honest `ok:false` netsh-failure results; `join()` verifies
  against the pinned block with last-poll-only timeout errors; `main/wifiSim.js` tracks
  joins PER ADAPTER (`interface=` respected) with distinct per-adapter signals;
  `shared/wifiView.mjs`: saved-adapter-missing now demands an explicit choice (disabled
  NOT DETECTED placeholder, `selected:''` — no silent fallback), labels carry
  same-object SSID+signal, new guide-mode state; `renderer/setupFlow.js`: ADAPTER row
  always rendered on PIT WALL (guide mode included, with the W17_WIFI_SIM dev hint),
  scan/join blocked while the picker is unresolved, guide VERIFY distinguishes a failed
  netsh status check from "not detected"; `renderer/hud.css`: `select:focus` teal
  border (parity with inputs — keyboard focus was invisible on the picker). 4 new
  fixtures (two-both EN, reversed EN, two-both DE, dongle-connecting EN). Tests:
  wifiParse 18, wifiManager 26, wifiView 12, wifiSim 13, setupFlowDom 12. Focused
  A3 **81/81**; A1/A2 regression **53/53**; full suite **327/327** (27 files, was
  304); `git diff --check` clean. Real netsh/RT5370 behavior remains bench-only.
  NOT committed.
- 2026-07-12 — **A3 adapter-card follow-up complete (Q7 decision: Option 2 "Adapter
  card")**. The user chose Option 2 with a refined spec (native `<select>` inside the
  card, no custom popup; keyboard/screen-reader preserved; `ADAPTER CHECK FAILED`
  wording). The ADAPTER row was promoted from a one-line span/select to a compact
  panel-style card reusing the PIT WALL vocabulary. `shared/wifiView.mjs`:
  `adapterRowState` now returns a card model (per-adapter `detail` with a
  connection-state chip, `selectedNote:'SELECTED'` for single, `selectorLabel`
  SELECT/CHANGE ADAPTER, `savedMissing`, `status`/`warn`/`rescan` for the degraded
  states; failure reason sanitized+capped; failed status text is now
  `ADAPTER CHECK FAILED`). `renderer/index.html`: card markup (`adapterhead`,
  `adapterdetail`, `adapterpick` w/ native select + chevron wrapper, `adapterstatus`,
  card `adapterRescan`). `renderer/setupFlow.js`: `renderAdapterCard(state)` renders the
  model; the picker change re-renders from a cached listing (immediate card update, no
  extra netsh call) + persists + rescans pinned; degraded states surface a card RESCAN
  and hide the join-pane RESCAN to avoid a duplicate. `renderer/hud.css`: `.adaptercard`
  + `.statechip` (teal/idle/amber) + native-select chevron/hover/focus; left accent
  teal=interactive / amber=warning / neutral=readonly. NO change to
  `wifiParse`/`wifiManager`/`wifiSim` (the two-adapter sim already demonstrates
  per-adapter switching, A3). Tests: `wifiView` 12→**14** (card model + sanitized
  reason), `setupFlowDom` 12→**14** (guide/zero/one/saved-missing/two-adapter card
  states, native-select assertion, change→persist→re-pin, no silent fallback). Focused
  adapter/view/DOM **28/28**; A1–A3 regression + noControlPath **110/110**; full suite
  **331/331** (27 files, was 327); `git diff --check` clean. Chromium visual eyeball of
  the four `W17_WIFI_SIM` scenarios remains a dev/bench manual item (jsdom can't render
  CSS). NOT committed.
- 2026-07-12 — **Adapter-card VISUAL ACCEPTANCE PASS complete (Electron, real app)**. Ran
  the real, unmodified app (`main/main.js`) under all six states — `W17_WIFI_SIM=`
  two-adapters / one-adapter / no-adapter / netsh-fail, plain (guide), and a seeded
  saved-missing — via a scratchpad Electron harness that boots the app, drives GARAGE →
  IPHONE COCKPIT → PIT WALL, and captures a screenshot + a computed-style/DOM dump per
  state (harness is scratchpad-only, never committed). Every state rendered correctly
  (card layout, chip tones, SELECTED/CHANGE/SELECT ADAPTER labels, teal chevron, amber
  NOT DETECTED, single-RESCAN degraded states, guide note, per-adapter switching, no
  page-level horizontal overflow). **Two small objective visual fixes applied to
  `renderer/hud.css`:** (1) the native `<select>` overflowed to the card's right edge
  (ellipsis/chevron cramped against the border) — the picker is now a column (label above)
  with the select at `width:100%` so it ellipsizes with the card padding as breathing room;
  (2) the card was ~12 px wider than the network list below it — card width set to
  `min(46ch,80vw)` to match the netlist so their right edges align. **One a11y fix to
  `renderer/index.html`:** the `<select>` had no programmatic name (only visible text
  labels) — added `aria-label="WLAN adapter"` (pinned by a new assertion in
  `test/setupFlowDom.test.js`). Focus was verified clearly visible (bright-teal select
  border on focus per app convention; prominent focus ring on the RESCAN button) — no
  focus change needed. No interaction/redesign change. Re-ran: focused adapter/view/DOM
  **28/28**, A1–A3 regression + noControlPath **110/110**, full suite **331/331**,
  `git diff --check` clean. Touched only `renderer/hud.css`, `renderer/index.html`,
  `test/setupFlowDom.test.js` — the `git status` file set is unchanged. NOT committed.
- 2026-07-13 — **Batch B1 + B2 + N3 complete (code)** — M3 (hotspot lifecycle + quit
  policy), N3 (non-blocking probe), L1→B2 (locale-neutral errors). One combined batch.
  New main-process runtime authority `main/hotspotLifecycle.js` (238→now ~250 lines):
  wraps `HotspotManager` and owns the phase model INACTIVE→STARTING→LIVE→STOPPING with an
  honest error presentation (failed start → INACTIVE + lastError + B2 suggestion; failed
  stop → LIVE, ownership retained, retryable; config-mismatch partial start → LIVE + error
  + owned, ssid withheld). Duplicate start/stop suppressed at the authority (`kind:'busy'`).
  Capability probe (N3) is cached + single-flight + `{refresh}`-able, emits a `probing`
  snapshot immediately, and turns a rejection into a controlled `failed` status. New
  `main/quitPolicy.js` (92 lines): `before-quit` shows the STOP AND QUIT / LEAVE RUNNING /
  CANCEL dialog ONLY when the app owns the hotspot, waits for a settled state (quit during
  STARTING/STOPPING), stops-then-quits, keeps the app open on a failed stop, and has no
  recursive-quit loop (a decision latches `allowQuit`). `main/main.js`: capabilities no
  longer probes; new `wifi:hotspot-state`/`wifi:hotspot-probe` IPC; the lifecycle pushes
  every snapshot to the renderer over `hotspot-state`; `before-quit` wired to the policy;
  the hotspot is deliberately NOT torn down in `will-quit`. `main/preload.cjs`:
  `hotspotState`/`hotspotProbe`/`onHotspotState` added (minimum surface). B2 in
  `main/hotspot.js`: the English `/denied|elevat|administrator/` regex is DELETED; hosted
  start failures classify as generic `start-failed`+`backend:'hosted'` and consult a new
  locale-neutral `PS_ELEV` token (`WindowsPrincipal.IsInRole` → `ELEV_ADMIN`/`ELEV_LIMITED`)
  to decide whether to attach the administrator SUGGESTION (never when elevated; kept when
  unknown); mobile results gained `backend:'mobile'`; a failed hosted fallback keeps the
  superseded mobile failure as `fallbackFrom`; raw localized detail is retained sanitized.
  `shared/wifiView.mjs`: new pure `hotspotPaneState(snap)` maps the lifecycle snapshot to
  the pane's controls/text. `renderer/setupFlow.js`: HOTSPOT pane renders exclusively from
  main's snapshots via one `adoptHotspotSnap` gate; START/STOP handlers only issue requests.
  `renderer/index.html`+`hud.css`: STOP HOTSPOT button, `hsHint`, RECHECK SUPPORT, disabled
  styling. **Lifecycle sequence race found + fixed during the Electron sim pass** (see the
  next entry). New tests: `test/hotspotLifecycle.test.js` (**26**), `test/quitPolicy.test.js`
  (**13**), `test/hotspot.test.js` +7 B2/backend (23→**31**), `test/wifiView.test.js`
  +11 pane (14→**25**), `test/setupFlowDom.test.js` +9 pane +9 race (14→**31**),
  `test/wifiSim.test.js` +1 elev (13→**14**), 2 new fixtures
  (`netsh_hosted_start_failed_en/de.txt`), `test/noControlPath.test.js` guard-list +2
  (lifecycle + quitPolicy). Full suite **407/407** (29 files, was 331/27); focused
  lifecycle/quit/probe/B2/pane/DOM/noControlPath all green; `git diff --check` clean.
  Real WinRT/netsh/localized-Windows behavior remains bench-only. NOT committed.
- 2026-07-13 — **Lifecycle SEQUENCE RACE — discovered + fixed (Electron sim pass).** The
  real-app Electron harness (scratchpad-only) exposed a delivery-order defect the jsdom
  tests could not: Electron does **not** guarantee `webContents.send` pushes arrive in emit
  order. A `probe:'probing'` push (emitted first, inside the `hotspotProbe` IPC turn) was
  delivered to the renderer AFTER its own `supported` completion push, so the stale
  `probing` overwrote `supported` and the pane wedged on `CHECKING HOTSPOT SUPPORT…`
  forever (send-log `#1 probing #2 supported`; page received `[supported, probing]`).
  Root cause: the renderer trusted arrival order. Fix: snapshots carry a monotonic `seq`
  from the authority (`_emit()` bumps `_seq`; `snapshot()` reports it); the renderer routes
  BOTH the pull and push paths through one `adoptHotspotSnap(snap)` gate that drops any
  `snap.seq < heldSeq`. Equal seq is idempotent; a missing seq (legacy) is adopted
  last-writer-wins; the renderer never mints a seq. Post-fix the harness reproduced the
  exact out-of-order delivery and the pane settled to `READY — mobile backend` correctly,
  through the full START→LIVE→(nav away/back)→STOP cycle. Regression tests:
  `test/hotspotLifecycle.test.js` "snapshots carry a strictly increasing seq…" and a
  `test/setupFlowDom.test.js` "hotspot snapshot adoption / lifecycle sequence race" block
  (9 cases: stale pushed-vs-pulled either way, equal-seq idempotence, newer STOPPING /
  stop-error adoption, old-cannot-re-enable-START-while-owned, boot with no held seq,
  real-lifecycle seq survives start→live→stop + re-entry). This race was NOT in the
  original audit — jsdom delivers listener callbacks synchronously and never reorders.
- 2026-07-13 — **B1/B2/N3 Electron simulation acceptance (real app, scratchpad harness).**
  Ran `main/main.js` unmodified under `W17_WIFI_SIM=two-adapters` and `=netsh-fail`,
  driving GARAGE→IPHONE COCKPIT→PIT WALL→HOTSPOT and sampling the pane + capturing
  screenshots per state. **two-adapters:** send-log `#1 probing #2 supported #3 starting
  #4 live #5 stopping #6 inactive` all delivered and adopted in causal order; pane went
  READY (START enabled, STOP disabled) → START → LIVE (`LIVE (mobile) — join "W17-GRID"…`,
  teal, START disabled, STOP enabled, SSID/PASS disabled) → NEXT/BACK still LIVE (no stale
  pull overwrite) → STOP → READY (START re-enabled, STOP disabled), radio logged HOTSPOT
  LIVE then STOPPED; adapter card unaffected throughout. **netsh-fail:** probe reported
  `READY — hosted backend` while the adapter card independently showed `ADAPTER CHECK
  FAILED` (capability NOT conflated with adapter availability); START surfaced
  `hostednetwork config failed: … (wlansvc) is not running.` with RECHECK visible; RECHECK
  re-probed. Screenshots (LIVE, after-STOP, netsh-fail failure) visually confirmed.
  Transient STARTING/STOPPING-disabled visuals and the stop-failure/retry path are not
  sim-reachable (the sim always succeeds, instantly) — those are proven by the DOM
  integration tests (real renderer + real lifecycle + routed failing runner) and the
  lifecycle/quit unit tests. This is dev-preview evidence only; NOT real-Windows evidence.
- 2026-07-13 — **Batch B3 complete (code)** — L2 Wi-Fi security scope (decision Q3). A
  normalized security model now drives the join flow; the renderer + manager branch on it,
  never on localized netsh prose. `shared/wifiParse.js`: `parseNetshNetworks` now also
  captures the **encryption** field (3rd positional) and attaches a normalized `security`
  kind via the new exported `classifyWifiSecurity({auth,encryption})`; raw auth/encryption
  are retained for diagnostics; empty/whitespace SSIDs stay dropped. New
  `buildOpenWlanProfileXml(ssid)` (authentication=open, encryption=none, NO key; SSID
  XML-escaped). `shared/wifiView.mjs`: new pure `joinPlan(n)` (reject/open/join/password
  decision) + `networkBadge(n)` + exported Q3 strings (`WPA3_ONLY_MESSAGE`,
  `ENTERPRISE_MESSAGE`, `OPEN_NETWORK_WARNING`). `main/wifiManager.js`: `join()` gained
  `{security, known}` — rejects `wpa3-only`/`enterprise`/empty-SSID BEFORE any OS call with
  stable kinds (`unsupported-wpa3`/`unsupported-enterprise`/`unsupported-hidden-network`),
  installs an OPEN profile for a new open network, a `password-required` controlled error
  for a secured no-profile-no-password case, and preserves the WPA2-PSK path + temp-file
  cleanup + adapter pinning + redaction. `renderer/setupFlow.js`: `selectNetwork` branches
  on `joinPlan` (OPEN warning + hidden password + JOIN; WPA3/enterprise reject message;
  transition/unknown caution note), `doJoin` passes `security`+`known`, the row badge shows
  the security kind. `renderer/index.html`: `#netSecNote`. `renderer/hud.css`: `.hint.warn`
  (amber) + **`#netPassword.hidden{display:none}`** (this stylesheet has no global `.hidden`
  rule — see the CSS defect below). `main/wifiSim.js`: `NETWORKS_TEXT` expanded to span the
  branches (open/WPA3-only/enterprise + an empty-SSID block that must be skipped). New
  fixtures `netsh_networks_security_en.txt`, `netsh_networks_open_de.txt`. Tests: wifiParse
  18→**39**, wifiManager 26→**35**, wifiView 25→**34**, wifiSim 14→**16**, setupFlowDom
  31→**40**. NOT committed.
- 2026-07-13 — **CSS defect found + fixed in the B3 Electron pass** (not visible to jsdom).
  Hiding the open-network password field via `netPassword.classList.add('hidden')` was a
  visual NO-OP: this stylesheet has no global `.hidden{display:none}` — every hideable
  element carries its own scoped rule (`.netjoinrow.hidden{…}`, `.hint.hidden{…}`, …), and
  there was none for the `<input id="netPassword">`, so the class was set (jsdom saw it,
  tests passed) but the field still rendered. The real app screenshot exposed it; fixed by
  adding `#netPassword.hidden{display:none}` to `renderer/hud.css`. jsdom does not apply the
  linked stylesheet or compute layout, so the DOM test's class assertion cannot catch this —
  the Electron `getComputedStyle` sample (`display:"none"`, JOIN still `block`) is the proof.
- 2026-07-13 — **Batch B4 complete (code)** — L4 reachability probe classification. The
  probe stays ICMP (a TCP port has no defensible meaning: the iPhone HUD receives W2 over
  UDP 5601, gated by iOS Local Network permission; the phone screen is the final evidence),
  but classifies from STABLE STRUCTURAL signals instead of exit code alone.
  `main/hostProbe.js`: new exported pure `classifyPing(res, platform)` →
  `reachable | timeout | unreachable | invalid | command-unavailable | command-error |
  unknown`. Rules: a `TTL=` echo reply (locale-neutral token) is the ONLY green; a Windows
  exit-0 reply WITHOUT `TTL=` is the audit-L4 "Destination host unreachable" false-green and
  is classed **unreachable**, never reachable; a corroborating multi-locale phrase set backs
  it up; conservative `unknown` where localization prevents certainty. `probe()` returns
  `{ok, status, rttMs?|error}` (backward-compatible `.ok`). New `shared/reachability.mjs`
  (`PATH_ONLY_NOTE` = the exact decision-C4 wording + `probeStatusLine`) — added to the
  noControlPath guard list. `renderer/setupFlow.js`: the PIT WALL CHECK shows the honest
  per-status line and, on success, the full path-only caveat (`#addrNote`) so a green check
  can never read as "the iPhone HUD is receiving". `renderer/index.html`: `#addrNote`. New
  fixtures `ping_win_{reachable,timeout,unreachable}_en.txt` + `_de` reachable/unreachable.
  New tests `test/hostProbe.test.js` (**16**), `test/reachability.test.js` (**7**);
  setupFlowDom gained the B3+B4 UI cases (part of the 40). `test/noControlPath.test.js`
  guard-list +1 (`shared/reachability.mjs`). NOT committed. (The decision-C4 wording is
  realized here because the B4 spec mandates it under "Product truthfulness"; the other
  Batch C items — C1/C2/C3/C5 — remain untouched.)
- 2026-07-13 — **B3+B4 Electron simulation acceptance (real app, scratchpad harness).** A
  hidden BrowserWindow loaded the REAL `renderer/index.html` + REAL preload with the REAL
  managers over the `two-adapters` sim runner (harness scratchpad-only, never committed).
  **B3:** PIT WALL rows rendered with security badges — PaddockNet `KNOWN`, Cafe Guest 2.4
  `OPEN`, Paddock 6E `WPA3`, Team Corp `802.1X`; the empty-SSID block was absent (never a
  clickable row). OPEN → amber "OPEN NETWORK — no password; traffic is unencrypted", the
  password field computed `display:none` while JOIN stayed `block`. WPA3-only → exact Q3
  message, JOIN row hidden. Enterprise → "Enterprise (802.1X) networks are not currently
  supported…", JOIN row hidden. Adapter card stayed pinned/interactive (CHANGE ADAPTER,
  Wi-Fi selected) throughout — no adapter/hotspot regression. **B4:** 10.0.0.1 (canned
  reachable) → "REACHABLE 0ms — network path only" + the full path-only caveat shown;
  10.0.0.2 (timeout) → "NO REPLY — timed out", caveat hidden; 10.0.0.3 (canned exit-0
  Destination-unreachable) → "UNREACHABLE — no route to the phone" (the false-green surfaces
  RED), caveat hidden. Screenshots captured to scratchpad. Dev-preview only; NOT
  real-Windows evidence.
- 2026-07-13 — **B3 correction (user review): `unknown` security now fails conservatively.**
  The initial B3 pass routed `unknown` to a best-effort WPA2 password path — a deviation from
  Q3 (unknown must NOT be treated as WPA2). Corrected: `joinPlan` returns `reject` for a NEW
  unknown network (`unsupported-unknown-security`, message "This network's security type could
  not be identified. Use a known WPA2 network or start the W17 hotspot."), and
  `wifiManager.join` rejects `unknown && known !== true` BEFORE any OS call — no WPA2 profile,
  no `netsh connect`, even if a password is supplied. Sanitized raw auth/enc are preserved for
  a diagnostics tooltip (`securityDiag` → `netSecNote.title`), never the primary UI message.
  **Saved-profile carve-out (deliberate, documented, tested both ways):** a network Windows
  already has a saved profile for (`known:true`) still joins via that profile — the existing
  known-network `connect name=X` path constructs nothing and speculates nothing, so it is
  safe and is NOT a regression. Tests: wifiView 34→**35** (new-unknown reject + saved-unknown
  join), wifiManager 35→**36** (reject-with-password-still-no-OS-call + saved-profile connect),
  setupFlowDom 40→**42** (DOM: controlled message, password/JOIN hidden, no join call, raw only
  in the tooltip; saved-unknown joins). Full suite **480→484**; `git diff --check` clean. The
  `git status` file set is unchanged (same 47 entries).
- 2026-07-13 — **B3 unknown-security correction independently re-verified (start of the Batch C
  session).** A skeptical re-read confirmed the working tree already fails `unknown` conservatively
  (no `unknown → password` path anywhere): `joinPlan` returns `reject` for a NEW unknown
  (`shared/wifiView.mjs`), `wifiManager.join` rejects `unknown && known !== true` BEFORE any OS
  call even with a password supplied (`main/wifiManager.js:133`, test asserts zero spawned
  commands), the saved-profile carve-out joins via the stored profile constructing nothing, and
  the matrix (§ below) is conservative. Focused re-run 291/291 (wifi + hostProbe + reachability +
  A1–B2 lifecycle + noControlPath); `git diff --check` clean. **No B3 change was needed** — the
  correction logged above was already in place.
- 2026-07-13 — **Batch C complete (code) — truthful runtime state + configuration UX.** C1 video
  state (L3), C2 replay chip (D1/Q4), C3 env-locked settings (D3/Q8), C5 W2-on-GRID wording
  (D2/Q5); C4 reachability wording re-validated (landed in B4). **New files:**
  `shared/videoState.mjs` (pure video-state reducer + view), `shared/envLocks.mjs` (pure env-lock
  mapping), `test/videoState.test.js` (16), `test/whep.test.js` (5). **Modified:**
  `renderer/whep.js` (transport `onStatus` + stale-pc identity guard), `renderer/hud.js`
  (video-state authority, media listeners, feed-note wording, replay chip, `videoPlaying` derived
  from the model for GRID + W2), `renderer/setupFlow.js` (env-lock ⚙ presentation + partial-lock
  save guards, replay-chip refresh after applySession, GRID W2 note), `renderer/index.html`
  (`#feedNoteText`, `#replayChip`, ENV badges, `#gridNote`), `renderer/hud.css` (feed-note tones,
  `.replaychip`, `.envbadge`/`.setctl`/readable-disabled), `main/main.js` (`config:get` →
  `telemetrySource`; `settings:get` → `effective`), `test/setupFlowDom.test.js` +15 (42→**57**),
  `test/noControlPath.test.js` (guard-list +2: `videoState`, `envLocks`). Focused C 85/85
  (videoState 16, whep 5, reachability/C4 7, setupFlowDom 57); A1–B4 regression + noControlPath
  242/242; full suite `npm test` **520/520 (33 files)** (was 484/31); `git diff --check` clean.
  Electron visual acceptance (scratchpad harness, real renderer + real CSS, dev-preview only)
  passed for all four (see the Batch C status section). NOT committed.
- 2026-07-13 — **Batch D1 + D4 complete (code) — no-control-path directory sweep + command
  generation hardening.** D1 (V1): the two enumerated file lists in
  `test/noControlPath.test.js` are DELETED and replaced by a symlink-safe **directory sweep**
  of `main/`+`shared/`+`renderer/` that scans every discovered `.js/.mjs/.cjs` runtime module
  (10→**15** tests); all prior semantic assertions are preserved verbatim. D4: an audit of
  every external-command construction path plus a new consolidated
  `test/commandGeneration.test.js` suite (**17** tests) and **two objective source fixes** — (1) `main/wifiManager.js` now writes
  the key-bearing WLAN profile into a PRIVATE per-join `mkdtemp` directory (0700, removed in a
  `finally` after success AND failure) instead of a predictable `w17-wlan-<ms>.xml` in the
  shared tmpdir (CWE-377 symlink/pre-creation race + same-ms collision); (2) `main/runCommand.js`
  extracts the N4 tree-kill argv into an exported pure `winTreeKillArgs(pid)` so the `/t /f`
  flags are regression-tested. No behavior change to A–C. Only new untracked file is
  `test/commandGeneration.test.js` (git status 52→**53**). Full suite `npm test` **542/542
  (34 files)** (was 520/33); `git diff --check` clean. Real-Windows command behavior remains
  bench-only. NOT committed. See the Batch D status section below.
- 2026-07-14 — **BASELINE SHIFT: the user committed the entire pass as `79fa2e0`**
  ("a lot of chagnes", 62 files) — everything from A1 through D1/D4 PLUS the partial D2
  work of the interrupted 2026-07-14 session PLUS the separate 2026-07-14 contract-mirror
  docs session (`docs/windows_bridge_contract.md` sync from canonical `iPhone_rc@84532ed`,
  `docs/camera_aim_display_semantics.md`, `docs/video_topology_baseline.md`,
  readiness-doc superseded note). The "everything uncommitted at `cf038c2`" rule ended by
  the user's own action; work from here stays uncommitted ON TOP of `79fa2e0`.
- 2026-07-14 — **Batch D2 complete (code) — main-process + setup-flow integration coverage
  (V2/N1).** Started in the interrupted 2026-07-14 session (committed inside `79fa2e0`),
  completed in the recovery session (4 uncommitted files: `main/main.js`,
  `main/appWiring.js`, `test/appWiring.test.js`, `test/ipcSurface.test.js`).
  `main/main.js` (222 lines) remains the composition root and the ONLY W3 wiring site,
  but every wiring seam moved to the new **`main/appWiring.js`** and unit-tests with
  fakes: `createNetworkServices` (sim routing + the ONE `HotspotLifecycle` authority),
  `telemetrySourceFor`, `createSessionApplier` (settings+env → `resolveEffective` →
  runtime + injected `applyW3`), `createKeyedInstance` (the W3 receiver's idempotent
  restart choreography — construction stays in main.js), `mediamtxPaths` (+
  `W17_MEDIAMTX_DIR` override, the D3 smoke seam), `registerIpcHandlers` (single-sited,
  duplicate-proof, returns the channel lists), `wireHotspotPush` (+ `PUSH_CHANNELS`
  constants), `createWindowOptions`, `installNavigationPolicy`, `createTeardown`.
  `w3ConfigFor(effective, env)` moved to `main/headTrackingConfig.js` (pure,
  allowlisted). **Objective defects found + fixed (4):** (1) `enterGrid`
  orphaned-interval race — leaving GRID while `session:apply` was in flight let the
  stale continuation start the 1 s checklist poll forever (ping + elrs probes from the
  wrong screen); fixed with a `gridEpoch` guard; (2) the same class in `enterPitwall`
  (2 s addr-hint poll + stale DOM writes after the capability/adapter awaits); fixed
  with entry-epoch guards; (3) `will-quit` teardown was not failure-isolated — a
  throwing stop skipped the remaining steps (orphaned mediamtx); fixed via
  `createTeardown` (idempotent + per-step isolation); (4) the BrowserWindow had no
  window-open/navigation policy — `installNavigationPolicy` now denies `window.open`
  and renderer-initiated navigation outright (the app is one local page; `loadFile` is
  unaffected). New tests: `test/appWiring.test.js` (**43**), `test/ipcSurface.test.js`
  (**15**, static pins comment-stripped so a channel name in a comment can neither
  satisfy nor trip them), `test/headTracking.test.js` +5 `w3ConfigFor` (33→**38**),
  `test/setupFlowDom.test.js` +5 D2 renderer block (57→**62**: config-rejection
  resilience, subscription singletons, both race fixes under fake timers installed
  BEFORE the interval exists, exactly-one-interval accounting across leave/re-entry).
  Full suite `npm test` **610/610 (36 files)** (was 542/34); `git diff --check` clean.
  D3 NOT started (stop-for-review after the composition-root refactor). See the Batch
  D2 status section below.
- 2026-07-14 — **D2 committed by the user as `0564141`** ("test: harden main-process
  integration wiring") — exactly the 5-file completion set the previous checkpoint
  listed as uncommitted. Verified at the start of the D3 session: tree clean at
  `0564141`, full suite reproduced **610/610 (36 files)**, `git diff --check` clean;
  no D2 defect found, no redesign needed.
- 2026-07-14 — **Batch D3 complete (code + local smoke) — deterministic Electron boot
  smoke + Windows CI step (V2 closure).** New `scripts/smokeShared.js` (pure protocol:
  token format/parse with bounded buffers, pinned 20-method API list, console-error
  allowlist, secret-redacting log sanitizer, run evaluator), `scripts/smokeMain.js`
  (Electron entry: throwaway userData, `require`s the REAL unmodified `main/main.js`,
  proves 8 boot stages via public Electron APIs only, emits `W17_SMOKE` tokens),
  `scripts/electron-smoke.js` (plain-Node controller: 4-scenario suite, scrubbed env
  — ALL inherited `W17_*` deleted, sim + empty-mediamtx-dir + temp userData set —
  hard deadline with process-TREE kill reusing `winTreeKillArgs` (N4), grace-bounded
  clean-exit requirement, capped + sanitized logs, temp cleanup with Windows lock
  retry, pid-dead verification, non-zero on any scenario deviation). `package.json`
  +`smoke:electron`; `.github/workflows/ci.yml` package-smoke job extended
  (ensure-electron → `npm test` → smoke with 10-min step timeout + sanitized-log
  artifact on failure → existing rebuild/`--dir` steps; job timeout 30 min). New
  `test/electronSmoke.test.js` (**48**: parser/evaluator/sanitizer matrix, controller
  vs fake node children incl. hang-kill and no-clean-exit, scenario-contract pins,
  safety pins — production never reads `W17_SMOKE`/imports smoke tooling, smokeMain
  boots only `main/main.js`, calls only read-only preload methods, adds no
  IPC/window/preload surface, unit tests never launch Electron). **Four objective
  defects found + fixed IN THE NEW D3 CODE** during real-app runs (Electron quit exits
  0 regardless of `process.exitCode` → `app.once('quit')` hook; Electron 31
  `getLastWebPreferences()` omits the preload path → webSecurity/webviewTag asserted
  instead, preload execution proven by the exact-API stage; `PWD`/`OLDPWD` false
  positive in secret redaction → exempted; unbounded parser pending-line → 256 KB cap).
  **No production defect found — the D2 security wiring held at runtime.** Local real
  smoke: **4/4 scenarios PASS** (normal ready 1170 ms; corrupt-settings ready 339 ms;
  forced-failure exit 1 naming `ipc-roundtrip`; timeout tree-killed at 25 s), zero
  leftover processes/temp dirs. Focused 48+15; D2 regressions 158/158; D1/D4 164/164;
  A–C 134/134. Full suite `npm test` **658/658 (37 files)** (was 610/36);
  `git diff --check` clean; workflow YAML validated. CI execution itself REQUIRES the
  next push (nothing committed). See the Batch D3 status section below.
- 2026-07-14 — **D3 recovery + closure pass (fresh cross-account session).** The prior
  (Fable) session hit its limit while rewriting this checkpoint; D3 code/tests were complete
  but the audit's forward-looking sections were left stale. This pass took the repository as
  authoritative and independently re-verified everything: HEAD `0564141`, working tree
  **3 M + 4 ??** (matches the "Uncommitted right now" block), `git diff --check` clean;
  `node --check` OK on all 7 changed/relevant JS files; focused **221/221** (electronSmoke
  48, appWiring 43, setupFlowDom 62, headTracking 38, noControlPath 15, ipcSurface 15); full
  suite `npm test` **658/658 (37 files)**, 0 skips; the REAL `npm run smoke:electron`
  **4/4 PASS** (normal exit 0, corrupt-settings exit 0, forced-failure exit 1 naming
  `ipc-roundtrip`, timeout tree-killed at ~25 s), with a post-run sweep confirming zero
  orphan Electron children and zero `w17-smoke-*` temp dirs; `.github/workflows/ci.yml`
  validated with js-yaml 4.3.0 (parses, no duplicate keys). **Audit-only repairs** (no
  production/behavior change): added the missing **Batch D3 status** section (referenced but
  absent); reconciled the stale forward-looking sections that still framed D3 as the
  not-started next step (the "Exact D3 starting point (NOT started)" design dump, the "Next
  batch" item 5, and the "Recommended first actions" block that still cited HEAD `79fa2e0` /
  the 5-M D2 set / 610-610); corrected the batch-scope "NOT started" lines in the D1/D4 + D2
  status sections. **One code-doc fix:** `test/electronSmoke.test.js` — a test title said
  "all five required scenarios" while the suite defines and asserts FOUR
  (`normal`/`corrupt-settings`/`forced-failure`/`timeout`); the word was corrected to
  "four" (assertion unchanged, still 48/48; still a single `??` entry). No D3 production or
  test-logic redesign was needed or made. Work stays UNCOMMITTED.
- 2026-07-14 — **D3 COMMITTED by the user as `297ca79`** ("test: add deterministic
  Electron boot smoke") — exactly the 3 M + 4 ?? D3 delta the checkpoint listed as
  uncommitted (`ci.yml`, this audit file, `package.json`, `scripts/electron-smoke.js`,
  `scripts/smokeMain.js`, `scripts/smokeShared.js`, `test/electronSmoke.test.js`). Now
  HEAD, pushed to `origin/main`, working tree clean at commit time.
- 2026-07-14 — **FIRST Windows CI run of `297ca79` FAILED — three POSIX-separator test
  expectations, production code correct.** Run `29361212326`: the ubuntu `test` job
  passed **658/658**; the windows-latest `package-smoke` job failed at its NEW `npm test`
  step (added by D3's own `ci.yml` change — before D3 that job only packaged and never ran
  vitest on Windows) with **3 failures, all in `test/appWiring.test.js` →
  `describe('mediamtxPaths — dev / packaged / override resolution (audit D3 smoke seam)')`**:
  the assertions hardcoded POSIX-`/` expected strings (`/repo/mediamtx/mediamtx`,
  `/res/mediamtx/mediamtx.exe`, `/tmp/none/mediamtx.exe`) while `mediamtxPaths`
  (`main/appWiring.js:121`) correctly builds host-native paths with `path.join` →
  backslashes on win32. **Production `mediamtxPaths` behavior was correct** (OS-native
  separators are right for locating/spawning `mediamtx.exe` on Windows); the defect was
  purely in the three test expectations, invisible until D3 first ran the suite on Windows.
  Because `npm test` failed, the `smoke:electron` step was skipped, so the boot smoke has
  still never run remotely.
- 2026-07-14 — **Follow-up test-only correction (PENDING commit/push).** The three
  `mediamtxPaths` assertions now construct their expected values with the same
  `join` from `node:path` the production code uses, so they match on POSIX and Windows
  alike (correct by construction). ONLY `test/appWiring.test.js` changed (3 insertions /
  3 deletions); `main/appWiring.js` untouched; no production path normalized to `/`.
  Local verification: `node --check` OK; focused `test/appWiring.test.js` **43/43**; full
  `npm test` **658/658 (37 files, 0 skips)**; real `npm run smoke:electron` **4/4 PASS**
  (normal exit 0, corrupt-settings exit 0, forced-failure exit 1 naming `ipc-roundtrip`,
  timeout tree-killed at ~25 s), zero orphan Electron processes and zero `w17-smoke-*` temp
  dirs; `git diff --check` clean; working tree = **1 M `test/appWiring.test.js`** (+ this
  audit update). **E1 remains GATED until the pushed rerun of the windows-latest job is
  green.** NOT committed.
- 2026-07-14 — **D3 Windows-CI test correction COMMITTED by the user as `8ceb931`**
  ("test: make mediamtx path assertions cross-platform") — now HEAD, pushed to
  `origin/main`. **Windows CI is GREEN:** run `29361964757` (push of `8ceb931`) succeeded
  end-to-end — the windows-latest `package-smoke` job ran `npm ci` → `ensure-electron` →
  `npm test` (now passing on Windows) → **`npm run smoke:electron` (the boot smoke's FIRST
  remote execution — PASS)** → the electron-builder `--dir` package step. The D3 gate is
  fully closed: the last unexercised piece (the windows-latest CI job itself, incl. the real
  boot smoke on Windows) has now run green. **E1 is UNGATED.** (The earlier checkpoint text
  that frames D3 CI as red/pending is superseded by this entry.)
- 2026-07-14 — **Batch E1 complete (code) — hotspot credential at-rest encryption
  (L6 / decision Q6).** The one persisted secret (the hotspot password) is now encrypted
  via Electron **safeStorage** (OS keystore: Windows DPAPI / macOS Keychain / Linux
  libsecret) and **never written to disk as plaintext**. New `main/credentialStore.js`
  (versioned `w17cred:v1:` token wrapper around an injected safeStorage; main-process only,
  never exposed through preload; `available`/`protect`/`reveal`, reveal fails SAFE with a
  stable non-secret `kind`, never throws, never logs the value). `main/settingsStore.js`
  rewritten to own serialization + at-rest encryption: on disk the hotspot lives ONLY as
  `network.hotspot.passwordEnc` (ciphertext) with the plaintext `password` field blanked
  (and blanked in `.bak` too); in memory / over IPC the LOGICAL object still carries the
  decrypted `password` for the PIT WALL pre-fill; legacy plaintext is migrated on first load
  (encrypt when possible, else quarantine off disk, kept in memory for the session);
  undecryptable/foreign/corrupt tokens degrade to a controlled "re-enter" with every
  unrelated setting intact and no crash; migration write failure returns a controlled
  `migration-failed` status without destroying the recoverable value; the credential value
  and ciphertext are NEVER logged. `main/main.js` injects `createCredentialStore({ safeStorage })`.
  `main/appWiring.js` `settings:get` gains a non-secret `credential` status
  (`{ state, encryptionAvailable, hasPassword }`) — never ciphertext or the value.
  `renderer/index.html` + `renderer/setupFlow.js` add a truthful `#hsCredNote`
  (session-only / re-enter / migration-failed messages; never the value).
  `scripts/smokeMain.js` gains E1 assertions (no `passwordEnc`/`w17cred:` token in the
  settings:get answer; non-secret credential status present; fresh profile `hasPassword:false`).
  New `test/credentialStore.test.js` (**10**, DI fake safeStorage), `test/settings.test.js`
  +14 E1 store cases (19→**33**), `test/setupFlowDom.test.js` +4 (66), `test/appWiring.test.js`
  settings:get extended (credential shape/no-secret), `test/ipcSurface.test.js` +1
  (preload exposes no safeStorage/crypto primitive, 15→**16**). Focused credential/settings/
  DOM/guard **124/124**; wifi/hotspot + D2/D3 regressions **361/361**; full suite `npm test`
  **686/686 (38 files, 0 skips)**; real `npm run smoke:electron` **4/4 PASS**; a scratchpad
  real-Electron acceptance harness confirmed on live macOS Keychain: save→no plaintext on
  disk + versioned token, restart→recovered, clear→token removed, unavailable→session-only
  (lost on restart, no plaintext), corrupt ciphertext→no crash + unrelated settings intact
  (never printed a decrypted secret). `git diff --check` clean. Real **Windows DPAPI**
  behavior REQUIRES HARDWARE (bench). NOT committed. See the Batch E1 status section below.

---

## Current transfer checkpoint

**Purpose: a self-contained handoff for a fresh model with NO conversation history or
session memory. Describes the ACTUAL working tree after Batches A1–D3 (all COMMITTED) plus
**Batch E1** (hotspot credential at-rest encryption — code complete, UNCOMMITTED). D1/D4,
D2 (`0564141`), and D3 (`297ca79`) landed; the D3 Windows-CI test correction landed as
`8ceb931` (now HEAD) and **Windows CI is GREEN** (run `29361964757` — `npm test` + the boot
smoke both ran green on windows-latest, closing the last D3 gate). Authoritative
cross-account handoff (session memory is a convenience copy). **Next up after E1 review is
Batch F (doc sync); G remains untouched.** E1 stays uncommitted for user review — do not
commit or push; do not start F or G.**

### Repository state

- Repo: `w17-ground-station` (nested git repo under `.../Documents/projects/`).
- Branch: `main`. **HEAD commit: `8ceb931`** ("test: make mediamtx path assertions
  cross-platform", **committed by the user**, pushed) — the test-only correction that made
  Windows CI green. Parents: `297ca79` ("test: add deterministic Electron boot smoke", D3)
  ← `0564141` ("test: harden main-process integration wiring", D2) ← `79fa2e0` ("a lot of
  chagnes", the user's 62-file A1→D1/D4 + partial-D2 + contract-mirror commit) ← `cf038c2`
  (the commit this audit originally examined; every finding above still references that
  baseline).
- **Windows CI is GREEN at HEAD** (`8ceb931`, run `29361964757`): the windows-latest
  `package-smoke` job ran `npm ci` → `ensure-electron` → `npm test` → `npm run smoke:electron`
  (the boot smoke's first remote execution, PASS) → the `electron-builder --dir` package step.
  The ubuntu `test` job is green too. D3 is fully closed.
- **Uncommitted right now — Batch E1 (10 M + 2 ??):**
  ```
   M main/appWiring.js          (settings:get returns non-secret `credential` status)
   M main/main.js               (inject createCredentialStore({ safeStorage }))
   M main/settingsStore.js      (serialize + at-rest encryption + migration + status)
   M renderer/index.html        (#hsCredNote)
   M renderer/setupFlow.js      (capture credential; render #hsCredNote; refreshCredential)
   M scripts/smokeMain.js       (E1 no-ciphertext + credential-status assertions)
   M test/appWiring.test.js     (settings:get credential shape / no-secret)
   M test/ipcSurface.test.js    (preload exposes no safeStorage/crypto primitive)
   M test/settings.test.js      (+14 E1 store encryption/migration/session-only/corrupt)
   M test/setupFlowDom.test.js  (+4 transient join key + credential-note states)
  ?? main/credentialStore.js    (versioned safeStorage token wrapper, main-only)
  ?? test/credentialStore.test.js (10, DI fake safeStorage)
  ```
  (plus this audit-doc update, `M docs/audits/2026-07-12-pre-hardware-hardening-audit.md`.)
  Verified locally: focused credential/settings/DOM/guard 124/124, wifi/hotspot + D2/D3
  regressions 361/361, full `npm test` **686/686 (38 files, 0 skips)**, real
  `npm run smoke:electron` **4/4 PASS**, real-Electron E1 acceptance PASS on live macOS
  Keychain, no orphans/temp dirs, `git diff --check` clean. NOT committed.
- HISTORICAL — the Batch D3 delta (now inside `297ca79`):
  ```
   M .github/workflows/ci.yml   (package-smoke job: ensure-electron + npm test + smoke + artifact-on-failure)
   M docs/audits/2026-07-12-pre-hardware-hardening-audit.md
   M package.json               (+ "smoke:electron" script)
  ?? scripts/electron-smoke.js  (smoke controller)
  ?? scripts/smokeMain.js       (Electron-side smoke wrapper)
  ?? scripts/smokeShared.js     (pure protocol shared by both + tests)
  ?? test/electronSmoke.test.js (48 controller/protocol/safety tests)
  ```
- HISTORICAL — the D2 completion set (now inside `0564141`):
  ```
   M docs/audits/2026-07-12-pre-hardware-hardening-audit.md
   M main/appWiring.js        (createKeyedInstance seam)
   M main/main.js             (applyW3 -> keyed holder; w3Active/teardown via it)
   M test/appWiring.test.js   (+4 keyed-instance tests -> 43)
   M test/ipcSurface.test.js  (static pins comment-stripped + count pins)
  ```
- HISTORICAL — the uncommitted set that became `79fa2e0` (A1 + A2 + A3 + B1/B2 + B3/B4 +
  **Batch C** + **Batch D1/D4** combined — **53 entries, 22 M / 31 ??**; the 4 extra
  doc entries from the contract-mirror session joined at commit time). Batch D added ONE
  new untracked file
  (`test/commandGeneration.test.js`) and re-edited three already-tracked files in place
  (`main/runCommand.js`, `main/wifiManager.js`, `test/noControlPath.test.js`), so only the
  one `??` entry is new versus the Batch C checkpoint:
  ```
   M main/hostProbe.js
   M main/hotspot.js
   M main/main.js
   M main/preload.cjs
   M main/runCommand.js
   M main/wifiManager.js
   M main/wifiSim.js
   M package-lock.json
   M package.json
   M renderer/hud.css
   M renderer/hud.js
   M renderer/index.html
   M renderer/setupFlow.js
   M renderer/whep.js
   M shared/wifiParse.js
   M shared/wifiView.mjs
   M test/hotspot.test.js
   M test/noControlPath.test.js
   M test/wifiManager.test.js
   M test/wifiParse.test.js
   M test/wifiSim.test.js
   M test/wifiView.test.js
  ?? docs/audits/
  ?? main/hotspotLifecycle.js
  ?? main/quitPolicy.js
  ?? scripts/hotspot-diag.js
  ?? shared/envLocks.mjs
  ?? shared/keyboardFocus.mjs
  ?? shared/reachability.mjs
  ?? shared/videoState.mjs
  ?? test/commandGeneration.test.js
  ?? test/fixtures/netsh_hosted_start_failed_de.txt
  ?? test/fixtures/netsh_hosted_start_failed_en.txt
  ?? test/fixtures/netsh_interfaces_dongle_connecting_en.txt
  ?? test/fixtures/netsh_interfaces_two_both_en.txt
  ?? test/fixtures/netsh_interfaces_two_both_reversed_en.txt
  ?? test/fixtures/netsh_interfaces_two_de.txt
  ?? test/fixtures/netsh_networks_open_de.txt
  ?? test/fixtures/netsh_networks_security_en.txt
  ?? test/fixtures/ping_win_reachable_de.txt
  ?? test/fixtures/ping_win_reachable_en.txt
  ?? test/fixtures/ping_win_timeout_en.txt
  ?? test/fixtures/ping_win_unreachable_de.txt
  ?? test/fixtures/ping_win_unreachable_en.txt
  ?? test/hostProbe.test.js
  ?? test/hotspotLifecycle.test.js
  ?? test/keyboardFocus.test.js
  ?? test/quitPolicy.test.js
  ?? test/reachability.test.js
  ?? test/runCommand.test.js
  ?? test/setupFlowDom.test.js
  ?? test/videoState.test.js
  ?? test/whep.test.js
  ```
  (`git status` grew from the B3/B4 checkpoint's 47 by exactly 5, all Batch C: 1
  newly-modified (`renderer/whep.js`) + 4 new untracked (`shared/videoState.mjs`,
  `shared/envLocks.mjs`, `test/videoState.test.js`, `test/whep.test.js`). Batch C also
  further edited already-tracked files — `renderer/hud.js`, `renderer/setupFlow.js`,
  `renderer/index.html`, `renderer/hud.css`, `main/main.js`, `test/setupFlowDom.test.js`,
  `test/noControlPath.test.js` — none of which are NEW `git status` entries.)
  (`git status` grew from the B1/B2 checkpoint's 36 by exactly 11: 1 newly-modified
  (`main/hostProbe.js`) + 10 new untracked (`shared/reachability.mjs`,
  `test/hostProbe.test.js`, `test/reachability.test.js`, `netsh_networks_security_en.txt`,
  `netsh_networks_open_de.txt`, and 5 `ping_win_*` fixtures). B3/B4 also further edited
  already-tracked files: `shared/wifiParse.js`, `shared/wifiView.mjs`, `main/wifiManager.js`,
  `main/wifiSim.js`, `renderer/setupFlow.js`, `renderer/index.html`, `renderer/hud.css`, and
  their tests.)
- B3 files: `shared/wifiParse.js` (2nd touch — `encryption` capture + `classifyWifiSecurity`
  + `buildOpenWlanProfileXml`), `shared/wifiView.mjs` (3rd touch — `joinPlan`/`networkBadge`
  + Q3 strings), `main/wifiManager.js` (2nd touch — security-scoped `join`), `main/wifiSim.js`
  (4th touch — expanded `NETWORKS_TEXT`), `renderer/setupFlow.js` (4th touch —
  `selectNetwork`/`doJoin` + `#netSecNote`), `renderer/index.html` (3rd touch — `#netSecNote`),
  `renderer/hud.css` (4th touch — `.hint.warn` + `#netPassword.hidden`),
  `test/wifiParse.test.js`, `test/wifiManager.test.js`, `test/wifiView.test.js`,
  `test/wifiSim.test.js`, `test/setupFlowDom.test.js` (4th touch), new fixtures
  `netsh_networks_security_en.txt`, `netsh_networks_open_de.txt`.
- B4 files: **new** `shared/reachability.mjs`, `test/hostProbe.test.js`,
  `test/reachability.test.js`, 5 `ping_win_*` fixtures; **modified** `main/hostProbe.js`
  (`classifyPing` + status shape), `renderer/setupFlow.js` (5th touch — CHECK wording +
  `#addrNote`), `renderer/index.html` (4th touch — `#addrNote`),
  `test/noControlPath.test.js` (guard-list +1: `shared/reachability.mjs`),
  `test/setupFlowDom.test.js` (also carries the B3/B4 UI cases).
- A1 files: `main/hotspot.js`, `main/runCommand.js`, `main/wifiSim.js`,
  `test/hotspot.test.js`, `scripts/hotspot-diag.js`, `test/runCommand.test.js`.
- A2 files: `shared/keyboardFocus.mjs`, `renderer/hud.js`, `renderer/setupFlow.js`,
  `renderer/index.html`, `renderer/hud.css`, `test/keyboardFocus.test.js`,
  `test/setupFlowDom.test.js`, `test/noControlPath.test.js` (guard-list add only),
  `package.json` + `package-lock.json` (jsdom devDependency).
- A3 files: `shared/wifiParse.js`, `main/wifiManager.js`, `main/wifiSim.js` (2nd touch),
  `shared/wifiView.mjs`, `renderer/setupFlow.js` (2nd touch), `renderer/hud.css`
  (2nd touch, select:focus one-liner), `test/wifiParse.test.js`,
  `test/wifiManager.test.js`, `test/wifiView.test.js`, `test/wifiSim.test.js`,
  `test/setupFlowDom.test.js` (2nd touch), 4 new `test/fixtures/netsh_interfaces_*` files.
- B1/B2/N3 files: **new** `main/hotspotLifecycle.js`, `main/quitPolicy.js`,
  `test/hotspotLifecycle.test.js`, `test/quitPolicy.test.js`,
  `test/fixtures/netsh_hosted_start_failed_en.txt`,
  `test/fixtures/netsh_hosted_start_failed_de.txt`; **modified** `main/main.js` (IPC +
  lifecycle wiring + quit policy + capabilities no longer probes), `main/preload.cjs`
  (`hotspotState`/`hotspotProbe`/`onHotspotState`), `main/hotspot.js` (3rd touch — B2
  locale-neutral classification + `PS_ELEV` + `backend` tag), `main/wifiSim.js` (3rd
  touch — `ELEV_ADMIN` route), `shared/wifiView.mjs` (2nd touch — `hotspotPaneState`),
  `renderer/setupFlow.js` (3rd touch — hotspot pane + `adoptHotspotSnap` seq gate),
  `renderer/index.html` (2nd touch — STOP/hint/RECHECK), `renderer/hud.css` (3rd touch —
  disabled styling + `.hsbtns` + `.netstatus.live`), `test/hotspot.test.js` (2nd touch),
  `test/wifiView.test.js` (3rd touch), `test/setupFlowDom.test.js` (3rd touch),
  `test/wifiSim.test.js` (2nd touch), `test/noControlPath.test.js` (2nd touch —
  guard-list +2).
- **Session work stays UNCOMMITTED by user instruction** (the user folded everything up
  to partial-D2 into `79fa2e0` themselves; new work sits on top, uncommitted, until they
  review). Do not commit or push. `docs/windows_bridge_contract.md` §1–§7 must never be
  edited by a ground-station session (the 2026-07-14 change to it was a canonical→mirror
  sync performed in its own docs session, recorded in that file's sync block).
- D1/D4 files: **modified** `test/noControlPath.test.js` (2nd touch — sweep rewrite),
  `main/wifiManager.js` (3rd touch — mkdtemp temp dir), `main/runCommand.js` (2nd touch —
  `winTreeKillArgs` export); **new** `test/commandGeneration.test.js`.

### Batch D3 status: COMPLETE + COMMITTED (`297ca79`) — Windows CI GREEN after the `8ceb931` test-only correction (boot smoke ran remotely, PASS)

Scope was exactly **D3** (V2 closure: a REAL Electron boot smoke + a Windows CI step). It
closes the last V2 gap the D2 unit layer could not — the actual Electron binding: live
preload execution in a sandboxed renderer, runtime enforcement of the window flags, a real
`ipcMain`/`invoke` round trip, and "unknown channels unavailable" in a LIVE page. No
control-path, CRSF-encoder, pan/tilt, or W3-wiring change; W3/5602 stays log-only; the
directory sweep + the smoke's own bans keep the smoke tooling inert; contract §1–§7
untouched. **The D3 delta (3 M + 4 ??) was COMMITTED by the user as `297ca79` on top of
`0564141`.** Its first Windows CI run (`29361212326`) failed at the `npm test` step on
three POSIX-separator expectations in the `mediamtxPaths` tests (a test-only defect
exposed the first time the suite ran on Windows — `main/appWiring.js` was correct; see the
2026-07-14 change-log entries). A test-only correction to `test/appWiring.test.js` is
applied and PENDING commit/push; **E1 is GATED until the rerun of the windows-latest job is
green.**

**Architecture — a two-process smoke with a pure protocol between them.**

| File | Role |
|---|---|
| `scripts/smokeShared.js` (new, pure) | The protocol both halves share: `W17_SMOKE` token format + a bounded incremental line parser (256 KB pending-line cap), the 8-stage `REQUIRED_STAGES` order, the 20-method `EXPECTED_API` pin, the loopback-WHEP console-error allowlist, the secret-redacting log sanitizer, and `evaluateSmokeRun` (the verdict). No Electron, no child_process, no fs — so the unit suite pins it without booting anything. Nothing under `main/`+`shared/`+`renderer/` imports it. |
| `scripts/smokeMain.js` (new, Electron side) | Spawned as `electron scripts/smokeMain.js`. Points `userData` at the controller's throwaway dir, `require`s the REAL, UNMODIFIED `main/main.js` (once — pinned), then proves 8 boot stages through PUBLIC Electron APIs only (`executeJavaScript`, `getLastWebPreferences`, `getAllWindows`), emitting a `W17_SMOKE` token per stage and exactly one `result`. Adds no IPC/preload/window/webPreferences surface; the only preload methods it calls from the page are read-only (`getConfig`/`getSettings`/`onTelemetry`). |
| `scripts/electron-smoke.js` (new, controller) | Plain-Node supervisor. Scrubs the env (ALL inherited `W17_*` deleted + the two Electron leaks + `NODE_OPTIONS`), then sets only its own deterministic vars (`W17_WIFI_SIM=two-adapters`, `W17_MEDIAMTX_DIR`→empty dir, `W17_SMOKE_USERDATA`). Runs the 4-scenario suite, enforces a hard per-scenario deadline with a process-**tree** kill (reusing `winTreeKillArgs`, N4), requires a grace-bounded clean exit after the result token, captures a capped+sanitized log, removes the temp root (Windows lock-retry), and verifies the pid is dead. Exits non-zero on any scenario deviation. |
| `test/electronSmoke.test.js` (new, 48) | Pins the controller protocol against FAKE node children (no Electron) + the safety posture. |
| `package.json` | `+ "smoke:electron": "node scripts/electron-smoke.js"`. |
| `.github/workflows/ci.yml` | `package-smoke` windows-latest job extended (below). |

**Protocol + readiness contract.** Stage tokens ride stdout as single `W17_SMOKE {json}`
lines; the parser buffers partial lines across chunk boundaries, treats a prefixed-but-
unparseable line as a loud PROTOCOL error (never a silent drop), and bounds the pending
line. A run PASSES only with (a) every one of the 8 `REQUIRED_STAGES` present,
(b) exactly one `result` with `ok:true` (a second `result` fails as a duplicate), and
(c) a clean exit 0 — a lucky exit code can never pass a truncated/wedged child. Stages, in
boot order: `electron-ready` → `window-created` → `window-loaded` → `preload-api` →
`security` → `ipc-roundtrip` → `renderer-ready` → `console-clean`.

**Real preload/IPC proof (observed live, this session).** `preload-api`:
`Object.keys(window.groundStation).sort()` equals the pinned 20-method surface exactly,
every member is a function, and `require`/`process`/`Buffer`/`ipcRenderer` are all
`undefined` in the page world (contextIsolation holds). The observed `apiKeys:20` proves
the REAL preload executed — that surface exists only if it did. `ipc-roundtrip`: a live
`getConfig()`/`getSettings()` round trip answers with fresh-profile values (a real WHEP
URL, `platform===process.platform`, `setupCompleted:false`, `w3Active:false`,
`telemetrySource:'none'`, `fpvMode:'solo'`), no env overrides in the scrubbed env, an empty
hotspot password, and NO non-empty `"password"` anywhere in the settings answer.

**BrowserWindow security results (runtime, this session).** `getLastWebPreferences()`
reports `contextIsolation:true`, `nodeIntegration:false`, `sandbox:true`,
`webSecurity:true`, `webviewTag:false`; the page URL is the local `renderer/index.html`
`file://`; the CSP meta carries `default-src 'self'`; `window.open('…')` returns `null`
and creates no second window; renderer-initiated navigation is blocked (URL unchanged) and
main logs the `[window] blocked navigation` marker. (Electron 31's `getLastWebPreferences()`
omits the preload PATH, so the path stays statically pinned by `test/appWiring.test.js`
over `createWindowOptions`; preload EXECUTION is proven by the exact-surface stage.)

**Four scenario outcomes (real Electron, this session — all PASS).**

| scenario | contract | observed |
|---|---|---|
| `normal` | fresh profile, Wi-Fi sim, mediamtx absent (soft-fail), full readiness, exit 0 | `ok:true`, all 8 stages, exit 0, `[mediamtx] binary not found` logged; temp removed, pid gone |
| `corrupt-settings` | pre-seeded malformed `settings.json` → store falls back, logs it, still reaches readiness | `ok:true`, exit 0, `[settings] unreadable …settings.json` logged; temp removed, pid gone |
| `forced-failure` | `W17_SMOKE_FAIL_STAGE=ipc-roundtrip` → fail loudly, name the stage, non-zero | `ok:false`, `failedStage:"ipc-roundtrip"`, exit 1 — correctly recognized as a PASS of the negative contract; temp removed, pid gone |
| `timeout` | `W17_SMOKE_HANG=1` → wedged after window-load; hard deadline kills the tree | no result, `timedOut`, killed at ~25 s, exit null; temp removed, pid gone |

Indicative timings (environment-dependent, run-to-run variance): normal ready ~0.97–1.2 s,
corrupt ~0.36–0.5 s, forced-failure ~0.4 s, timeout tree-killed at the 25 s deadline. Suite
verdict **PASS (4 scenarios)**; a post-run sweep found **zero** leftover Electron children
and **zero** `w17-smoke-*` temp dirs.

**Controller timeout + process-tree cleanup.** The hard timer and the post-result grace
timer are both cleared on settle. On timeout (or a post-result wedge) `killTree` reaps the
whole tree: win32 → `taskkill /pid <pid> /t /f` (the N4 argv, reused not re-invented, with
a `child.kill` fallback on taskkill spawn error); POSIX → the child is spawned `detached`
so a negative-pid `SIGKILL` reaps its group. `waitPidDead` then confirms ESRCH; a still-
alive pid is a scenario failure. Temp roots are removed with a Windows lock-retry loop and
a not-removed dir is a scenario failure.

**Secret / log handling.** The smoke's own env carries no secrets (fresh profile, scrubbed
`W17_*`), but the HOST shell may (CI signing/tokens). Captured logs are bounded (512 KB,
tail-kept with a marker) and sanitized: `secretValuesFromEnv` collects values of
credential-named vars (`PASS`/`SECRET`/`TOKEN`/`CREDENTIAL`/`*_KEY`/`CSC_*`, ≥4 chars),
longest-first, and `sanitizeLog` replaces every occurrence with `[REDACTED]`. `PWD`/`OLDPWD`
are exempt (paths, not credentials — else the log gutted). A live end-to-end redaction test
proves a secret riding a child's stdout is scrubbed.

**Windows CI changes.** The existing `package-smoke` windows-latest job (job
`timeout-minutes: 30`) now runs, in order: `npm ci` → `node scripts/ensure-electron.js`
(Electron binary repair; no-op when fine) → `npm test` (the suite on the deployment target)
→ `npm run smoke:electron` (`timeout-minutes: 10`, `W17_SMOKE_LOG_DIR=smoke-logs`) →
`actions/upload-artifact@v4` (`if: failure()`, the sanitized logs) → the UNCHANGED existing
package steps `npm run app:rebuild` + `npx electron-builder --dir`. The real smoke runs
BEFORE packaging. Validated with js-yaml 4.3.0: parses, no duplicate job keys, two jobs
(`test`, `package-smoke`), no admin/interactive step. **Remote execution ran once on the
`297ca79` push (`29361212326`) and FAILED at `npm test` on the three `mediamtxPaths`
POSIX-separator expectations — a test-only defect, now corrected (pending commit/push).
Because `npm test` failed, the `smoke:electron` step was skipped, so the boot smoke itself
has still not run remotely; it will on the next push once the test correction is in.**

**Development-app smoke decision.** The smoke boots the REAL unmodified `main/main.js` (not
a packaged build) with a scrubbed env and Wi-Fi sim: it proves the app's runtime boot,
preload, IPC surface, and window security deterministically and fast, with no
camera/RT5370/iPhone/ELRS/admin/real-hotspot/external-network dependency. Packaging is
still proven by the existing `electron-builder --dir` step that runs after it, so the two
are complementary — boot correctness (smoke) then deliverability (package).

**Four objective defects found + fixed IN THE NEW D3 CODE during real-app runs** (no
PRODUCTION defect — the D2 security wiring held at runtime): (1) Electron's quit path exits
0 regardless of `process.exitCode` → the verdict code is forced via an `app.once('quit')`
hook (plus an unref'd fallback so a wedged quit still exits); (2) Electron 31's
`getLastWebPreferences()` omits the preload path → assert `webSecurity`/`webviewTag` at
runtime and prove preload execution via the exact-API stage instead; (3) `PWD`/`OLDPWD`
false-positived the secret redactor → exempted; (4) an unbounded parser pending-line →
256 KB cap.

**Remaining hardware-only / remote work (not closed by D3):** everything is now the §5
bench inventory (real netsh/WinRT/ping/localized-Windows, camera→mediamtx→WHEP, crsf-serial
telemetry, iPhone W2/Local-Network + W3 log-only runbook); the windows-latest CI job has now
run green (D3 fully closed). Sim/dev-preview is never bench evidence.

**Exact F starting point (E1 is DONE; do NOT start F until the user resumes).** **E1** is
complete (see the Batch E1 status section below) and uncommitted. **F** — L5 + doc sync:
`../CURRENT_STATUS.md` pointer (records `3c16954`/217; HEAD is `8ceb931`/686 — the
checkpoint-hash + test-count drift the user has been deferring), `docs/setup_flow_bench_checklist.md`
prereqs (missing `npm run setup` mediamtx fetch + the `mediamtx.yml` camera-source edit),
`docs/iphone_bridge_readiness.md` §4 stale-timeout note (400 ms/re-arm → contract's 300 ms/no
re-arm), and an E1 note in `README.md`/`docs/SETUP.md` (credential is DPAPI-encrypted at rest;
session-only when secure storage is unavailable). **`docs/windows_bridge_contract.md` §1–§7
stays untouched.** **G** — proposals only. G remains untouched.

### Batch E1 status: COMPLETE (code) — hotspot credential at-rest encryption; real Windows DPAPI bench-pending

Scope was exactly **E1** (L6 / decision Q6): encrypt the one persisted secret — the hotspot
password — at rest, migrate legacy plaintext, fall back to session-only when OS encryption is
unavailable, recover gracefully from undecryptable ciphertext, and never leak the credential
through logs/errors/diagnostics/snapshots/IPC metadata/tests/smoke logs. No control-path,
CRSF-encoder, pan/tilt, camera, or W3-wiring change; W3/5602 stays log-only (the no-control
directory sweep auto-includes the new `main/credentialStore.js` and stays green); contract
§1–§7 untouched. The product network workflow is unchanged.

**Architecture.** `main/credentialStore.js` (new, main-process only, NEVER exposed through
preload) wraps an injected Electron `safeStorage`:

| Member | Behavior |
|---|---|
| `available()` | `safeStorage.isEncryptionAvailable()`, guarded (throws → false). |
| `protect(plaintext)` | `w17cred:v1:` + base64(`encryptString`). Requires `available()`; a throw surfaces (without the plaintext) so the caller falls back to session-only. The app invents/persists NO key — safeStorage owns the OS-account key (DPAPI / Keychain / libsecret). |
| `reveal(token)` | `{ ok, value }` or `{ ok:false, kind }` where kind ∈ `bad-format` (not our token / unknown version) \| `unavailable` \| `decrypt-failed` (foreign account / moved settings / corrupt). NEVER throws; NEVER returns or logs the secret. |

`main/settingsStore.js` owns serialization + at-rest encryption (injectable `credentialStore`
and `fs`; default `nullCredentialStore` = never-available, so tests/omitted injection never
write plaintext). `main/main.js` injects `createCredentialStore({ safeStorage })` (constructed
after `app.whenReady`, so Linux's ready-gated backend is valid).

**Persisted format.** On disk the hotspot is `{ ssid, password:"", passwordEnc:"w17cred:v1:<base64>" }`
— the plaintext `password` field is ALWAYS blanked on disk (and in `.bak`), and the versioned
ciphertext token is present only when a credential is persisted. In memory / over IPC the
LOGICAL settings object carries the DECRYPTED `network.hotspot.password` (the PIT WALL
pre-fill needs it — the smallest exposure that preserves the existing UX); `passwordEnc`
NEVER leaves the store (`normalizeSettings` drops it, and the store overlays only the
decrypted plaintext). The renderer-visible residual is therefore the decrypted plaintext
inside `settings.network.hotspot` (unchanged from pre-E1), never ciphertext.

**Migration ordering (crash-safe).** `load()` detects a non-empty legacy plaintext `password`
and, once, rewrites the file: encrypt→`passwordEnc` when available, else quarantine (strip
plaintext, keep the value in memory for the session). The write is `tmp`→(sanitized-`.bak`)→
`rename`, where the backup copy blanks any legacy plaintext BEFORE it can land in `.bak`. A
crash before `rename` leaves the legacy plaintext only in the original file (re-migrated next
boot) — no plaintext is ever ADDED anywhere. Migration is best-effort: a write failure returns
`migration-failed`, keeps the value in memory, never throws, never logs the value. An
undecryptable-`passwordEnc`-only record has no legacy plaintext, so `load()` does NOT rewrite
it (read-only) — the recoverable record is not destroyed prematurely; it is replaced only when
the user saves a new password.

**safeStorage-unavailable policy.** No plaintext is ever written. A password set while
encryption is unavailable is held in memory for the session (`state:'session-only'`), never
persisted, and is gone on restart (a fresh instance reports `state:'unavailable'`). If
encryption becomes available on a later launch, the previously session-only value did not
persist; a re-entered password is then encrypted.

**Corrupt / undecryptable behavior.** Foreign-account / moved-settings / corrupt / bad-format
/ unknown-version tokens → `state:'undecryptable'`, password blanked (ciphertext is never
shown as a password), unrelated settings fully intact, no crash, a single stable non-secret
diagnostic (never spammy, never the value). The broken record can be cleared or replaced.

**Renderer-visible status model.** `settings:get` adds `credential: { state, encryptionAvailable,
hasPassword }` — `state ∈ none | persisted | session-only | unavailable | undecryptable |
migration-failed`. It carries NEITHER the value NOR ciphertext/safeStorage detail. The
renderer shows a truthful `#hsCredNote` (session-only "kept for this session only", undecryptable
"enter it again", migration-failed "will be re-secured") and never the value. Preload exposes
no safeStorage primitive and no credential channel (the 20-method surface is unchanged; the
status rides `settings:get`). The transient **Wi-Fi join** password is unchanged: it rides
`wifi:join` only and is never persisted.

**Never-log guarantee.** credentialStore never logs the value or ciphertext (diagnostics carry
a `kind` only); the store's migration/corruption logs carry no value; the renderer's N1 IPC
guard already withholds detail on credential-carrying channels; the D3 smoke's log sanitizer
already redacts `W17_HOTSPOT_PASS`-class env values. Redaction was NOT broadened into a
sanitizer that would hide non-secret diagnostics (unnecessary — no path logs the credential).

**Tests + acceptance evidence.** `test/credentialStore.test.js` (**10**, DI fake safeStorage,
tricky secrets: spaces/quotes/&/<>/unicode/path-like/token-resembling — round-trip + safe-fail
+ never-log). `test/settings.test.js` +14 (encrypt+persist, decrypt-after-restart, no plaintext
on disk incl. `.bak`, versioned format, clear, replace, legacy migration, migration write
failure, unavailable→session-only, becomes-available-later, undecryptable, corrupt record,
unrelated-settings-intact, env-credential-never-persisted). `test/appWiring.test.js` (settings:get
credential shape / no ciphertext / no value). `test/ipcSurface.test.js` +1 (preload exposes no
safeStorage/crypto primitive). `test/setupFlowDom.test.js` +4 (transient join key not persisted;
session-only / undecryptable / persisted note states). Focused **124/124**; wifi/hotspot + D2/D3
regressions **361/361**; full suite `npm test` **686/686 (38 files, 0 skips)**; real
`npm run smoke:electron` **4/4 PASS** (fresh profile: no ciphertext in the answer, credential
status present, `hasPassword:false`). A scratchpad real-Electron acceptance harness (never
committed; prints only non-secret booleans/states) confirmed on **live macOS Keychain**:
save→no plaintext on disk + `w17cred:v1:` token + status `persisted`; restart→recovered;
clear→token removed + status `none`; unavailable→no plaintext + no token + status `session-only`
+ held-this-session + lost-on-restart; corrupt ciphertext→no crash + password blank + status
`undecryptable` + `fpvMode`/`iphoneAddr` intact.

**Remaining Windows-only verification (after this pass).** Real **Windows DPAPI** behavior on
the bench: encrypt/decrypt round-trip in the packaged app under the actual user account; a
credential saved on one Windows account is `undecryptable` (re-enter) on another account /
machine; `settings.json` on disk shows `passwordEnc` (a DPAPI blob) and an empty `password`;
Windows firewall/UAC do not interfere. Sim/dev-preview and macOS Keychain evidence are NOT
Windows-DPAPI evidence.

### Batch D2 status: COMPLETE (code) — real-Electron boot proof landed in D3 (above)

Scope was exactly **D2** (V2/N1: main-process + setup-flow integration coverage). D3 was
out of scope for D2 (the composition-root refactor was deliberately stopped for review
first) and has since been completed — see the Batch D3 status section above. No
control-path, CRSF-encoder, pan/tilt, or W3-wiring change; W3/5602 stays log-only (the
directory sweep + the pinned symmetry tests keep proving it); contract §1–§7 untouched by
this session.

**Composition-root refactor.** `main/main.js` (222 lines) is still the composition root
— Electron imports, window creation, quit-policy install, app lifecycle events, and the
ONLY W3 receiver construction site — but every wiring seam now lives in
**`main/appWiring.js`** (~310 lines) behind injected dependencies, so the integration
layer unit-tests without booting Electron. `appWiring` holds NO production singletons
(everything is factory-constructed by main.js), never names head-tracking (guard-swept),
and registers the IPC surface in exactly one place.

| Seam (`main/appWiring.js`) | What it pins | Tests |
|---|---|---|
| `PUSH_CHANNELS` | the two main→renderer push names; preload subscription equality | ipcSurface |
| `createNetworkServices({env,log})` | `W17_WIFI_SIM` routing (sim managers as win32 vs real), ONE `HotspotLifecycle` authority | appWiring 2 |
| `telemetrySourceFor(cfg,{platform,log})` | replay/crsf-serial/none → instance; COM5 / /dev/ttyUSB0 defaults | appWiring 4 |
| `createSessionApplier({settingsStore,runtime,env,applyW3,warn})` | settings+env → `resolveEffective` → `runtime.applyConfig` → injected `applyW3`; retains `lastEffective` for config/settings answers | appWiring 13 |
| `createKeyedInstance({construct,keyOf})` | W3 receiver restart choreography: idempotent re-apply, stop-before-replace, stop-on-null; CONSTRUCTION stays in main.js | appWiring 4 |
| `mediamtxPaths({env,platform,isPackaged,resourcesPath,projectRoot})` | dev/packaged split + **`W17_MEDIAMTX_DIR`** override (built as the deterministic missing-binary seam for the D3 smoke) | appWiring 3 |
| `registerIpcHandlers({ipcMain,services})` | the whole renderer-facing surface, single-sited + duplicate-throwing; returns channel lists for the symmetry test | appWiring 8 + ipcSurface |
| `wireHotspotPush({lifecycle,broadcast})` | every lifecycle snapshot → `hotspot-state`, seq preserved, unsubscribe works | appWiring 2 |
| `createWindowOptions({preloadPath,iconPath})` | contextIsolation ON / nodeIntegration OFF / sandbox ON / preload path — pinned | appWiring 2 |
| `installNavigationPolicy(webContents,{log})` | `window.open` denied; renderer-initiated navigation prevented (one local page) | appWiring 2 |
| `createTeardown({steps,log})` | idempotent, per-step failure-isolated shutdown; hotspot deliberately NOT a step | appWiring 4 |
| `w3ConfigFor(effective,env)` (in `main/headTrackingConfig.js`, allowlisted) | env master force-off vs persisted wish vs sub-key overrides | headTracking +5 |

**Final wiring map (all symmetric — pinned by `test/ipcSurface.test.js`).** 18 invoke
channels + 1 fire-and-forget send + 2 push channels; 20 preload methods; every method has
exactly one registered handler/event source AND at least one renderer consumer; the only
`ipcMain` registration site is `registerIpcHandlers`; main.js sends only through
`PUSH_CHANNELS`. Static pins run against comment-stripped code so a channel name in a
comment can neither satisfy a contains-pin nor trip a bans-pin.

| Area | Main wiring | IPC | Preload | Renderer consumer |
|---|---|---|---|---|
| Config snapshot | services → `config:get` (whepUrl, effective source, setupCompleted, envOverridden, w3Active, feel) | `config:get` | `getConfig` | `hud.js init()` |
| Settings read | store.load + effective 3-field display block | `settings:get` | `getSettings` | `setupFlow boot()`, `hud init()` |
| Settings write | store.save(patch) | `settings:set` | `setSettings` | `setupFlow save()` |
| Session apply | `sessionApplier.apply()` (→ runtime + applyW3) | `session:apply` | `applySession` | `enterGrid`, ⚙ handlers |
| Wi-Fi capability/adapters/scan/join/status | `wifi.*` (+sim flag) | `wifi:*` (5) | `wifiCapabilities/Interfaces/Scan/Join/Status` | PIT WALL |
| Hotspot start/stop/state/probe | `hotspotLifecycle.*` (THE authority) | `wifi:hotspot-*` (4) | `hotspotStart/Stop/State/Probe` | HOTSPOT pane |
| Hotspot push | `wireHotspotPush` → broadcast to all windows | push `hotspot-state` | `onHotspotState` | `adoptHotspotSnap` seq gate |
| Addr hint / reachability | `addrHint.get` / `hostProbe.probe` | `setup:addr-hint`, `setup:probe-host` | `getAddrHint`, `probeHost` | addr row, GRID checks |
| ELRS | `elrs.detectRunning/launchDetached` (path re-read from store per call) | `elrs:status`, `elrs:launch` | `elrsStatus`, `elrsLaunch` | GRID checklist |
| Telemetry push | `runtime.setSnapshotSink` → window | push `telemetry` | `onTelemetry` | `hud.js` |
| Command mirror | `ipcMain.on` → `runtime.onCommandMirror` (one-way, display-only) | send `command-mirror` | `sendCommandMirror` | `hud sendCommandMirror` |
| Quit policy / shutdown | same `hotspotLifecycle` instance; `createTeardown` (no hotspot step) | — | — | — |

**Objective defects found + fixed (4)** — see the 2026-07-14 change-log entry for detail:
the `enterGrid` and `enterPitwall` orphaned-interval races (stale continuations after
navigation could leak a forever-polling 1 s/2 s interval; fixed with entry-epoch guards +
deterministic fake-timer tests), the non-failure-isolated `will-quit` teardown (one
throwing stop orphaned the rest; fixed via `createTeardown`), and the missing
window-open/navigation policy (now deny-all; the app is a single local page).

**Coverage highlights (what D2 now proves without Electron):** clean/corrupted settings
boot; env override + explicit `0` force-off + partial locks; replay/live source
selection; desktop-never-starts-W2 / iphone+target-starts-W2 / missing-target-does-not;
repeated apply idempotent; target change rekeys with exactly one live sender; W3
persisted-wish vs env-master vs sub-key overrides; W3 receiver restart idempotence;
secrets absent from effective/env metadata (the persisted hotspot password reaches the
renderer ONLY inside `settings.network.hotspot` — the documented E1 residual); hotspot
IPC delegates 1:1 with defaulted opts; snapshots push with rising seq and no credential;
shutdown idempotent + failure-isolated + never the hotspot; renderer config-rejection
resilience; module-lifetime subscription singletons; exactly-one-interval accounting
across PIT WALL leave/re-entry and GRID leave-during-apply.

**Remaining D2 limitations (all deliberate, D3 territory):** `registerIpcHandlers` is
proven against a strict FAKE ipcMain — the real Electron binding, actual preload
execution in a sandboxed renderer, runtime enforcement of the window flags, and
"unknown channels unavailable" in a LIVE renderer need the D3 boot smoke. `applyW3` in
main.js is now a one-line composition of two tested halves (`w3ConfigFor` +
`createKeyedInstance`) but the line itself runs only in Electron. `createWindow`'s
snapshot-sink-per-window behavior and the `activate` re-create path are likewise
smoke-only. jsdom still proves wiring, not Chromium rendering.

### Batch D1 + D4 status: COMPLETE (code) — real-Windows command behavior bench-pending

Scope was exactly **D1 and D4**. D2 and D3 were out of scope for this batch (both have
since been completed — see the Batch D2 and Batch D3 status sections above); E, F, G remain
untouched. No control-path, CRSF-encoder, pan/tilt, or W3-wiring change; W3/5602 stays
log-only; contract §1–§7 untouched.

**D1 — no-control-path guard is now a directory sweep (finding V1).** The two enumerated
lists in `test/noControlPath.test.js` (`runtimeFiles`, `setupFlowFiles`) are DELETED. The
guard now discovers files by walking `main/`+`shared/`+`renderer/` and scans every runtime
module found, so a NEW module cannot bypass the bans by not being on a list. All prior
SEMANTIC assertions are preserved verbatim (crsf no-encoder, bridge send-only/no-serial,
snapshot pure, HT-modules inert, receiver-feeds-nothing, elrs launch-only, W3 addr-seam
IP-only, main.js constructed-not-read). 10→**15** tests.

- **Discovery** (`discover(absDir, baseDir)`): recursive `readdirSync(..,{withFileTypes})`;
  **symlinks are NOT traversed** — a symlink is recorded as `unknown` (surfaced, never
  followed), closing an uncontrolled-traversal / scan-attacker-content hole. `*.test.*`/
  `*.spec.*` are skipped (not runtime). Extensions are classified: `RUNTIME_EXT`
  = `.js/.mjs/.cjs` (scanned); `ASSET_EXT` = `.css/.html/.map/.json/.png/.svg/.ico/.icns/
  .txt/.md/.yml/.yaml` (present, not scanned); anything else → `unknown` and the guard FAILS
  until it is intentionally classified (a novel `.ts`/generated bundle cannot slip through).
- **Per-file scan** (`scanRuntimeFile`) with three rule classes + narrow, documented
  exceptions; failures name the exact file AND matched rule:
  - `ALWAYS_FORBIDDEN` (control-OUTPUT primitives, **no exception, all files**):
    `CrsfFrameBuilder`, `buildRcChannels`, `encodeRcChannels`, `RcChannels`, `setPosition`,
    `setThrottle`, `ledc`. Grep-verified to appear in **zero** runtime files today.
  - `SERIAL_TOKENS` (`serialport`/`SerialPort`) banned everywhere EXCEPT `SERIAL_ALLOWED` =
    `{main/CrsfSerialSource.js, shared/crsfTelemetry.js}` — the read-only CRSF telemetry
    backchannel (telemetry IN, never control OUT; the ALWAYS_FORBIDDEN sweep still covers
    them). `crsfTelemetry.js` only names it in a `pure (no serialport)` comment.
  - `HEADTRACK_RE` (`/headTracking|HeadTracking/` — camelCase identifiers, so harmless UI
    prose like `HEAD-TRACK LOGGING` never trips) banned everywhere EXCEPT `HEADTRACK_ALLOWED`
    = `{main/main.js, main/HeadTrackingReceiver.js, main/headTrackingConfig.js,
    shared/headTracking.js}` — the single wiring site + the receiver's own modules. **This
    is the core V1 fix**: a new consumer that imports/mentions head-tracking is auto-caught.
- **Module-graph vs. text-scan:** a full AST/import-graph pass was considered and judged
  unnecessary here — any import must textually name the distinctive module identifier, the
  renderer is sandboxed and reaches main only through the enumerated preload IPC channels,
  and the head-tracking-identifier ban already catches the first step of any control path.
  The `main.js` data-flow assertions (`no getDiagnostics`, no `headTracking.(on|emit|pipe)`)
  are kept as the targeted complement.
- **Auto-discovery proof (2 tests):** (a) a hermetic temp dir with a planted
  `sneakyControl.js` (imports the receiver AND exports `encodeRcChannels`) is discovered and
  flagged on BOTH counts, while a `.css` is an asset, a `*.test.js` is skipped, a `.ts` is
  `unknown`, and a `.js` **symlink** is `unknown`/not-scanned; (b) the real sweep is asserted
  to include the recently-added `shared/videoState.mjs`, `shared/envLocks.mjs`,
  `shared/reachability.mjs`, `shared/keyboardFocus.mjs`, `main/hotspotLifecycle.js`,
  `main/quitPolicy.js` — none on any list — proving new REAL files are picked up with no edit.
- **Exceptions are narrow and documented** (the two SERIAL_ALLOWED, the four
  HEADTRACK_ALLOWED); a test pins that a serial-exempt file is exempt ONLY for serial, never
  for a control-output primitive, and that a non-`main.js` module is never head-track-exempt.

**D4 — command-generation and invocation hardening.** Full inventory (every `runCommand`/
`spawn`/`spawnSync`/`execFile` consumer):

| Command path | Executable | Arguments / input | User-controlled data | Tests |
|---|---|---|---|---|
| Wi-Fi scan | `netsh` | `wlan show networks mode=bssid [interface=<iface>]` + `wlan show profiles` | `iface` (argv element) | wifiManager, commandGeneration |
| Adapter list | `netsh` | `wlan show interfaces` | none | wifiManager |
| Wi-Fi status | `netsh` | `wlan show interfaces` | none (`iface` selected in parsed text) | wifiManager |
| Add profile | `netsh` | `wlan add profile filename=<tmp> [interface=<iface>]` | SSID+key ride the temp **XML file** (XML-escaped), `iface` argv | wifiManager, commandGeneration |
| Wi-Fi connect | `netsh` | `wlan connect name=<ssid> [interface=<iface>]` | `ssid`,`iface` argv elements | wifiManager, commandGeneration |
| Hosted set/start/stop | `netsh` | `wlan set hostednetwork mode=allow ssid=<s> key=<pw>` / `start` / `stop hostednetwork` | `ssid`,`key` argv (netsh has no env channel — see residual) | hotspot |
| Mobile hotspot | `powershell` | fixed WinRT script (`-Command`) | SSID/pass ride **process ENV** (`$env:…`), never interpolated | hotspot (static + shape) |
| Elevation fact | `powershell` | fixed `PS_ELEV` script | none | hotspot |
| Reachability | `ping` | `-n/-c 1 -w/-W <t> <addr>` | `addr` — **IPv4-validated before spawn** | hostProbe |
| ELRS detect | `tasklist`/`pgrep` | `IMAGENAME eq <image>` / `-f <image>` | `image` = basename of configured path | elrsLauncher |
| ELRS launch | `<elrsPath>` | `[]`, detached, `stdio:'ignore'`, unref | `elrsPath` = executable (shell:false) | elrsLauncher, noControlPath |
| Timeout tree-kill | `taskkill` | `/pid <pid> /t /f` (`winTreeKillArgs`) | pid (own child) | runCommand, commandGeneration |
| mediamtx | bundled binary | `[configPath]` | none (fixed paths) | — (fixed) |
| fetch-mediamtx / ensure-electron | `tar`/`unzip` | fixed archive paths | none (pinned version, build-time) | — (build tooling, out of runtime threat surface) |

**Safety properties — verified:** executable+argv separation everywhere (`shell:false`
always — statically asserted no source sets `shell:true`); metacharacters inert (a behavioral
`runCommand` test proves `; && $() \`\` < > "` and spaces pass as single literal argv
elements); interface names and SSIDs with spaces stay one argv element; non-ASCII SSIDs +
passphrases round-trip verbatim through the utf8 temp file and into the connect argv;
XML-special SSID/password are escaped in the profile (`&<>"'` → entities) and pass raw-but-safe
in argv; open profile carries no key material; the passphrase never enters argv, the returned
error, logs, or a leftover file; out-of-scope SSID/security is rejected before any spawn (zero
processes, zero temp files); IPv4 is validated before ping spawns (injection-proof); missing
executable and wrapper-timeout keep stable `{ok:false, code:null,…}` shapes; `winTreeKillArgs`
emits `/t /f` (tree, force); localized output is never the basis of a security branch (B2/B4).

**Objective defects found + fixed (2):**
1. **Insecure temporary file (CWE-377), `main/wifiManager.js`.** The key-bearing WLAN profile
   was written to a **predictable** `w17-wlan-<Date.now()>.xml` in the shared tmpdir — a
   symlink/pre-creation race on the passphrase-carrying file and a same-millisecond collision
   under concurrent joins. **Fix:** a PRIVATE per-join `mkdtemp` directory (`w17-wlan-XXXX/`,
   0700, unpredictable) holds `profile.xml` (mode 0600); the WHOLE directory is removed in a
   `finally` after success AND failure. Cleanup-on-add-fail and cleanup-on-connect-fail are now
   explicitly tested; existing tests (which read the filename from argv) still pass.
2. **Untested tree-kill argv, `main/runCommand.js` (N4).** The `taskkill /t /f` args were
   inline and unverifiable without a real hung process. **Fix:** extracted to an exported pure
   `winTreeKillArgs(pid)`; behavior identical, now regression-tested.
   No `shell:true`, single-command-string, user-data-interpolation, credential-in-argv-log,
   missing-cleanup, or raw-error-to-UI defect was found in any other path.

**Accepted residuals (NOT defects; product/OS constraints — no change made):**
- Hosted-network `key=<pw>` rides netsh **argv** (visible briefly to a local `tasklist`/`wmic`).
  netsh `wlan set hostednetwork` has no env/stdin channel for the key, so there is no safer
  channel; the modern **mobile** backend (preferred) uses ENV and is the norm. Bench-only.
- The reachability probe stays ICMP by design (B4): no defensible TCP port for the UDP-5601 W2
  path; the phone screen is the final evidence.

**Tests added / changed:** `test/noControlPath.test.js` 10→**15** (sweep + discovery + narrow-
exception proofs; all semantic assertions preserved); new `test/commandGeneration.test.js`
**17** (shell:false invariant + metacharacter-inert behavioral; `winTreeKillArgs` + timeout/
missing-binary shapes; XML escaping incl. non-ASCII + all 5 metachars for WPA2 and open
profiles; wifiManager join with non-ASCII SSID, XML-special SSID, spaced SSID/adapter,
private-temp-dir + cleanup on success/add-fail/connect-fail, passphrase redaction, and
pre-spawn rejection of out-of-scope inputs). Existing command tests (wifiManager 36, hotspot
31, hostProbe 16, runCommand 4, elrsLauncher 6, wifiParse 39) already cover their per-module
D4 slices and stay green.

**Exact results (2026-07-13).** Syntax OK on all changed JS. Focused D1 **15/15**; focused D4
command surfaces (commandGeneration+wifiManager+runCommand+hotspot+hostProbe+elrsLauncher+
wifiParse) **149/149**; network/reachability + Batch C regressions (lifecycle/quit/reachability/
videoState/whep/setupFlowDom/wifiView/wifiSim) **175/175**; `noControlPath` **15/15**; full
suite `npm test` **542/542 (34 files)** (was 520/33 — +17 commandGeneration, +5 noControlPath);
`git diff --check` clean.

**Remaining real-Windows (bench) verification for D1/D4:** none for D1 (pure static guard,
platform-independent). For D4: on the Windows bench confirm `netsh wlan connect`/`add profile`
accept an SSID with spaces/quotes/`&`/non-ASCII as a single argv element (the fix relies on
argv-array quoting, believed correct, still bench-unverified — audit §1 context note); confirm
`taskkill /t /f` actually reaps a hung PowerShell tree (N4); confirm the mkdtemp profile path
is accepted by netsh `filename=`. Sim/dev-preview is never bench evidence.

**~~Exact D2 + D3 starting point~~ — D2 AND D3 are now BOTH DONE (2026-07-14).** See the
Batch D2 status section and the Batch D3 status section above for the file-by-file detail
and results. The originally-scoped D3 design direction — `scripts/smokeMain.js` (Electron
wrapper booting the real unmodified `main/main.js`), `scripts/electron-smoke.js` (plain-Node
controller with a scrubbed env, a process-tree-kill hard timeout, and the corrupt-settings
pass), fake-child vitest coverage of the controller protocol, `npm run smoke:electron`, and
the extended windows-latest `package-smoke` CI job — was implemented as scoped, with the
`mediamtxPaths` `W17_MEDIAMTX_DIR` seam (built during D2) used exactly as intended to force
the missing-mediamtx soft-fail deterministically. The one refinement versus the original
sketch: the CI failure path uploads the sanitized logs as an `actions/upload-artifact@v4`
artifact (`if: failure()`) rather than only printing a tail inline. Nothing here touched
control, W3 log-only, or the contract.

### B3 status: COMPLETE (code) — real netsh open/WPA3/enterprise behavior bench-pending

**Normalized security model** (`shared/wifiParse.js` `classifyWifiSecurity({auth,encryption})`).
Derived structurally from the netsh Authentication + Encryption fields; the renderer and
manager branch on the kind, never on localized prose (raw `auth`/`encryption` kept only as
diagnostics). Kinds and derivation:

| kind | derived when | join behavior |
|---|---|---|
| `open` | auth matches a multi-locale open word (open/offen/ouvert/…) OR encryption is a none-word, and it is NOT WEP | OPEN NETWORK warning, no password; open profile installed if not saved |
| `wpa2-personal` | auth contains `wpa2` (no `wpa3`), not enterprise | WPA2-PSK: password required + WPA2 profile (unchanged) |
| `wpa2-wpa3-transition` | auth contains BOTH `wpa2` and `wpa3` | joinable **over WPA2** (password path, caution note) |
| `wpa3-only` | auth contains `wpa3` and NOT `wpa2` | **rejected** before any OS call (Q3 message) |
| `enterprise` | auth contains `enterprise`/`802.1x`/`eap` | **rejected** (clear unsupported message, no PSK prompt) |
| `unknown` | legacy WPA1, WEP, or anything unrecognized | **rejected** if NEW (`unsupported-unknown-security`, controlled message, NO WPA2 profile / NO speculative join); a network Windows already has a SAVED profile for joins via that profile (builds nothing) |

**Transition rule (documented):** a WPA2/WPA3 transition AP most commonly reports
Authentication `WPA2-Personal` (the mode Windows uses) → classified `wpa2-personal`
(joinable). A COMBINED token carrying both `WPA2` and `WPA3` → `wpa2-wpa3-transition`
(still joinable over WPA2). Only WPA3 **without** WPA2 is `wpa3-only` (rejected) — a
compatible WPA2 path is never called unsupported (Q3).

**Supported / unsupported matrix (implemented + tested):**

| network | offered? | join path |
|---|---|---|
| saved open | yes | connect via saved profile (no key, no profile install) |
| new open | yes | install open profile (`buildOpenWlanProfileXml`, no key) then connect; OPEN NETWORK/unencrypted warning |
| WPA2-PSK (new) | yes | password → WPA2 profile → connect (unchanged, adapter-pinned, temp file cleaned) |
| WPA2/WPA3 transition | yes | WPA2 password path + note |
| WPA3-only | **no** | `unsupported-wpa3` + "WPA3-only networks are not currently supported. Use a WPA2 network or start the W17 hotspot." |
| enterprise | **no** | `unsupported-enterprise` + clear unsupported message |
| hidden / empty / whitespace SSID | **no** | dropped from the scan; a join attempt → `unsupported-hidden-network` |
| unknown/unrecognized (NEW) | **no** | `unsupported-unknown-security` + "This network's security type could not be identified. Use a known WPA2 network or start the W17 hotspot." — NO password field, NO WPA2 profile, NO connect; sanitized raw auth/enc kept for a diagnostics tooltip only |
| unknown/unrecognized (SAVED profile) | yes | connect via the existing Windows profile (`known:true`), constructing nothing — the deliberate carve-out (tested both ways) |

**Profile generation.** `buildWlanProfileXml` (WPA2PSK/AES, key) and the new
`buildOpenWlanProfileXml` (authentication=open, encryption=none, NO `sharedKey`/`keyMaterial`).
Both XML-escape the SSID (and key) and are passed to netsh as argv `filename=<temp>`, never a
shell string; non-ASCII survives verbatim; temp file is deleted in a `finally` after success
AND failure. The passphrase rides the temp file only — never a netsh argument, log, error, or
snapshot (redaction asserted). `join()` guards run BEFORE any OS call, so an out-of-scope kind
never touches netsh (asserted zero-spawn).

### B4 status: COMPLETE (code) — real Windows ping behavior bench-pending

**Probe stays ICMP** (`main/hostProbe.js`); a TCP port was rejected — it would not test the
UDP-5601 W2 path the product cares about, and the phone screen is the final evidence.
`classifyPing(res, platform)` (pure, exported) classifies from stable structural signals:

- `reachable` ⇐ a `TTL=` echo reply (locale-neutral token) — the ONLY green.
- `unreachable` ⇐ a Windows **exit-0 reply without `TTL=`** (the audit-L4 "Destination host
  unreachable" false-green) OR a multi-locale unreachable phrase.
- `timeout` ⇐ no reply (a timeout phrase / 100%-loss marker), non-zero exit, no TTL.
- `invalid` ⇐ address fails IPv4 validation (no process spawned — injection-proof).
- `command-unavailable` ⇐ spawn failure (code null, not our timeout).
- `command-error` ⇐ our runCommand timeout (code null + `timeout after Nms`; A1/N4 tree-kill).
- `unknown` ⇐ ran, no structural signal — conservative red, never a confident green.

`probe()` returns `{ok, status, rttMs?|error}` (`.ok` backward-compatible; GRID + PIT WALL
callers updated). **Limitations:** ICMP proves the L3 path only; `unknown`/`timeout` differ
only by message (both red); phrase matching is best-effort corroboration on top of the
locale-neutral TTL/exit-code core. Real Windows ping output REQUIRES HARDWARE.

**Product truthfulness.** `shared/reachability.mjs` `PATH_ONLY_NOTE` is the exact decision-C4
wording; `probeStatusLine` keeps `reachable` at "network path only". A positive result never
claims UDP receipt, iOS permission, live W2 telemetry, or a working HUD (asserted). The PIT
WALL CHECK shows the honest per-status line and, on success only, the full path-only caveat.

### Batch C status: COMPLETE (code) — Electron dev-preview verified; real camera/network behavior bench-pending

Batch C hardens the *truthfulness* of runtime state + configuration UX. All four items done;
C4 was already realized in B4 and is re-validated below. Nothing here touches control, the W2
packet contract, or the W3 log-only path.

**C1 — video-state lifecycle (finding L3).** The old model was a single `videoPlaying` boolean:
true on the media `playing` event, cleared ONLY on `emptied`. A dying FPV stream fires
`waiting`/`stalled`, or the WebRTC peer connection silently goes `disconnected`/`failed` while
the `<video>` freezes on its last frame — none of which is `emptied` — so GRID VIDEO LOCK and W2
`video_lock` stayed confidently green between stream death and the WHEP reconnect.

- **`shared/videoState.mjs`** (pure, ESM, no DOM/IO): `reduceVideoState(state, event)` +
  `videoStatus(state)` + `videoLock(state)`. Phases: `idle`/`connecting`/`live`/`buffering`/
  `stalled`/`error`. `playing` is the ONLY confident-green (`live`) state; `waiting`→`buffering`,
  `stalled`/transport `dropped`→`stalled`, media `error`→`error`, `emptied`/`ended`/`stopped`→
  `idle`. Real frames (`playing`) override any prior stalled/buffering (ground truth); a stalled
  transport is not flapped back toward almost-live by a late `waiting`; a spurious `connecting`
  never overrides confirmed frames. Repeats return the SAME object (idempotent — no phantom
  re-render). Final view model:

  | phase | live (video_lock) | HUD label | tone | reconnecting |
  |---|---|---|---|---|
  | `idle` | **false** | NO VIDEO | idle (dim) | no |
  | `connecting` | **false** | CONNECTING | wait | yes |
  | `live` | **true** | VIDEO LIVE | live (overlay hidden) | no |
  | `buffering` | **false** | BUFFERING | wait | yes |
  | `stalled` | **false** | STREAM STALLED | warn (amber) | yes |
  | `error` | **false** | VIDEO ERROR | error (red) | no |

- **`renderer/whep.js`**: added an `onStatus` callback (`connecting` at each (re)connect attempt,
  `dropped` when an ESTABLISHED peer connection fails/disconnects/closes, `stopped` on teardown)
  and a **stale-pc identity guard** — each attempt captures `const thisPc`, and its
  `onconnectionstatechange` acts only while `thisPc === pc`. This both fixes a latent bug (the old
  handler read the mutable closure `pc`, so a stale callback read the *new* attempt's state) and
  is the honest answer to "stale events from an earlier reconnect attempt must not overwrite a
  newer state": in a single renderer, media events are single-source ordered and transport
  callbacks are pc-identity-guarded, so no cross-source reorder exists to defend against. A WebRTC
  drop (which fires no media event) is what clears the green immediately.
- **`renderer/hud.js`**: one `videoState` authority; media listeners
  (`playing`/`waiting`/`stalled`/`emptied`/`ended`/`error`) attached unconditionally + the whep
  `onStatus` feed both go through `applyVideoEvent`. `#feedNoteText` shows the label and the
  overlay hides only when `live` (a frozen frame is labelled STREAM STALLED, never hidden).
  `hudStatus().videoPlaying` and the W2 mirror's `videoPlaying` are BOTH `videoStatus(state).live`
  — so GRID, HUD, and W2 read one authority and a frozen/reconnecting stream reports
  `video_lock:false`. Intentional pause does not exist in this app, so `pause`/`suspend` are not
  wired (no false red).
- Tests: `test/videoState.test.js` (16), `test/whep.test.js` (5, incl. the stale-pc race guard),
  `test/setupFlowDom.test.js` C1 block (2: feed-note follows media events; GRID VIDEO LOCK green
  on frames then NOT green after a `stalled` with no `emptied` — no stale green).

**C2 — replay chip (D1, decision Q4).** A compact persistent `TELEMETRY · REPLAY` chip in the HUD
session panel (`#replayChip`), violet — visually distinct from the amber W3 chip and the teal live
indicators. Rules (all tested): shown ONLY when the EFFECTIVE telemetry source is `replay`
(`config:get.telemetrySource` at HUD boot + `setReplayChip(applied.telemetry === 'replay')` after
every `applySession`, so a runtime ⚙ switch or env override is reflected immediately); hidden for
live/none/crsf-serial; **Wi-Fi simulation alone does NOT trigger it** (separate subsystem — the
PIT WALL `SIMULATED WIFI` tag is independent); replay + SIMULATED WIFI can show together; replay +
the W3 log-only chip are independent (both can show at once); not dismissible (a plain `<div>`, no
interactive control); screenshot-visible. `npm run demo` (`W17_TELEMETRY_SOURCE=replay`) shows it
and also env-locks the source (see C3).

**C3 — env-locked settings (D3, decision Q8).** `shared/envLocks.mjs` (pure) maps each lockable ⚙
control to its variable + accessible wording. `settings:get` now returns an `effective` block so
the ⚙ shows the EFFECTIVE value, not the ignored persisted one. Matrix (implemented + tested):

  | ⚙ control | env var | envOverridden key | presentation when locked | editable when unlocked |
  |---|---|---|---|---|
  | Telemetry source (`<select>`) | `W17_TELEMETRY_SOURCE` | `telemetrySource` | **disabled**, shows effective source, amber ENV badge (focusable, names the var), `aria-describedby` | yes (unchanged) |
  | Telemetry port (`<input>`) | `W17_TELEMETRY_PORT` | `telemetryPort` | **readonly** (stays focusable + tooltip), shows effective port, ENV badge | yes |
  | Head-track logging (checkbox) | `W17_HEADTRACK` | `w3` | **disabled**, shows effective on/off, ENV badge | yes |
  | iPhone bridge (W2) | `W17_IPHONE_BRIDGE`(+ADDR/PORT/RATE) | `iphoneBridge` | no ⚙ control (driven by GARAGE mode + IP) — surfaced only via the GRID "LOCKED BY ENV VARS" radio line | n/a |

  A `<select>`/checkbox has no `readonly`, so it is `disabled` and the adjacent **focusable** ENV
  badge (`tabindex=0`, `role=note`, `title` + `aria-label`) carries the accessible name — Q8's
  "readonly + separate lock indicator where a disabled control blocks focus/tooltip". Force-off is
  honoured (e.g. `W17_HEADTRACK=0` → effective off, shown + locked). **Partial locks work**: only
  the overridden field is locked. **Locked edits are never persisted** — `telemetryChanged` builds
  a patch of only the UNLOCKED fields (so a locked source's displayed effective value is never
  written back), and the W3 change handler returns early when locked. No secret leakage: only the
  variable NAME is placed in a tooltip, never its value (asserted the port value is absent from the
  badge title); none of these variables carry a credential.

**C5 — W2 starts on GRID entry (D2, decision Q5) — documented, unchanged.** Re-validated the
implementation: `enterGrid()` (`renderer/setupFlow.js`) → `gs.applySession()` →
`main.js applySession()` → `runtime.applyConfig()` starts the W2 sender when
`effective.iphoneBridge` is set (iPhone Cockpit mode + a confirmed IPv4, OR `W17_IPHONE_BRIDGE`).
`applyConfig` is diff-aware/idempotent (keyed on `{...iphoneBridge, demo}`), so **repeated GRID
entry does not duplicate the sender**; a **changed target IP** changes the key → the old bridge is
stopped and a new one started. Leaving GRID does not tear W2 down (session-scoped; the quit path
and `will-quit` own teardown). **Desktop mode never starts W2** (`resolveEffective` sets
`iphoneBridge:null` unless `fpvMode==='iphone-hud'`). W2 forwards whatever telemetry source is
active (replay carries `mode:'demo'`; none → mirror-only). Errors: an `applySession` rejection
shows `SESSION APPLY FAILED`; W2 send failures are logged (send-only, fire-and-forget — the app
cannot know the phone received). No packet-shape or timing change. UI: a new `#gridNote` (iPhone
mode only) reads *"The iPhone HUD begins receiving telemetry on GRID so you can verify it before
START. Ping proves the network path only — live data visible on the iPhone is the final
evidence."* — Desktop mode shows no iPhone wording.

**C4 — reachability wording (V3) — re-validated, no change.** `PATH_ONLY_NOTE`
(`shared/reachability.mjs:13`) is byte-exact to the decision-C4 string; a reachable check reads
"REACHABLE … — network path only" + the full caveat; no status claims UDP receipt, iOS Local
Network permission, visible telemetry, or a working HUD (`test/reachability.test.js`,
`test/setupFlowDom.test.js` reachability block).

**Electron visual acceptance (real app, scratchpad harness, dev-preview only — NOT bench
evidence).** A hidden `BrowserWindow` loaded the REAL `renderer/index.html` + real CSS via an
injected mock preload (harness scratchpad-only, never committed), sampling `getComputedStyle`
(the reliable check for colour, per the tooling guidance) + screenshots. Confirmed: **C1** feed
note idle `NO VIDEO`→`VIDEO LIVE` (overlay hidden)→`BUFFERING`→`STREAM STALLED` (amber
`rgb(255,178,0)`)→`VIDEO ERROR` (red `rgb(255,45,45)`)→`NO VIDEO`→reconnect `VIDEO LIVE`; **C2**
replay chip visible violet `rgb(185,139,255)` with the W3 chip amber alongside (independent),
hidden for source `none`, and **hidden under Wi-Fi-sim-only on PIT WALL while `SIMULATED WIFI`
shows**; **C3** all-locked ⚙ → source disabled=`replay`, port readonly=`9999`, w3 disabled+checked,
amber ENV badges with var-naming tooltips; no-override ⚙ → all editable, badges hidden; **C5**
iPhone GRID shows the note, Desktop GRID hides it. No layout regression.

**Bench-pending (real hardware).** Real camera → mediamtx → WHEP so the video-state model runs
against genuine WebRTC drops/stalls (H1 A1 fix + H.264 check territory); real iPhone confirming W2
telemetry appears on GRID (C5) and that the reachability path-only caveat holds. Sim/dev-preview
is never bench evidence.

### B1 + B2 + N3 status: COMPLETE (code) — real WinRT/netsh/localized-Windows behavior bench-pending

**Lifecycle authority.** `main/hotspotLifecycle.js` is the ONE runtime authority (main
process). It wraps `HotspotManager` (which stays the OWNERSHIP truth — `manager.active()`
= the backend this app started, never an external hotspot) and layers the phase model
INACTIVE→STARTING→LIVE→STOPPING. Snapshots carry `{seq, phase, owned, backend, ssid,
hostIp, lastError, probe}`. The renderer MIRRORS snapshots (pull on PIT WALL entry +
`hotspot-state` pushes) and never infers state from the DOM; both paths pass through one
`adoptHotspotSnap` gate. Duplicate start/stop are suppressed at the authority
(`kind:'busy'`) and the DOM disables conflicting controls as a second layer, never the
enforcement point.

**Sequence/adoption contract (the race fix).** Electron does not guarantee push arrival
order. `_emit()` bumps a monotonic `_seq`; `snapshot()` reports it; the renderer holds the
highest adopted seq and drops any `snap.seq < heldSeq`. Equal seq re-renders idempotently;
a missing seq (legacy shape) is adopted last-writer-wins; the renderer never mints a seq;
the initial state is `seq:0` and any real change is `≥1`. This is proven at both the
authority level (strictly increasing seq across start→live→stop) and the renderer level
(9 race cases, push and pull, in `test/setupFlowDom.test.js`).

**Ownership matrix (implemented + tested):**

| Path | App owns hotspot? | Where enforced / tested |
|---|---|---|
| Mobile start success | **Yes** | `hotspot.js` sets `_activeBackend='mobile'`; lifecycle → LIVE. `hotspot.test.js`, `hotspotLifecycle.test.js` |
| Hosted start success | **Yes** | `_activeBackend='hosted'`; lifecycle → LIVE |
| Configuration failure before start | **No** | password/SSID gate returns `config-failed` with zero OS calls; lifecycle → INACTIVE + error |
| External hotspot already running (`START_ALREADY_ON`) | **No** | `fallback:false`, ownership never set; lifecycle → INACTIVE; probe `externallyActive:true` shown, never owned |
| Mobile config mismatch after partial start | **Yes** | `START_CONFIG_MISMATCH` keeps `_activeBackend`; lifecycle → LIVE + error, ssid withheld, STOP/retry offered |
| Mobile start status failure, no confirmed start | **No** | `start-failed`/`ps-error`, ownership unset; lifecycle → INACTIVE |
| Stop success | **No** | `_activeBackend` cleared AFTER success (N2); lifecycle → INACTIVE |
| Stop failure | **Yes** | ownership retained (N2); lifecycle → LIVE + `stop-failed`, STOP retry enabled |
| Leave running and quit | Hotspot remains active; process exits | quit policy LEAVE RUNNING → `quit()`, no stop call |
| Cancel quit | Unchanged | quit policy CANCEL → `stay`, state untouched |
| Failed stop during quit | **Yes**; app stays open | quit policy STOP AND QUIT → stop fails → `showError` + `stay` |

**Quit-policy matrix (`main/quitPolicy.js`, tested in `test/quitPolicy.test.js`):**

| Trigger | Behavior |
|---|---|
| INACTIVE hotspot | no `preventDefault`, no dialog — quit proceeds |
| Externally-active / not owned | no dialog — quit proceeds |
| App-owned LIVE | dialog shown once (STOP AND QUIT / LEAVE RUNNING / CANCEL) |
| STOP AND QUIT, stop OK | waits for stop success, then `quit()` |
| STOP AND QUIT, stop fails | `showError`, app stays open, hotspot still owned + LIVE, later quit re-asks |
| LEAVE RUNNING | `quit()` without stopping |
| CANCEL | no quit, state unchanged, later quit re-asks |
| Repeated quit while dialog open | absorbed — one dialog, one decision |
| Quit during STARTING | `whenSettled()` waits; settled-LIVE → ask, settled-failed → quit silently |
| Quit during STOPPING | `whenSettled()` waits; stop-OK → quit silently, stop-fail → ask |
| Policy-issued `quit()` re-enters before-quit | `allowQuit` latch → passes straight through, no recursion |
| Dialog backend throws | fail-open: `quit()` (never unquittable) |

**N3 probe.** `wifi:capabilities` no longer probes (instant platform+sim answer). The
WinRT probe is `wifi:hotspot-probe` through the lifecycle: cached, single-flight
(concurrent callers share one PowerShell run), `{refresh:true}` re-probe (the pane's
RECHECK), emits `probe:'probing'` immediately, and turns a rejection into a controlled
`{status:'failed'}`. The renderer renders PIT WALL before the probe resolves; a stale
probe completion after nav-away is dropped by the epoch guard AND the seq gate. States
distinguished: probing / supported / unsupported / failed / externally-active. Hotspot
capability is NOT conflated with WLAN adapter availability (netsh-fail sim: `READY —
hosted backend` while the adapter card shows `ADAPTER CHECK FAILED`).

**B2 locale-neutral errors.** The `/denied|elevat|administrator/` regex is gone. A hosted
start failure is `kind:'start-failed'`, `backend:'hosted'`, with the raw netsh detail
sanitized+retained; the administrator line is a `suggestion` gated on the locale-neutral
`PS_ELEV` token (`WindowsPrincipal.IsInRole` → `ELEV_ADMIN`/`ELEV_LIMITED`/`ELEV_ERROR`):
shown when not elevated OR unknown, suppressed when elevated — never asserted as the
definite cause. Mobile failures carry `backend:'mobile'`; a failed hosted fallback keeps
the superseded mobile failure as `fallbackFrom` (A1 fallback rules intact). EN and DE
hosted-failure fixtures classify identically. No credential reaches any error, log,
snapshot, or test (redaction asserted).

**Tests + results (2026-07-13).** Syntax OK on every changed JS/MJS file. Focused:
`hotspot` 31, `wifiSim` 14, `hotspotLifecycle` 26, `quitPolicy` 13, `wifiView` 25,
`setupFlowDom` 31, `noControlPath` 10 — all green. Full B1/B2 + A1–A3 regression set
(11 files) **214/214**. Full suite `npm test` **407/407** (29 files, was 331/27).
`git diff --check` clean. Electron sim acceptance (scratchpad harness, dev-preview only):
two-adapters full lifecycle + netsh-fail failure/RECHECK verified, sequence race
reproduced-then-fixed, LIVE/after-STOP/failure screenshots visually confirmed.

**Bench-pending (real Windows).** Real WinRT tethering start/stop tokens; real
`WindowsPrincipal.IsInRole` under an actual elevated vs limited process; real localized
netsh hostednetwork failure text; the Electron quit dialog on a real close; and that the
`hotspot-state` push ordering hazard behaves as modelled on the target machine (the seq
guard is defensive regardless). Sim is never bench evidence.

### A1 verification status: INDEPENDENTLY VERIFIED (cross-account session, 2026-07-12)

A fresh session re-read every A1 file skeptically and reproduced all checkpoint numbers
(syntax OK ×4; focused 48/48; full 280/280 pre-A2). No debris, duplicates, unreachable
branches, token collisions, unsafe fallbacks, ownership faults, or credential leaks
found; no changes made to A1 code. WinRT behavior remains bench-pending as documented.

### A1 implementation status: COMPLETE (code) — WinRT behavior bench-pending

What changed, file by file:

**`main/hotspot.js` (rewritten).** Replaced the three PowerShell scripts and the start/stop
control flow. Key points:
- New `PS_COMMON` prologue used by all three scripts: `$ErrorActionPreference = 'Stop'`;
  `Add-Type -AssemblyName System.Runtime.WindowsRuntime` (the AsTask extension methods are
  NOT loaded by default in a fresh `-NoProfile` PS 5.1 session — this was the primary H1
  bug); explicit type loads for the WinRT namespaces; `GetInternetConnectionProfile()` →
  `RESULT_NO_PROFILE` (exit 2) when there is no tetherable profile; whole prologue wrapped
  in try/catch → `RESULT_SETUP_ERROR` (exit 1).
- TWO awaiters: `Await` for `IAsyncOperation`1` (StartTethering/StopTethering results) and
  `AwaitAction` for `IAsyncAction` (ConfigureAccessPointAsync — the second H1 bug: it
  returns IAsyncAction, not IAsyncOperation, so the old single awaiter threw).
- `PS_START` ordering is fail-closed: if already `On` → `START_ALREADY_ON` (exit 5); configure
  in try/catch → on failure `START_CONFIG_FAILED` (exit 3) and **exits before**
  `StartTetheringAsync` is ever invoked (this is what prevented the old script from
  half-starting tethering with the OLD Windows SSID/password); start in try/catch →
  `START_ERROR` (exit 1) / `START_FAILED_<status>` (exit 4); then a **readback**:
  re-reads `GetCurrentAccessPointConfiguration().Ssid` and, if it ≠ requested,
  `START_CONFIG_MISMATCH` (exit 6); only then `START_OK`.
- `PS_STOP` → `STOP_OK` / `STOP_ERROR` / `STOP_FAILED_<status>`.
- Scripts are single-quote-only (no `"` chars) so spawn argv can't corrupt them; SSID/pass
  ride process ENV (`$env:W17_HOTSPOT_SSID` / `$env:W17_HOTSPOT_PASS`), never interpolated.
- `PS_SCRIPTS = {probe,start,stop}` is now exported (for static tests + the diag tool).
- `probeBackends()` now keys mobile on `PROBE_OK` (was `TETHER_OK`), and adds a
  diagnostic `mobileState` field (WinRT `TetheringOperationalState`: On/Off/InTransition/…).
- `start()` returns structured failures with `kind` and an internal `fallback` flag; see
  vocabulary + fallback rules below. Added `active()` → the backend WE started, or null
  (the B1 quit-dialog gate; ownership never covers externally-started hotspots).
- `stop()` (N2 fix): clears `_activeBackend` only AFTER success; a failed stop keeps
  ownership and returns `{ok:false, kind:'stop-failed', backend, error}`.
- `failDetail()` caps error text at 300 chars and never includes the password.

**`main/runCommand.js` (N4).** On the timeout path, win32 now runs
`taskkill /pid <pid> /t /f` (whole tree), with `.on('error')` fallback to `child.kill()`;
non-win32 still uses `child.kill()`. Result shape unchanged
(`{ok:false, code:null, stderr:'timeout after <ms>ms'}`).

**`main/wifiSim.js`.** PowerShell branch updated to the new tokens so
`W17_WIFI_SIM` previews still exercise the real manager: no-adapter/netsh-fail →
`{ok:false, code:2, stdout:'RESULT_NO_PROFILE'}`; start script → `START_OK`; stop script →
`STOP_OK`; otherwise (probe) → `PROBE_STATE_Off\nPROBE_OK`.

**`test/hotspot.test.js` (rewritten, 10→23 tests).** Router matches scripts by unique
markers (`StartTetheringAsync`, `StopTetheringAsync`, `PROBE_OK`). Covers: probe
mobile/hosted/neither + `mobileState`; start success + ENV-not-text + ownership;
`START_ALREADY_ON` (no ownership, no fallback); `START_CONFIG_MISMATCH` (ownership kept,
no fallback); config-failure→hosted fallback; config-failure w/o hosted surfaces mobile
failure; elevation; unsupported; password never echoed. Stop: no-op; success clears
ownership; **failed stop retains ownership**; STOP_OK gating. Plus a
`fail-closed PowerShell structure` block (static assertions over `PS_SCRIPTS`): Add-Type,
both awaiters, AwaitAction-on-Configure, exit-3-before-Start, START_OK-after-readback,
env-only + no-double-quotes.

**`test/runCommand.test.js` (new, 4 tests).** Real spawns of `process.execPath`: success
stdout; missing binary → ok:false (never throws); 200ms timeout over a 10s sleep →
ok:false + `timeout` reason (exercises the N4 path shape cross-platform); additive env.

**`scripts/hotspot-diag.js` (new).** Windows-only bench tool that runs the ACTUAL
`PS_SCRIPTS` via `runCommand` and prints raw stdout/stderr + interpretation.
`node scripts/hotspot-diag.js` = probe only (safe); `--start "SSID" "pw"` = configure+start
(no auto-stop; reminds operator to verify SSID on a phone then `--stop`); `--stop` = stop.
Never persists/prints the password.

### PowerShell token / result vocabulary (stdout)

`RESULT_NO_PROFILE` (exit 2, no tetherable profile) · `RESULT_SETUP_ERROR <msg>` (exit 1,
prologue threw) · `PROBE_STATE_<state>` + `PROBE_OK` (probe healthy) ·
`START_ALREADY_ON` (exit 5) · `START_CONFIG_FAILED <msg>` (exit 3) · `START_ERROR <msg>`
(exit 1) · `START_FAILED_<status> <msg>` (exit 4) · `START_CONFIG_MISMATCH` (exit 6) ·
`START_OK` · `STOP_ERROR <msg>` (exit 1) · `STOP_FAILED_<status>` (exit 4) · `STOP_OK`.

Manager `start()` result `kind` values: `config-failed`, `start-failed`, `already-on`,
`config-mismatch`, `no-profile`, `ps-error`, `needs-elevation`, `unsupported`; `stop()`
failure `kind`: `stop-failed`.

### Fallback rules (mobile → hosted)

`start()` probes, and if `mobile` is available tries `_start_mobile`. It falls back to
hostednetwork ONLY when the mobile result has `fallback !== false` AND `probe.hosted`.
`fallback:false` (never fall back) is set for `already-on` (someone else's hotspot — do
not stack a second network) and `config-mismatch` (we started it; needs an explicit STOP,
not a second backend). `config-failed`/`no-profile`/`start-failed`/`ps-error` have
`fallback:true`; with no hosted backend they surface the real mobile failure instead of a
misleading hosted error.

### Hotspot ownership rules

`_activeBackend` = the backend this app successfully started (`'mobile'`/`'hosted'`), else
null; exposed via `active()`. Set on `START_OK` (mobile) / hosted start success, and also
on `START_CONFIG_MISMATCH` (we did start tethering, just with the wrong SSID — keep it so
the UI can STOP it). NOT set on `already-on` (not ours). Cleared only after a successful
`stop()`. `stop()` is a no-op when `active()` is null → the app never stops a hotspot it
did not start (Q1/Q2 requirement).

### Tests: exact commands + results

- Syntax checks (all passed):
  `node -c main/hotspot.js && node -c main/wifiSim.js && node -c main/runCommand.js && node -c scripts/hotspot-diag.js` → "SYNTAX OK (all 4)".
- Focused:
  `npx vitest run test/hotspot.test.js test/wifiSim.test.js test/runCommand.test.js test/noControlPath.test.js`
  → **48/48 passed** (hotspot 23, wifiSim 11, runCommand 4, noControlPath 10).
- Full suite: `npm test` (→ `vitest run`) → **280/280 passed, 25 files** (was 263/24;
  +13 hotspot, +4 runCommand). No failures, no skips.
- Extra validation: dumped the generated `PS_SCRIPTS.start` and confirmed Add-Type,
  literal `IAsyncOperation`1`, AwaitAction-on-Configure, exit-3-before-Start,
  START_OK-after-mismatch, and zero double-quote chars.

### Remaining Windows-only verification for A1 (bench)

Real WinRT behavior is NOT proven by the mocked tests. On the Windows bench host run
`scripts/hotspot-diag.js` and checklist §3: (1) probe reports `PROBE_OK` +
`PROBE_STATE_Off`; (2) `--start "W17-GRID" "<8+char>"` prints `START_OK` and the SSID is
actually visible/joinable on a phone (this is the exact H1 regression to confirm); (3)
`--stop` prints `STOP_OK`; (4) with no tetherable profile → `RESULT_NO_PROFILE` then the
app falls back to hostednetwork; (5) non-elevated hostednetwork → elevation message.
Confirm the taskkill tree-kill (N4) actually reaps a hung PowerShell on Windows.

### Unresolved risks / uncertainties

- The `AwaitAction` reflection assumes the non-generic `AsTask(IAsyncAction)` overload
  exists and is found by the `Where-Object` filter (`-not $_.IsGenericMethod` +
  `ParameterType.Name -eq 'IAsyncAction'`). High-confidence per docs; bench-confirm.
- `START_CONFIG_MISMATCH` assumes `GetCurrentAccessPointConfiguration()` reflects the
  applied SSID synchronously after start; if Windows lags, a real success could read as a
  mismatch. Bench-observe; acceptable (fails safe toward "press STOP and retry").
- `probeBackends()` still awaits the 20s-timeout WinRT probe before PIT WALL renders
  (N3) — unchanged in A1, deferred to B1.

### Approved product decisions (Q1–Q8, C4) — full text in §4

- Q1 quit policy: **ask on quit, only when the app owns an active hotspot** (STOP HOTSPOT
  AND QUIT / LEAVE HOTSPOT RUNNING / CANCEL); never for externally-started hotspots.
- Q2 STOP button: INACTIVE→STARTING→LIVE→STOPPING + actionable ERROR; STOP beside START;
  disable conflicting actions during transitions; no duplicate requests; failed stop keeps
  LIVE + retains ownership + allows retry; never stop external hotspots; N2 fixed.
- Q3 Wi-Fi scope: support saved AND new **open** networks (OPEN NETWORK warning, no pw
  field); **reject WPA3-only** ("WPA3-only networks are not currently supported. Use a WPA2
  network or start the W17 hotspot."); skip malformed/empty SSIDs; hidden networks →
  clear unsupported message (not raw netsh error); add escaping tests.
- Q4 replay marking: compact persistent `TELEMETRY · REPLAY` chip in the HUD session panel
  while replay is active; not dismissible; screenshot-visible; keep SIMULATED WIFI
  separate; no watermark.
- Q5 W2 timing: keep GRID-entry start, document it (preflight evidence; ping proves path
  only; live phone data is the real evidence; START begins the driving session); no new
  packet type.
- Q6 credentials: safeStorage/DPAPI encryption; transparent plaintext→encrypted migration;
  ciphertext incl. `.bak`; **no persistent-plaintext fallback** — when OS encryption
  unavailable keep in memory for the session only + warn; undecryptable secret (foreign
  account/machine) → no crash, clear/ignore, re-request, preserve other settings; never
  log/expose credentials; redaction tests.
- Q7 adapter UX: always show an ADAPTER section in PIT WALL (Win: 0/1/2/saved-missing
  states, styled card + obvious dropdown; guide mode: section with "available in the
  Windows application" + W17_WIFI_SIM hint, never present host interfaces as adapters; sim:
  deterministic 0/1/2 scenarios). Verify the actual launch path first; show revised design
  before a substantial visual redesign — objective visibility/error fixes may proceed.
- Q8 env-lock: disabled control + amber ENV tag + effective value + tooltip naming the var
  + explanation; keep readable/accessible (readonly + adjacent lock indicator where a
  disabled native control blocks focus/tooltip).
- C4 wording: "Ping succeeded. This proves the network path only. Confirm live data on the
  iPhone; check iOS Local Network permission if it does not appear." (longer text →
  checklist/tooltip).

### A2 implementation status: COMPLETE (M1 + N1)

What changed, file by file:

**`shared/keyboardFocus.mjs` (new).** Pure ESM focus policy, no DOM dependency at
import: `isEditableTarget` (input/select/textarea + contenteditable incl. attribute
variants and nesting via `closest`), `isInteractiveTarget` (editable + button/a/summary
native activation), `makeHudKeyHandlers(keys)` (keydown: editable target → record
nothing, prevent nothing; else record; claim arrows/space with preventDefault except
space on an interactive target — space is a button's activation key; keyup: ALWAYS
clears so a key released inside a field never sticks down), `makeEnterToAdvance`
(Enter advances only from a non-interactive focus and only when `canAdvance()`),
`makeEnterToSubmit` (field-level Enter → preventDefault + submit). Listed in the
noControlPath `setupFlowFiles` guard.

**`renderer/hud.js`.** The window `keydown`/`keyup` handlers are now
`makeHudKeyHandlers(keys)` — typing in any field is no longer recorded into the HUD
mirror nor preventDefault-ed; keyboard driving still works from body/button focus.
`init()` (N1): `getConfig` and `getSettings` guarded separately — config failure falls
back to built-in feel constants and skips WHEP; settings failure keeps the default
controller; both log `console.error`, HUD keeps running.

**`renderer/setupFlow.js`.** Enter-nav is `makeEnterToAdvance` (same gate/nav
visibility conditions as before); `netPassword` gets `makeEnterToSubmit(doJoin)` —
Enter in the Wi-Fi password field JOINS and never navigates. N1: new narrow `ipc()`
guard (one IPC call per use; logs the real error once per channel; returns a FIXED
credential-free fallback). Wrapped: `wifi:capabilities` (fail → guide mode + radio
notice, not silent), `wifi:interfaces` (fail → wifiView 'failed' row, RESCAN retries),
`wifi:scan` (fail → 'SCAN FAILED — scan did not complete — RESCAN to retry'),
`wifi:join` + `wifi:hotspot-start` (fixed messages, `detail:false` withholds raw error
from the log since args carry credentials; JOIN/START retryable), `wifi:status`
(distinct 'WIFI CHECK FAILED' vs 'not detected'), `setup:addr-hint` (background poll →
no suggestion), `setup:probe-host` (both call sites), `elrs:status` (fail → red row,
never skipped/green), `elrs:launch`, `session:apply` (GRID entry → visible 'SESSION
APPLY FAILED' summary + radio + honest checklist; ⚙ handlers → 'APPLY FAILED — …
retry' status). `save()` catches `settings:set`, keeps in-memory settings, warns
'SETTINGS SAVE FAILED — CHANGES MAY NOT PERSIST' on team radio (fixed text; the patch
can carry the hotspot password). `boot()` failure shows `#bootError` + RETRY (re-runs
boot) instead of a blank gate.

**`renderer/index.html` + `renderer/hud.css`.** New `#bootError` block (SETUP DATA
UNAVAILABLE + `#bootRetry`) inside the gate, `.booterror` styles.

**`package.json` / `package-lock.json`.** `jsdom` devDependency (the D2 DOM-harness
prerequisite, pulled forward with user-instruction backing; vitest per-file
`@vitest-environment jsdom` pragma — node stays the default env).

**`test/keyboardFocus.test.js` (new, 16 tests, jsdom).** Predicates (all tags,
contenteditable variants incl. `"false"` and nesting) + real-KeyboardEvent handler
tests: space/arrows in input/select/contenteditable not prevented and not recorded;
body arrows/space claimed + recorded; button keeps native space, arrows still drive;
keyup always clears; Enter-advance blocked from every editable/interactive focus,
works from body, respects `canAdvance`; password-field Enter submits once, never
advances.

**`test/setupFlowDom.test.js` (new, 8 tests, jsdom).** REAL `renderer/index.html` +
real `setupFlow.js`/`hud.js` with a mocked `window.groundStation`: boot rejection →
visible `#bootError`, RETRY recovers to GARAGE; space/arrow/Enter end-to-end in the
password field (JOIN called with typed password incl. space, step unchanged); Enter in
`iphoneAddr` doesn't navigate, Enter on body does; join rejection → fixed message,
password absent from UI text AND console.error output, retry works; scan rejection →
SCAN FAILED + RESCAN recovers; hotspot rejection → fixed message, password absent from
status and log; save rejection → radio warning, flow continues; GRID `session:apply`
rejection → visible summary error, checklist still renders. Unhandled rejections
anywhere in these flows would fail the file (vitest surfaces them).

### A2 tests: exact commands + results

- Syntax: `node --check renderer/hud.js renderer/setupFlow.js` (plus the four A1 files) — OK.
- Focused (A2 + A1 regression + guards):
  `npx vitest run test/keyboardFocus.test.js test/setupFlowDom.test.js test/hotspot.test.js test/wifiSim.test.js test/runCommand.test.js test/noControlPath.test.js`
  → **72/72 passed** (keyboardFocus 16, setupFlowDom 8, hotspot 23, wifiSim 11,
  runCommand 4, noControlPath 10).
- Full suite: `npm test` → **304/304 passed, 27 files** (was 280/25; +16 keyboardFocus,
  +8 setupFlowDom). `git diff --check` clean.

### A2 remaining limitations

- jsdom cannot prove real Chromium focus/IME behavior; a quick manual bench pass over
  the PIT WALL fields (space in SSID/password, arrows, Enter-joins) is listed for the
  Windows bench visit. No dedicated bench checklist item added yet (fold into D3/F).
- `main.js` is still untested (V2) and `wifi:capabilities` can still block PIT WALL
  entry for up to 20 s (N3, deferred to B1). The boot-error state covers `settings:get`
  rejection, not a main-process crash (Electron-level, out of renderer reach).
- The `ipc()` guard logs once per channel per session (deliberate: 1–2 s pollers would
  flood the console); subsequent distinct errors on the same channel are visible only
  through the UI state.

### A3 implementation status: COMPLETE (M2 code fix + objective UI fixes) — netsh/RT5370 behavior bench-pending

What changed, file by file:

**`shared/wifiParse.js`.** The merged `parseNetshInterfaces` (whole-output scan: last
SSID won, first % won — the M2 root cause) is **deleted**, with a comment explaining
why it must not come back. Adapter status has exactly one path now:
`parseNetshInterfacesList` (per-adapter blocks; name = first field, description =
second, connectedness = non-empty literal-`SSID` value in the SAME block, signal = the
block's own %). No other production code imported the merged parser (grep-verified),
so nothing can call it accidentally — the "constrain or deprecate" requirement is met
by removal.

**`main/wifiManager.js`.**
- `status({iface} = {})`: with `iface`, every connection field comes from that
  adapter's own parsed block; a missing adapter returns
  `{ok:true, iface, present:false, connected:false, ssid:'', signalPct:null, error:'adapter "X" not detected'}`
  (adapter-specific, never another adapter's status); a failed netsh run now returns
  `{ok:false, …, error}` instead of silently claiming "not connected". Without
  `iface`, the aggregate answer is the FIRST CONNECTED block as a unit (ssid+signal
  always from one adapter) — single-adapter behavior unchanged (verified against the
  original fixture: same connected/ssid/signalPct).
- `join({ssid, password, iface})`: profile-add and connect were already pinned via
  `interface=`; verification now polls `status({iface})`. Success = pinned block
  `connected && ssid === requested` (exact, case-sensitive — the target string comes
  from the same netsh scan output; a differently-cased SSID is a different network).
  Poll cadence unchanged: 1 s × 20 s deadline (`JOIN_POLL_MS`/`JOIN_TIMEOUT_MS`,
  tested = exactly 20 polls via the injected sleep/fake clock, NOT by shrinking the
  timeout). A transitional block (associating, no SSID line yet) simply reads as
  not-connected-yet and polling continues. An adapter that disappears mid-poll keeps
  being polled (USB re-enumeration can bring it back) and the timeout error is built
  from the LAST poll only — no stale earlier state can leak: `_joinTimeoutError`
  distinguishes (a) status check itself failing (`could not verify the join to X: <reason>`),
  (b) pinned adapter missing (`adapter "X" not detected after 20s — reconnect it and RESCAN`),
  (c) plain not-connected (`not connected to X on adapter "Y" after 20s (adapter is
  not connected / currently connected to Z)`). No silent fallback to another adapter
  anywhere. `add profile`/`connect` failures now go through the 200-char-capped
  `failReason` like every other error.

**`main/wifiSim.js`.** The sim now tracks the joined SSID **per adapter** (`joined`
map; `wlan connect … interface=X` connects adapter X, default = first adapter;
unknown interface fails like netsh). Built-in and dongle carry distinct deterministic
signals (90% / 72%). `W17_WIFI_SIM=two-adapters` therefore demonstrates real
selection: joining on the dongle leaves the built-in on PaddockNet — the exact M2
topology, previewable on any OS. Still PREVIEW ONLY, never bench evidence.

**`shared/wifiView.mjs`.**
- `ifaceLabel` now appends the signal (`Wi-Fi — Intel … · PaddockNet · 90%`) — SSID
  and signal are fields of the same parsed adapter object by construction.
- Saved adapter NOT detected (any adapter count ≥ 1): mode `select` with a **disabled
  `"<saved> — NOT DETECTED"` placeholder**, `selected:''`, and a hint to choose an
  available adapter or reconnect + RESCAN. The previous silent fallback to the first
  adapter is gone (with one remaining adapter it previously silently switched to it —
  that could have joined W17-GRID on the built-in and killed its home/camera link).
- New `guide` state (`adapterRowState({guide:true})`): "Adapter selection is available
  in the Windows application." + a `W17_WIFI_SIM` dev hint.

**`renderer/setupFlow.js`.** ADAPTER row is now ALWAYS rendered on PIT WALL (guide
mode included); `adapterUnresolved()` blocks scan AND join with
`SELECT AN ADAPTER — the saved adapter was not detected` while the placeholder is
active (no netsh-default fallback the user never chose); picker options honor
`disabled`; guide-mode VERIFY treats `st.ok === false` (manager-reported netsh
failure) as `WIFI CHECK FAILED — VERIFY to retry`, distinct from "not detected".

**`renderer/hud.css`.** One objective line: `select` joined the `:focus` teal-border
rule (keyboard focus was invisible on the adapter picker; A2 made keyboard interaction
first-class). No other visual change — the Q7 redesign stays proposal-gated.

**Fixtures (new).** `netsh_interfaces_two_both_en.txt` (built-in HOME/84% first,
RT5370 W17-GRID/66% second), `…_two_both_reversed_en.txt` (identical blocks, dongle
first), `…_two_de.txt` (German labels, names with spaces — structural parsing proof),
`…_dongle_connecting_en.txt` (built-in connected; dongle `authenticating`, no SSID).

**Tests.** `wifiParse` 18 (both orders → same per-adapter objects; DE; spaces;
transitional; garbage), `wifiManager` 26 (pinned status both orders; missing adapter;
ok:false on netsh failure; aggregate coherence; pinned join success in both orders;
other-adapter-on-target can't fake success; transitional polling; disappearing
adapter honest from last poll with no stale/cross-adapter text; case-sensitivity;
could-not-verify; 20-poll cadence; all pre-existing tests preserved — inline netsh
texts upgraded to realistic full blocks), `wifiView` 12 (NOT DETECTED placeholder,
single-remaining-adapter still demands choice, guide state, signal-in-label),
`wifiSim` 13 (pinned dongle join leaves built-in untouched; unknown interface fails),
`setupFlowDom` 12 (guide-mode row, saved-missing blocks scan/join until picked, picker
pins scan+join, failed-listing row). `noControlPath` untouched and green.

### A3 test commands + results (2026-07-12)

- Syntax: `node --check` on `shared/wifiParse.js`, `main/wifiManager.js`,
  `main/wifiSim.js`, `renderer/setupFlow.js`, `shared/wifiView.mjs` — OK (all 5).
- Focused A3:
  `npx vitest run test/wifiParse.test.js test/wifiManager.test.js test/wifiView.test.js test/wifiSim.test.js test/setupFlowDom.test.js`
  → **81/81 passed**.
- A1/A2 regression + guards:
  `npx vitest run test/hotspot.test.js test/keyboardFocus.test.js test/runCommand.test.js test/noControlPath.test.js`
  → **53/53 passed**.
- Full suite: `npm test` → **327/327 passed, 27 files** (was 304; +3 wifiParse,
  +12 wifiManager, +4 wifiView, +2 wifiSim, +4 setupFlowDom — net of the 2 removed
  merged-parser tests). `git diff --check` clean.
- Handoff verification at session start reproduced the A2 checkpoint (72/72 focused).

### A3 remaining limitations / bench items

- Real `netsh wlan show interfaces` output with the RT5370 attached (block shape,
  transitional-state wording, whether an SSID line appears during association — if it
  does, a pinned join may read "connected" moments before DHCP completes; fails safe
  toward success-with-late-IP, observe on bench) — checklist §2/§6 territory.
- Whether `netsh wlan connect interface=…` accepts the parsed `Name` values verbatim
  on a real localized Windows (argv arrays are quoting-safe; the name string itself is
  bench-checked).
- The German fixture proves the PARSER's structural strategy; real German netsh
  output should be captured once on bench if a localized machine is available.
- jsdom previews prove renderer wiring, not Chromium rendering; eyeball the four sim
  scenarios once (`W17_WIFI_SIM=… npm start`).

### Adapter-UI investigation (Q7) — findings

**Exact conditions for the ADAPTER section to appear (pre-A3 tree):**
1. GARAGE choice = IPHONE COCKPIT (`iphone-hud`) — PIT WALL does not exist in the
   solo/desktop flow at all (`shared/setupSteps.mjs`).
2. AND not skipped: with `setupCompleted:true` persisted, boot() jumps STRAIGHT TO
   GRID ("WELCOME BACK") — PIT WALL is only reachable again via CHANGE SETUP → GARAGE.
3. AND `caps.canScan` true — i.e. real Windows, or any OS with `W17_WIFI_SIM` set
   (main.js forces the sim managers + platform win32). On macOS/Linux WITHOUT the sim
   the entire row was `hidden` (guide mode had no adapter section) — **fixed in A3**.
4. The row itself: one adapter = plain readonly text span; 2+ = native `<select>`
   (dark background, 1 px panel-edge border, mono font, OS-native chevron; no hover
   state; focus border was missing until the A3 one-liner); zero adapters / listing
   failure = amber warning text + hint line.

**Per-scenario behavior (from code + jsdom/DOM tests + sim):** zero adapters →
`NO WLAN ADAPTER DETECTED` + dongle hint, RESCAN in the join pane re-detects; one →
readonly `Name — Description · SSID · signal%`; several → picker (persisted choice
restored while present); saved missing → was "silently use first + small hint", now
disabled NOT DETECTED placeholder that blocks scan/join until re-chosen; listing
failure → `ADAPTER LIST FAILED` + reason; guide mode → was nothing, now the
Windows-app note + sim hint.

**Why the user likely never saw it:** any of (a) macOS dev machine without
`W17_WIFI_SIM` → guide mode, row hidden entirely (accepted likely cause — confirmed
in code); (b) `setupCompleted` persisted → boot skips PIT WALL; (c) DESKTOP FPV mode →
no PIT WALL step; (d) the Windows bench-host clone is at `dab3039`, which PREDATES the
adapter row entirely (row landed in the B-series ending `cf038c2`) — an old process /
old checkout shows no row on real Windows either. All four are consistent with the
reported experience; (a)+(d) are the most probable.

**Deterministic preview commands (any OS, from this repo, uncommitted tree):**
```
W17_WIFI_SIM=two-adapters npm start   # picker; join on Wi-Fi 2 leaves Wi-Fi on PaddockNet
W17_WIFI_SIM=one-adapter  npm start   # readonly single-adapter line
W17_WIFI_SIM=no-adapter   npm start   # NO WLAN ADAPTER DETECTED + hint
W17_WIFI_SIM=netsh-fail   npm start   # ADAPTER LIST FAILED + reason
npm start                             # macOS guide mode: Windows-app note + sim hint
```
Then GARAGE → IPHONE COCKPIT → PIT WALL (press CHANGE SETUP first if it boots straight
to GRID). Every screen shows the amber SIMULATED WIFI tag while the sim is active.
Host macOS/Linux interfaces are never presented as selectable adapters (guide mode has
no picker by design).

### Adapter-UI proposals (Q7 — pick one before any substantial redesign)

Current state after A3's objective fixes: correct and honest in every state, but
visually minimal — a text row above the tabs; the multi-adapter control is a bare
native `<select>`.

- **Option 1 — "Styled row" (minimal delta).** Keep the one-row layout; restyle the
  `<select>` (panel-edge border, custom teal chevron glyph, hover brightness, focus
  teal — focus already done) and give the readonly single-adapter span the same
  bordered treatment so one vs many adapters look related; NOT DETECTED stays a
  placeholder option. ~CSS-only + a chevron wrapper span; touches `hud.css`,
  `index.html` (one wrapper), no view-model change; tests unchanged (all states
  already pinned). Cheapest, but the single-adapter "card" remains one dense line.
- **Option 2 — "Adapter card" (recommended).** Promote the row to a small card in the
  netpane style: line 1 = interface name + state chip (CONNECTED ssid · signal% /
  DISCONNECTED / NOT DETECTED in amber), line 2 = driver description muted, line 3 =
  hint/troubleshooting. With 2+ adapters the card header becomes the opener of a
  netrow-style chooser list (`SELECT ADAPTER` / `CHANGE ADAPTER` button in minibtn
  style) — same interaction pattern the network list already trained the user on;
  zero adapters = the card body is the troubleshooting text + RESCAN. Touches
  `wifiView.mjs` (richer state object), `setupFlow.js` render, `index.html`,
  `hud.css`, `wifiView.test.js` + `setupFlowDom.test.js`. Clearest fit with Q7's
  "clearly styled selected-adapter card" wording while reusing existing visual
  vocabulary (netrow/minibtn/known-chip).
- **Option 3 — "Adapters as a list" (biggest change).** Render adapters exactly like
  the network list (one `netrow` per adapter, always visible, click to select, active
  row highlighted, signal right-aligned). Most discoverable and most consistent, but
  it permanently spends vertical space PIT WALL doesn't really have (network list +
  password row + tabs already stack), and a 1-adapter "list" looks odd.

Recommendation: **Option 2**. Objective fixes already landed regardless of choice
(guide-mode visibility, NOT DETECTED no-fallback, blocked unresolved scan/join,
select focus, honest error states, deterministic sim scenarios).

**DECISION (2026-07-12): Option 2 "Adapter card" — chosen and IMPLEMENTED.** The user
refined the spec: use a native `<select>` inside the card (not a custom popup) so
keyboard/screen-reader behavior is preserved; a single adapter is readonly with a clear
`SELECTED` indication and NO dropdown; multiple adapters show the selected adapter's
detail plus a bordered/chevron/hover/focus native dropdown labelled `SELECT ADAPTER`
(no valid selection) / `CHANGE ADAPTER` (one chosen), option labels carrying the driver
description; changing the selection updates the card immediately, persists, keeps
per-adapter connection state separate, and never silently falls back; a vanished saved
adapter shows amber `NOT DETECTED` and requires an explicit pick; zero adapters →
`NO WLAN ADAPTER DETECTED` + troubleshooting + `RESCAN`; a listing failure →
`ADAPTER CHECK FAILED` + sanitized reason + `RESCAN`; guide mode keeps the card with the
Windows-app note + `W17_WIFI_SIM` hint and never lists host interfaces as adapters; the
four sim scenarios are preserved and the two-adapter one demonstrates switching with
separate per-adapter state. Styling reuses `panel`/`netrow`/state-chip vocabulary
(teal connected/selected, amber warning/missing, notched corners); the card reads
interactive when a choice exists and readonly when it does not. See the "A3 adapter-card
follow-up" change-log entry and the transfer-checkpoint addendum for the file-by-file
detail and test results (full suite 331/331). Options 1 and 3 were not taken.

### A3 adapter-card follow-up status: COMPLETE (Q7 Option 2) — VISUALLY ACCEPTED in Electron

The ADAPTER row is now a compact card in the PIT WALL vocabulary. This touched only files
already modified by A1–A3, so the `git status --short` listing above is UNCHANGED (no new
tracked/untracked files). A full visual acceptance pass ran the real app in Electron across
all six states (see the "VISUAL ACCEPTANCE PASS" note below and the change-log). File by
file:

**`shared/wifiView.mjs`.** `adapterRowState(res, savedAdapter)` returns a CARD MODEL, not a
one-line label. Fields (present per mode): `mode` (guide/failed/missing/single/select);
`status`/`warn`/`rescan`/`hint` for the degraded headline states; `detail`
(`{name,description,connected,ssid,signalPct,chip:{text,tone}}`) for the adapter the card is
about; `selectedNote:'SELECTED'` for the single readonly adapter; `options`/`selected`/
`selectorLabel` (SELECT/CHANGE ADAPTER)/`savedMissing` for select mode. `ifaceChip` →
`{CONNECTED,connected}` / `{DISCONNECTED,idle}`; a vanished saved adapter gets a synthetic
`{NOT DETECTED,missing}` detail + amber. Failed-listing status text is now
**`ADAPTER CHECK FAILED`** and the reason is whitespace-collapsed + 160-char-capped
(`sanitizeReason`). Option labels reuse the full `ifaceLabel` (name — description · ssid ·
signal). NO field-mixing across adapters (each `detail` is one parsed block — the M2 rule).

**`renderer/index.html`.** `#adapterRow` is now `.adaptercard` with: `.adapterhead`
(`label` + `#adapterSelNote` SELECTED), `#adapterDetail` (`#adapterName` + `#adapterChip` +
`#adapterNet` + `#adapterDesc`), `#adapterPick` (`#adapterPickLabel` + `.selwrap` wrapping
the native `#adapterSelect`, `aria-label="WLAN adapter"` — visual-pass a11y fix, its only
programmatic name), `#adapterStatus`, `#adapterHint`, and a card-level `#adapterRescan`
minibtn. `#adapterSelect`/`#adapterHint`/`#adapterRow` ids preserved; the old `#adapterLabel`
span is gone.

**`renderer/setupFlow.js`.** `refreshAdapters()` caches the raw listing in `adapterRes`
(guide sentinel `{guide:true}` off-Windows) and calls `renderAdapterCard(adapterRowState(...))`.
`renderAdapterCard(state)` toggles the sub-blocks per mode and sets the left-accent class
(`interactive` teal = a choice exists; `warn` amber = missing/failed/saved-missing; neutral
= readonly single). The `<select>` change handler re-renders the card from the CACHED
listing (immediate header update, no extra netsh call), persists `network.adapter`, and
rescans pinned to the new iface. Degraded states show the card `#adapterRescan` and HIDE the
join-pane `#netRescan` (same `rescanAll` handler; avoids a duplicate button). `chosenAdapter()`
/`adapterUnresolved()` unchanged in contract (read `adapterSelect.value` + `adapterMode`).

**`renderer/hud.css`.** `.adaptercard` (panel bg, panel-edge border, 3px left accent,
notched corner; `width:min(46ch,80vw)` to match the netlist width so their right edges align
— visual-pass fix) + `.statechip` (idle muted / `.connected` teal / `.missing` amber) +
`.adapternet` (teal ssid·signal) + `.adapterdesc` (muted) + `.adapterpick` (a column: label
above, select below — visual-pass fix) / `.picklabel` + `.selwrap::after` custom teal chevron
(vertically centered) with `appearance:none` on the select; the select is `width:100%`,
ellipsizing within the card padding (visual-pass fix — it previously overflowed to the card's
right edge). Native keyboard/AX intact; hover brightness; focus = bright-teal border (from
A3, verified clearly visible in Electron). Old `.adapterrow` rules removed.

**NO change** to `main/wifiParse.js` / `main/wifiManager.js` / `main/wifiSim.js` — the A3
per-adapter sim + pinned status/join already back the card; the two-adapter sim demonstrates
switching with separate SSID/connection/signal per adapter.

**Tests.** `test/wifiView.test.js` 12→**14** (card-model shape for every mode; sanitized
reason). `test/setupFlowDom.test.js` 12→**14** (guide card / zero-adapter card + working
card RESCAN / single readonly card with chip+SSID+SELECTED+no-dropdown / saved-missing amber
NOT DETECTED blocking scan+join then pick→persist→re-pin→warn-cleared / two-adapter native
`<select>` pins scan+join and updates the card per-adapter). Native-`<select>` assertion
pins "keyboard/screen-reader preserved, not a custom popup" and now also asserts the select
carries an `aria-label` (visual-pass a11y fix). `noControlPath` untouched.

**Test commands + results (2026-07-12):**
- Syntax: `node --check renderer/setupFlow.js renderer/hud.js` + `wifiView.mjs` import — OK.
- Focused adapter/view/DOM: `npx vitest run test/wifiView.test.js test/setupFlowDom.test.js`
  → **28/28**.
- A1–A3 regression + guard: `npx vitest run test/hotspot.test.js test/runCommand.test.js
  test/keyboardFocus.test.js test/wifiParse.test.js test/wifiManager.test.js
  test/wifiSim.test.js test/noControlPath.test.js` → **110/110**.
- Full suite: `npm test` → **331/331, 27 files** (was 327; +2 wifiView, +2 setupFlowDom).
  `git diff --check` clean.

**VISUAL ACCEPTANCE PASS (2026-07-12, Electron, real app) — DONE.** Ran the real,
unmodified app (`main/main.js`, real preload + IPC + sim) in Electron across all six
states — `W17_WIFI_SIM=two-adapters|one-adapter|no-adapter|netsh-fail`, plain (guide), and a
seeded saved-missing (`network.adapter` = a name absent from the sim) — driving GARAGE →
IPHONE COCKPIT → PIT WALL and capturing a screenshot + a computed-style/DOM dump per state.
Findings: card layout, chip tones, SELECTED / CHANGE / SELECT ADAPTER labels, teal chevron,
amber NOT DETECTED, single-RESCAN degraded states (join-pane RESCAN correctly hidden), guide
note with a visually-secondary sim hint, per-adapter switching, and no page-level horizontal
overflow all render correctly. Focus verified clearly visible (bright-teal select border;
prominent RESCAN focus ring). Three small objective fixes applied and re-verified (see the
change-log "VISUAL ACCEPTANCE PASS" entry): (1) select `width:100%` in a column picker so it
ellipsizes with breathing room instead of overflowing the card edge; (2) card width matched
to the netlist (`min(46ch,80vw)`) so right edges align; (3) `aria-label` on the select for a
programmatic name. Nothing left pending here except the on-real-Windows bench eyeball with an
actual RT5370 (netsh block shape / localized text), which stays a §5 / D3-F bench item — the
sim preview is never bench evidence.

### Test results (B3 + B4, 2026-07-13)

- Syntax: `node --check` OK on all 29 changed JS/MJS files.
- Focused B3: `wifiParse` 39, `wifiManager` **36**, `wifiView` **35**, `wifiSim` 16,
  `setupFlowDom` **42** → **168/168** (incl. the `unknown`-security correction).
- Focused B4: `hostProbe` 16, `reachability` 7 → **23/23**.
- Regressions: A1/B1/B2 lifecycle (`hotspot`/`hotspotLifecycle`/`quitPolicy`/`runCommand`)
  **74/74**; A2 `keyboardFocus` **16/16**; `noControlPath` **10/10** (guard-list +1).
- Full suite `npm test` → **484/484 (31 files)** (was 407/29; +21 wifiParse, +11 wifiManager,
  +10 wifiView, +2 wifiSim, +11 setupFlowDom, +16 hostProbe, +7 reachability).
  `git diff --check` clean.
- Electron sim acceptance: all B3 rows/warnings/rejections + the OPEN password-field
  `display:none` (with JOIN still shown), and B4 reachable/timeout/unreachable wording,
  verified in the real app (scratchpad harness). Dev-preview only, never bench evidence.

### New finding this session

- **CSS `.hidden` no-op on `#netPassword`** (found + fixed in the B3 Electron pass): this
  stylesheet has no global `.hidden{display:none}`; hiding the open-network password input
  by class did nothing visually until `#netPassword.hidden{display:none}` was added. jsdom
  cannot see it (no linked-CSS/layout). No other bare-`.hidden`-on-an-unscoped-element cases
  were found in the B3/B4 diff, but it is worth a sweep in a later pass.

### Next batch (do NOT start until the user resumes)

1. ~~B3 (Wi-Fi security scope) + B4 (reachability classification)~~ — **DONE 2026-07-13**.
2. ~~Batch C — C1 video state / C2 replay chip / C3 env-locks / C5 W2-on-GRID docs (C4
   re-validated)~~ — **DONE 2026-07-13** (this batch; see the Batch C status section + change
   log). Stop-for-review is in effect; do NOT start Batch D until the user resumes.
3. ~~Batch D1 + D4~~ — **DONE 2026-07-13** (directory sweep + command-generation
   hardening; see the Batch D1 + D4 status section).
4. ~~Batch D2~~ — **DONE 2026-07-14** (main-process + setup-flow integration coverage,
   composition-root refactor onto `main/appWiring.js`, COMMITTED by the user as `0564141`;
   see the Batch D2 status section).
5. ~~Batch D3~~ — **DONE 2026-07-14** (deterministic real-Electron boot smoke +
   windows-latest CI step; see the Batch D3 status section above). Local: full suite
   **658/658 (37 files)** and **4/4** real smoke scenarios PASS. **Remote CI execution
   remains pending the next commit/push** — nothing is committed.
6. **Exact next starting point — Batch E1** (objective never-log guarantee + a logged Q6
   decision), then **F** (doc sync). E1 = Q6 credential encryption (safeStorage/DPAPI,
   transparent plaintext→encrypted migration, ciphertext incl. `.bak`, in-memory-only
   session fallback when OS encryption is unavailable, undecryptable-secret recovery,
   redaction tests); the persisted hotspot password reaching the renderer inside
   `settings.network.hotspot` is the documented E1 residual to close. F = L5 + doc sync
   (`../CURRENT_STATUS.md` pointer + checklist prereqs + readiness-doc stale note; contract
   §1–§7 untouched). G = proposals only, untouched. **Do NOT start until the user resumes.**
7. Bench items accumulate in §5 + the per-batch bench notes; Batch C adds: real camera → mediamtx
   → WHEP so the video-state model runs against genuine WebRTC drops/stalls, and a real iPhone
   confirming W2 telemetry appears on GRID entry (C5). Nothing new is hardware-proven.

Recommended first actions for the next session: read this checkpoint + §4 decisions;
`git log --oneline -3` (expect HEAD **`0564141`** "test: harden main-process integration
wiring" ← **`79fa2e0`** "a lot of chagnes" ← `cf038c2`); `git status --short` (expect the
**Batch D3 delta: 3 M + 4 ??** — `M .github/workflows/ci.yml`, `M` this audit file,
`M package.json`; `?? scripts/electron-smoke.js`, `?? scripts/smokeMain.js`,
`?? scripts/smokeShared.js`, `?? test/electronSmoke.test.js`); `npm test` (expect
**658/658**, 37 files); `npm run smoke:electron` (expect **4/4** scenarios PASS, no orphan
process/temp dir); `git diff --check` (clean). All D3 work stays UNCOMMITTED until the user
reviews.

### Hard boundaries (unchanged, apply always)

W3/5602 log-only; `noControlPath.test.js` green and strengthen-only; no pan/tilt or
camera-control mapping; no car-control path; no CRSF encoder; `docs/windows_bridge_contract.md`
§1–§7 untouched; canonical contract authority iPhone-side; viewer/setup/launcher only; sim
never counts as hardware evidence; persisted mode values stay compatible; no error
concealment; nothing committed/pushed without user review.
