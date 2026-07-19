# Setup-Flow Redesign — Final Audit (Batches 0–9)

**Date:** 2026-07-17 · **Audited HEAD:** `9855cc3` (Batch 9) · **Baseline:** `248a539`
(last Batch 0 chunk) · **Repo:** `w17-ground-station` only · **Nothing pushed.**
**Plan of record:** `~/.claude/plans/let-s-improve-ground-station-kind-pearl.md` ·
**Visual truth:** `../w17-design-system/` (w17.css, DESIGN_NOTES.md §1–13, screens/).

**Method note.** Per-batch reviews ran during implementation; this audit re-verified the
whole range. Of the planned 10-agent code-review fan-out, nine agents were terminated by a
session limit before returning any findings and the tenth (the conventions angle) never
launched — none completed the review. The finder-angle methodology was therefore executed
inline by the auditing session at max effort over the full materialized
`git diff 248a539..HEAD` (4,310 lines, 26 files, +3,347/−157), followed by direct
verification of every candidate against the code, a live probe against the real settings
store, and a scripted live sweep (CDP-driven real app, injected standard-mapping gamepad,
PNG pixel probes, 23 screenshots).

## 1. History & scope — verdict: CLEAN (one unrecorded, benign deviation)

Working tree clean at `9855cc3`. All 11 range commits map 1:1 onto plan batches, in plan
order; Batch 0's four chunks sit at/before the baseline with file sets exactly per plan
(a=`a88692d` cameraMode+test, b=`a9d516f` inputPresets+padPreview+tests, c=`d822c80`
setupFlow+index+hud.css+tests, d=`248a539` docs).

| Commit | Batch | File set vs plan |
|---|---|---|
| `26abfe1` | 1 — PIT WALL layout | exact |
| `32ddaf8` | 2 — SEAT FIT concision + overlays | exact |
| `4d0e50a` | 3 — pad preview redesign | exact |
| `d157ec0` | 4 — small-display pass | exact |
| `755bcdb` | 5 — wheel model (pure) | exact (2 new files) |
| `ee2efaf` | 6 — wheel UI + persistence | plan +`shared/wheelProfile.mjs` (recorded: the "8th file" export) |
| `2e309db` | 7 — HUD wheel mirror + riders | plan + rider-block files (padPreview, wheelPreview, wheelProfile, docs) — sanctioned by §7 riders |
| `5cc908e` | 8a — flow chrome | exact; recorded deviations: REVS · SHIFT fold-in, returning-user boot → GARAGE card |
| `53c0d17` | 8a.1 — riders a/b + wheel pills | exact |
| `21c14e3` | 8b — reorder + skip chip | **unrecorded deviation:** touches `shared/setupSteps.mjs` + `test/setupSteps.test.js`, absent from the plan's §8b file list (plan text wrongly assumed the step table lives in setupFlow.js). Correct implementation site; benign; recorded here. |
| `9855cc3` | 9 — controller UI nav | exact (index.html untouched — "minimal" allows zero) |

The recorded "Batch 1 hunks inside Batch 2's commit" deviation is **not visible at hunk
granularity** — `26abfe1` is pure Batch 1 and `32ddaf8` pure Batch 2 (committed 17 s
apart from one working session). Process-level only; content partitions cleanly.

## 2. Plan-vs-delivered (per batch, with every deviation in one place)

| Batch | Promised (plan) | Delivered | Deviation |
|---|---|---|---|
| 0 | verify report + commit dirty tree in 4 chunks | 4 chunks as specified | none |
| 1 | .cols 56ch centered; addr row restructure; contract tests | all landed (`hud.css`, `index.html`, tests pin them); live Δx=0 on CHECK | none (`.netstatus` min-height pre-existed — leveraged, not added) |
| 2 | one copy per fact; fixed overlays; padding → clamp(5.5em,10vh,7em) | all landed; occurrence tests pin 1× keyboard-fallback / 1× log-only | none |
| 3 | 440×200 viewBox; corner pills; captions under buttons (OT 198,132 / BOOST 242,132); B\<n\>; 420px caps | all landed | delivered face-cluster geometry OT/BOOST cx186/256, captions y142 — different numbers, same clearance criterion (plan coords were illustrative; batch review accepted) |
| 4 | 1024×640 floor; startbtn wrap; padding 7em | all landed | padding later superseded by 8a.1's derived reserve (sanctioned) |
| 5 | pure wheelProfile model + tests | all landed (208-line module, 300-line suite) | none |
| 6 | input-type row; wheel panel; BOTH selectors; persistence via existing save | all landed; boots GAMEPAD pinned | recorded: +wheelProfile.mjs export. **Finding 1: the persistence promise does not hold on the real store** (see §3) |
| 7 | HUD wheel STR/THR/BRK; docs §6; riders a–c | all landed; deadzone bound single-sourced (MAX_DEADZONE), labels single-sourced, pill() esc'd, spread 19, identity-quirk docs note | rider (d) readAxis dedupe **left open**, no defer note |
| 8a | step rail; solid backdrop; fast-path card; HUD status stack + INPUT tag + violet dot | all landed | recorded: rev label folded to REVS · SHIFT; boot lands returning users on GARAGE with focused card |
| 8a.1 | toast cap <700px; derived gate reserve; wheel-button HUD pills (option i) | all landed; reserve = `--radio-bottom + --radio-2stack + .4em` | none |
| 8b | reorder GARAGE→SEAT FIT→PIT WALL→GRID; surface skip; nav matrix | all landed; matrix green; skip chip live | unrecorded file-set addition (setupSteps.mjs + test) — see §1 |
| 9 | pad focus/confirm; inset ring; ⚙=9; capture + live suspension | all landed incl. the 9 triage fixes | recorded: back=1 demoted to close-settings-only (BOOST collision); deferrals #6 + cleanups — now documented in §6 |

## 3. Findings (ranked; triage with the user — fixes are follow-up work, none applied)

**Confirmed defects**
1. **HIGH — wheel profile never persists.** `normalizeSettings`
   (`shared/settings.js:59-96`) rebuilds a fixed shape with no `wheel` key and
   `main/settingsStore.js:193-207` routes every save through it. Repro against the real
   store: `save({wheel:{profile:…}})` → returned **and** persisted settings have no
   `wheel` key. Live: restart reverted captured `BTN 7 / AXIS 2 · REST 0.90 · FULL −0.85`
   to defaults; same-session leave+return also resets (save() replaces local `settings`
   with the normalized result, so `enterSeatfit` re-derives the default). Silent — no
   save error. Suite green because `setupFlowDom` mocks `gs.setSettings`. Batch 6's
   acceptance "restart ⇒ saved profile reloaded" fails on the real app. *Fix direction
   (follow-up): admit a validated `wheel.profile` subtree in `normalizeSettings` (CJS —
   mind `wheelProfile.mjs` is ESM) + one integration test through the real store.*
2. **MED — wheel mirror reads the wrong device when the wheel is absent at START.**
   `applyInputSource` (`renderer/setupFlow.js:892`) falls back to `wheelKey ''` when
   `resolveWheelPad` returns null; `wheelPad()` (`renderer/hud.js:139`) then resolves the
   FIRST pad — the gamepad — through the wheel calibration (idle centred axis reads
   THR≈50% under an INPUT · WHEEL tag). Display-only, but wrong and mislabeled.
3. **LOW — WHEEL (non-BOTH) mode always follows the first pad slot**
   (`renderer/setupFlow.js:872`): with a gamepad in slot 0, ASSIGN/SET REST/FULL listen
   to the gamepad. Plan-conformant (selector promised only for BOTH) — usability gap;
   workaround: BOTH mode or unplug.
4. **LOW — keyboard driving mirror dead in a WHEEL/BOTH session with no pads**
   (`renderer/hud.js:261` + wheel override): keyboard STR/THR/BRK are overwritten with
   neutral and the button block is skipped; pre-wheel HUD mirrored keys in that state.
5. **LOW — ⚙ reachable via pad during the start-lights countdown**
   (`renderer/setupFlow.js:1724`): `settingsOnly()` is false while the gate is visible;
   only `back()` carries the `lightsRunning` guard, so button 9 (or d-pad + confirm on ⚙)
   opens settings over the lights.
6. **LOW — fast-path card steals focus on every GARAGE entry**
   (`renderer/setupFlow.js:166`): CHANGE SETUP / BACK-to-garage also focus STRAIGHT TO
   THE GRID (live-verified); an accidental Enter bounces straight back to GRID. The
   approved deviation wording covered the boot landing only.
7. **LOW (docs) — Batch 9 deferrals were documented nowhere in-repo** — only in the
   external plan file. §6 of this note now records them; a comment at
   `renderer/uiNav.js:38/203` would be the durable in-code marker.

**Observations (no action required to close the audit)**
- **Design bundle §10 vs BOTH mode:** delivered BOTH = plan's spec (stacked full mirrors
  + own selector); the 02c mockup's per-device source tags and CALIBRATED-chip +
  EDIT MAPPING summary are absent (live: srctag count 0). Plan and bundle conflict —
  needs a recorded decision (implement §10 later, or amend the bundle).
  - **RESOLVED 2026-07-19 (Decision B), both ways:** the per-device source tags were
    implemented (`ec1baef`, 2026-07-18 — gamepad mirror `srctag pad` PAD → PAN/TILT,
    wheel mirror `srctag wheel` WHEEL → STR/THR/BRK, shown only in BOTH mode), and the
    design bundle was amended (`w17-design-system` DESIGN_NOTES.md §10): the shipped
    stacked full-panel BOTH-mode layout is now the canonical design (superseding the 02c
    mockup), and the CALIBRATED-chip + EDIT MAPPING summarization is recorded as an
    optional future density refinement only (no measured overflow). No app change pending.
- Wheel-only sessions: `pad()` falls back to the wheel, so the violet camera dot mirrors
  the wheel device's axes 2/3 labeled STICK INPUT · PAD (pinned by `hudWheel` test —
  intended; docs §6.2's "a wheel has no aim stick" doesn't cover the wheel-as-only-pad
  case). Docs nuance only.
- Batch 6 rider (d) left open: `wheelProfile` local `readAxis`/`clampAxis` vs
  `inputPresets.axisValues` local clamp — dedupe never done, no defer note.
- Deferred cleanups quantified (the triage's own list): `uiNav.pollOnce` allocates a pad
  snapshot per rAF frame; `dedupeGamepads` runs 2×/frame in wheel sessions + once per
  250 ms tick; `setupFlow.snapPad` ≈ `uiNav.snapshotPad`; the
  `dedupeGamepads(navigator.getGamepads ? … : [])` incantation appears 5×. Acceptable on
  desktop Electron; listed as known.
- Minor: `applyInputSource` comment says "GAMEPAD passes only the type" but passes the
  profile unconditionally (unused outside wheel sessions); `.uinav-focus` class parks on
  the hidden START control after the gate dismisses (invisible; cleared on next focus);
  pinned overlays (summary chip/footnote) transiently cross content at scrollTop 0 on
  scrollable screens — inherent to fixed overlays, clears at max scroll (measured),
  pre-existing pattern.

## 4. Invariant verdicts (one line each)

1. **Viewer-only / no control path: PASSED** — `noControlPath` 16/16; auto-discovery
   covers all 59 runtime files, including `renderer/uiNav.js`, `renderer/wheelPreview.js`,
   `shared/wheelProfile.mjs` (discovery replicated and the three verified present).
2. **Preload surface: PASSED** — `ipcSurface` green at exactly 24 keys; smoke 4/4 with
   `apiKeys:24`, `contextIsolation:true`, `nodeIntegration:false`.
3. **Camera-aim semantics: PASSED** — HEAD TRACKING card `LOCKED · SAFETY GATE NOT
   COMPLETE`, ACTIVE AUTHORITY `NOT REPORTED BY MAPPER` (live screenshots); camera dot
   pixel-probed violet rgb(178,141,248) with `STICK INPUT · PAD`; `INPUT · GAMEPAD/WHEEL`
   truthful; no "aim"/"measured"/"gimbal" claim anywhere incl. wheel viz + nav labels.
4. **responsiveLayout CSS contracts: PASSED** — responsiveLayout 22/22 targeted
   (ipcSurface + responsiveLayout combined run 38/38; both within the full 984/984); live
   zero horizontal overflow at 1280×800, 1366×768, 1024×640, 1470×956 (all screens + HUD).
5. **Wheel activation never persisted: PASSED** — always boots GAMEPAD (test-pinned +
   live restart).
6. **Settings writes limited to `{wheel:{profile}}` + pre-existing keys: PASSED** on the
   renderer side (patch shape test-pinned; persisted file carries exactly the 12
   pre-existing keys) — with the store-side stripping recorded as finding 1.
7. **W3 chip: PASSED** — `HEAD-TRACK LOG · NO CONTROL` verified in the live DOM.

Deferred/left-open: select/range pad value-stepping (**deferred**, §6); readAxis dedupe
rider (**left-open**); allocation/dedup cleanups (**deferred**, quantified above).

## 5. Functional + live sweep evidence

- `npm test`: **984/984, 52 files** (matches the Batch 9 record). `node --check`: all 10
  changed product files clean. `npm run proto:check`: OK (snapshot matches live mapper).
  `npm run smoke:electron`: **4/4 scenarios PASS**.
- Live (real app, throwaway userData, `W17_WIFI_SIM=two-adapters`, empty mediamtx dir;
  CDP-driven; sizes via device-metrics emulation — the physical min-floor is pinned by
  the `createWindowOptions` unit test):
  - **walk1 @1280×800 — 63/69**, where the 6 fails are: finding 1's live proof
    (settings.wheel=null), the §10 design gap, three probe artifacts re-proven clean in
    walk1b, and one pixel-threshold miss settled visually (ring clearly visible on the
    clipped pill silhouette).
  - **walk1b — 25/27**: restart evidence (persisted settings.json has no wheel key;
    profile reverted to defaults = finding 1 end-to-end); full keyboard-parity pass
    (Enter resumes from the focused card, Tab-walk → START ANYWAY → Enter → HUD, Escape
    closes ⚙); live-session inertness re-probed by identity (d-pad and steering axis move
    nothing; BOOST does nothing; button 9/1 work); 1366×768 + 1470×956 overflow-free.
  - **walk1c**: HUD at 1366×768 + display-resolution pass, overflow-free.
  - **Pad-only full flow** GARAGE→SEAT FIT (incl. WHEEL panel: listen-assign BTN 7, axis
    assign AXIS 2, SET REST 0.90 / SET FULL −0.85)→GRID→⚙ open/close→START→live HUD —
    zero mouse/keyboard. Focus ring pixel-probed teal on the mode card and on the
    clip-path pill; capture suspension verified both ways (d-pad during LISTENING moves
    no focus AND is consumed by the capture — it assigned BTN 13, which is the task-§4
    contract working); button 1 never steps BACK; button 9 toggles ⚙ on setup and HUD.
  - **PIT WALL CHECK**: Δx=0 for label/input/button across invalid ("INVALID IP"),
    unreachable 192.0.2.1 ("NO REPLY — REACHABILITY COULD NOT BE CONFIRMED"), and a
    forced suggest-pill appearance; status renders on its own reserved line.
  - **Toast band** (SEAT FIT·BOTH, 3 toasts, max scroll): clearance −15.9 px @800,
    −14.4 px @720 (3 toasts visible), −49.8 px @640 with the cap limiting to 2 visible —
    the documented 1024×640-floor residual is closed.
  - **Rail states** track the real step/skip state on every screen (fresh GARAGE shows
    `03 PIT WALL — SKIPPED · DESKTOP` under the default solo mode; iPhone path shows it
    as todo/current with no chip; hidden during the lights hand-off).
  - **Design match** (23 screenshots vs bundle): garage §1/§3 ✓, seatfit §7 ✓ (violet
    right-stick vocabulary ✓), wheel §8/§9 ✓ except DEADZONE not sharing the pedal-mode
    options row (cosmetic), BOTH = plan ✓ / bundle §10 gap (observation above), pitwall
    §4 ✓, GRID ✓, HUD §11–13 ✓ (status stack, INPUT tag, violet dot, ⚙ everywhere,
    REVS · SHIFT).
  - Console: only `ERR_CONNECTION_REFUSED` from the deliberately-absent mediamtx.

## 6. Known limitations (documented here as the durable record)

- **Select/range controls are pad-inoperable** (Batch 9 triage deferral #6, approved):
  pad focus reaches them, but confirm cannot open a `<select>` and d-pad left/right moves
  focus rather than stepping the value (live-demonstrated on the DEADZONE slider —
  value unchanged, focus moved). Mouse/keyboard fully work. Candidate follow-up:
  left/right value-stepping while such a control holds pad focus. Affected controls:
  `#adapterSelect`, `#setTelemetrySource`, `#wheelDeadzone`.
- **back=1 is close-settings-only** (approved deviation): button 1 is BOOST in every
  preset; stepping BACK is done by focusing the visible BACK button + confirm. No keys
  help text mentions pad buttons, so no user-facing text needed updating.
- **Allocation/dedup cleanups** deferred by the triage — quantified in §3 observations.

## 7. Recommended follow-ups (none applied in this audit)

1. Fix finding 1 (store-side `wheel` support + a real-store integration test) — the only
   change needed for the wheel feature to keep its persistence promise.
2. Decide finding 2's fallback (pass no key / show INPUT · WHEEL (NO DEVICE) rather than
   resolving the first pad).
3. Record a decision on design bundle §10 (implement vs amend).
4. Small guards: `lightsRunning` in `settingsOnly`/`toggleSettings`; focus the card only
   on boot; an in-code note at `uiNav.js` for the select/range deferral; close or
   formally waive the readAxis rider.
