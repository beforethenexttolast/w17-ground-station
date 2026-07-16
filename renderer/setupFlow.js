// Pre-ride setup flow: GARAGE (mode) -> PIT WALL (network) -> SEAT FIT
// (controller) -> GRID (checklist) -> start lights -> HUD. Owns the gate
// overlay; hud.js keeps owning the HUD and exposes startRide()/hudStatus().
//
// Everything OS-touching goes through the preload surface; this file is UI
// glue over the pure step/checklist/address modules in shared/. It never
// touches control — the START buttons only dismiss a viewer overlay.

import { startRide, hudStatus, setControllerChoice, setW3Chip, setReplayChip } from './hud.js';
import { stepsFor, nextStep, prevStep, LIGHTS } from '../shared/setupSteps.mjs';
import { buildChecklist, applyProbes, canStart } from '../shared/checklist.mjs';
import { isValidIpv4, suggestionFromHint } from '../shared/addressProviders.mjs';
import { adapterRowState, scanStatusText, hotspotPaneState, joinPlan, networkBadge, classifyJoinError } from '../shared/wifiView.mjs';
import { probeStatusLine, PATH_ONLY_NOTE } from '../shared/reachability.mjs';
import { summaryLine } from '../shared/setupSummary.mjs';
import {
  PRESETS, DEFAULT_PRESET, getPreset, detectPresetFromId, pressedRoles,
  dedupeGamepads, transportLabel, axisValues, inputSourceView,
  gamepadKey, resolveSelectedPad,
} from '../shared/inputPresets.mjs';
import { cameraModeView } from '../shared/cameraMode.mjs';
import { makeEnterToAdvance, makeEnterToSubmit } from '../shared/keyboardFocus.mjs';
import { envLockState } from '../shared/envLocks.mjs';
import { padPreviewSvg } from './padPreview.js';
import { sounds, setSoundEnabled } from './sounds.js';

const el = (id) => document.getElementById(id);
const gs = window.groundStation || null;

const gate = el('gate');
const screens = [...document.querySelectorAll('.setup-screen')];
const radioLog = el('radioLog');
const navBack = el('navBack'), navNext = el('navNext'), setupNav = el('setupNav');
const lightsEl = el('lights');

let settings = null;
let envOverridden = {};
let envEffective = {}; // effective values for env-locked ⚙ controls (audit C3)
let credential = null; // non-secret hotspot-credential status from main (audit E1)
let mode = 'solo';
let step = 'garage';
let lightsRunning = false;

// ---------- team radio ----------
function radio(msg) {
  const div = document.createElement('div');
  div.className = 'radio-msg';
  div.textContent = msg;
  radioLog.prepend(div);
  while (radioLog.children.length > 3) radioLog.lastChild.remove();
  sounds.radioOpen();
}

// ---------- IPC rejection guard (audit N1) ----------
// EXPECTED operational failures come back from main as {ok:false,...} results
// and are rendered by the callers; a REJECTED invoke (handler threw, IPC
// broke) is unexpected. This guard is deliberately narrow — one IPC call per
// use — so it cannot conceal defects in surrounding renderer logic: the real
// error goes to the console (once per channel; some callers poll every 1-2 s)
// and the caller gets a fixed, credential-free fallback to render.
const ipcWarned = new Set();
async function ipc(promise, fallback, label, { detail = true } = {}) {
  try {
    return await promise;
  } catch (err) {
    if (!ipcWarned.has(label)) {
      ipcWarned.add(label);
      // detail:false marks channels whose ARGUMENTS carry credentials
      // (join/hotspot passwords): a main-side rejection message must never
      // tow an echoed secret into the renderer log.
      const msg = detail ? (err && err.message ? err.message : err) : '(detail withheld — call carries credentials)';
      console.error(`[setup] ${label} failed:`, msg);
    }
    return fallback;
  }
}

// ---------- persistence ----------
async function save(patch) {
  if (!gs) return settings;
  try {
    settings = await gs.setSettings(patch);
  } catch {
    // Keep the in-memory settings and keep the flow usable; the failure is
    // visible on the team radio. Fixed text only — the patch (and thus a
    // rejection that echoes it) can carry the hotspot password.
    console.error('[setup] settings:set failed (detail withheld — patch may carry credentials)');
    radio('SETTINGS SAVE FAILED — CHANGES MAY NOT PERSIST');
  }
  return settings;
}

// ---------- step switching ----------
const enterHooks = { pitwall: enterPitwall, seatfit: enterSeatfit, grid: enterGrid };
const leaveHooks = { pitwall: leavePitwall, seatfit: leaveSeatfit, grid: leaveGrid };

function showStep(next) {
  if (leaveHooks[step]) leaveHooks[step]();
  step = next;
  for (const s of screens) s.classList.toggle('active', s.dataset.step === step);
  navBack.classList.toggle('hidden', step === 'garage');
  navNext.classList.toggle('hidden', step === 'garage' || step === 'grid');
  setupNav.classList.toggle('hidden', step === 'garage');
  if (enterHooks[step]) enterHooks[step]();
}

navNext.addEventListener('click', () => {
  sounds.uiTick();
  const n = nextStep(step, mode);
  if (n !== LIGHTS) showStep(n);
});
navBack.addEventListener('click', () => { sounds.uiTick(); showStep(prevStep(step, mode)); });
// Enter advances the step ONLY from a non-interactive focus (audit M1):
// Enter while typing in a field or on a focused button belongs to that
// control — advancing then would discard what the user was doing.
addEventListener('keydown', makeEnterToAdvance({
  canAdvance: () => !gate.classList.contains('hidden') && !navNext.classList.contains('hidden'),
  advance: () => navNext.click(),
}));

// ---------- GARAGE ----------
for (const card of document.querySelectorAll('.modecard')) {
  card.addEventListener('click', async () => {
    mode = card.dataset.mode;
    await save({ fpvMode: mode });
    radio(mode === 'solo' ? 'GARAGE: DESKTOP FPV SESSION' : 'GARAGE: IPHONE COCKPIT SESSION');
    showStep(nextStep('garage', mode));
  });
}

// ---------- PIT WALL ----------
const netTabs = el('netTabs'), paneJoin = el('paneJoin'), paneHotspot = el('paneHotspot'), paneGuide = el('paneGuide');
const netList = el('netList'), netPwRow = el('netPwRow'), netPassword = el('netPassword'), netSecNote = el('netSecNote');
const joinStatus = el('joinStatus'), hsStatus = el('hsStatus'), guideStatus = el('guideStatus');
const joinDetail = el('joinDetail'), joinDetailText = el('joinDetailText');
const hsDetail = el('hsDetail'), hsDetailText = el('hsDetailText'), hsReverify = el('hsReverify');
const addrInput = el('iphoneAddr'), addrSuggest = el('addrSuggest'), addrStatus = el('addrStatus'), addrNote = el('addrNote');
const adapterRow = el('adapterRow'), adapterSelect = el('adapterSelect');
const adapterHint = el('adapterHint'), adapterStatus = el('adapterStatus');
const adapterDetail = el('adapterDetail'), adapterName = el('adapterName'), adapterChip = el('adapterChip');
const adapterNet = el('adapterNet'), adapterDesc = el('adapterDesc');
const adapterPick = el('adapterPick'), adapterPickLabel = el('adapterPickLabel');
const adapterSelNote = el('adapterSelNote'), adapterRescan = el('adapterRescan');
const hsSsidInput = el('hsSsid'), hsPassInput = el('hsPass');
const hsStartBtn = el('hsStart'), hsStopBtn = el('hsStop');
const hsHint = el('hsHint'), hsRecheck = el('hsRecheck'), hsCredNote = el('hsCredNote');
let adapterMode = 'missing'; // wifiView card mode; only 'select' offers a picker
let adapterRes = null;       // last listInterfaces result — re-render on picker change without re-querying netsh
let netKind = 'join';
let joinTarget = null;
let hintTimer = null;
let caps = null;
let hotspotSnap = null;  // last lifecycle snapshot from MAIN — a mirror, never renderer-invented state
let pitwallEpoch = 0;    // bumped on PIT WALL entry/leave: stale async completions must not touch the DOM

function showNetTab(kind) {
  netKind = kind;
  paneJoin.classList.toggle('hidden', kind !== 'join');
  paneHotspot.classList.toggle('hidden', kind !== 'hotspot');
  paneGuide.classList.toggle('hidden', kind !== 'guide');
  for (const b of netTabs.querySelectorAll('[data-nettab]')) {
    b.classList.toggle('on', b.dataset.nettab === kind);
  }
}
netTabs.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-nettab]');
  if (tab) { sounds.uiTick(); showNetTab(tab.dataset.nettab); }
});

async function enterPitwall() {
  pitwallEpoch += 1;
  const epoch = pitwallEpoch;
  addrInput.value = settings?.iphoneAddr || '';
  hsSsidInput.value = settings?.network?.hotspot?.ssid || 'W17-GRID';
  hsPassInput.value = settings?.network?.hotspot?.password || generatePassword();
  renderCredNote();
  // wifi:capabilities answers instantly now (platform + sim flag only): the
  // slow WinRT hotspot probe moved to its own non-blocking channel (audit N3),
  // so PIT WALL renders and stays usable while that probe runs.
  const c = gs ? await ipc(gs.wifiCapabilities(), null, 'wifi:capabilities') : { canScan: false };
  // Left PIT WALL while the capability check was in flight (audit D2): the
  // DOM writes and the poll timer below belong to whatever step is active
  // now — a stale continuation must not leak an interval or touch the page.
  if (epoch !== pitwallEpoch) return;
  if (!c) {
    // Capability check rejected: fall to guide mode, but say why — a silent
    // guide pane would misreport a broken IPC as "not Windows". Leaving and
    // re-entering PIT WALL retries the check.
    caps = { canScan: false, sim: false };
    radio('PIT WALL: NETWORK CAPABILITY CHECK FAILED — GUIDE MODE ONLY');
  } else {
    caps = c;
  }
  // Dev preview (W17_WIFI_SIM): canned netsh output — flag it so a simulated
  // network step can never be mistaken for the real OS layer.
  el('wifiSimTag').classList.toggle('hidden', !caps.sim);
  netTabs.classList.toggle('hidden', !caps.canScan);
  await refreshAdapters();
  if (epoch !== pitwallEpoch) return; // left while the adapter listing ran
  if (!caps.canScan) {
    showNetTab('guide');
  } else {
    showNetTab(settings?.network?.kind === 'hotspot' ? 'hotspot' : 'join');
    rescan();
  }
  // Hotspot pane: pull the authoritative lifecycle snapshot (instant — it
  // must reflect a hotspot left LIVE on a previous visit), then kick the
  // capability probe WITHOUT awaiting it. The pane shows CHECKING HOTSPOT
  // SUPPORT… until the probe lands (cached after the first run).
  if (caps.canScan && gs && gs.hotspotState) {
    // adopt (not assign): a pushed snapshot newer than this pull — or a
    // usable one held from a previous visit when the pull itself rejects —
    // must not be clobbered by a stale/absent pull result.
    adoptHotspotSnap(await ipc(gs.hotspotState(), null, 'wifi:hotspot-state'));
    if (epoch !== pitwallEpoch) return; // cache adopted; DOM/timers stay with the active step
    renderHotspotPane();
    kickHotspotProbe(false);
  }
  hintTimer = setInterval(pollAddrHint, 2000);
  pollAddrHint();
}

// ADAPTER row — always visible on PIT WALL: on Windows/sim it confirms which
// WLAN adapter scan/join will use, becomes a picker when several exist
// (built-in vs USB dongle; the choice pins netsh to that interface), and
// says so with a hint when none is detected or listing failed; in guide mode
// it says where adapter selection lives. All decisions live in
// shared/wifiView.mjs; this only renders the returned state.
async function refreshAdapters() {
  // guide mode: no netsh on this OS, so host interfaces are NEVER listed as
  // WLAN adapters (the {guide:true} sentinel). Otherwise a rejected listing
  // renders the 'failed' card (wifiView.mjs) with RESCAN as the retry, same as
  // a netsh {ok:false}. The raw result is cached so a picker change can
  // re-render the card header without another netsh round-trip.
  if (!caps?.canScan) {
    adapterRes = { guide: true };
    renderAdapterCard(adapterRowState(adapterRes, settings?.network?.adapter));
    return;
  }
  // Prefer the live monitor's current snapshot (same main-process authority
  // that pushes 'adapter-state', so the card and the live pushes agree from the
  // first paint). Fall back to a direct listInterfaces pull when the monitor
  // channel is absent (older preload / DOM-test harness) or has not polled yet.
  let res = null;
  if (gs && gs.adapterState) {
    const snap = await ipc(gs.adapterState(), null, 'wifi:adapter-state');
    if (snap) adoptAdapterSnap(snap);
    if (snap && snap.ok !== null && snap.ok !== undefined) res = { ok: snap.ok, ifaces: snap.ifaces || [], error: snap.error };
  }
  if (!res) {
    res = gs && gs.wifiInterfaces
      ? await ipc(gs.wifiInterfaces(), { ok: false, error: 'adapter listing unavailable' }, 'wifi:interfaces')
      : { ok: true, ifaces: [] };
  }
  adapterRes = res;
  renderAdapterCard(adapterRowState(adapterRes, settings?.network?.adapter));
}

// Renders the ADAPTER card from a wifiView state object. All decisions live in
// shared/wifiView.mjs; this only shows/hides blocks and fills text. The card is
// always visible on PIT WALL; the sub-blocks appear per mode.
function renderAdapterCard(state) {
  adapterMode = state.mode;
  adapterRow.classList.remove('hidden');
  // Left accent: teal = a choice exists (interactive); amber = warning/missing;
  // neutral = readonly single adapter.
  adapterRow.classList.toggle('interactive', state.mode === 'select' && !state.savedMissing);
  adapterRow.classList.toggle('warn', state.mode === 'missing' || state.mode === 'failed' || !!state.savedMissing);

  // Adapter detail — the single adapter, the selected one, or (amber) the
  // vanished saved adapter. SSID/signal show only while connected.
  const d = state.detail || null;
  adapterDetail.classList.toggle('hidden', !d);
  if (d) {
    adapterName.textContent = d.name;
    adapterName.classList.toggle('warn', d.chip.tone === 'missing');
    adapterChip.textContent = d.chip.text;
    adapterChip.className = `statechip ${d.chip.tone}`; // sets tone + clears 'hidden'
    const net = d.connected && d.ssid
      ? `${d.ssid}${d.signalPct != null ? ` · ${d.signalPct}%` : ''}`
      : '';
    adapterNet.textContent = net;
    adapterNet.classList.toggle('hidden', !net);
    adapterDesc.textContent = d.description || '';
    adapterDesc.classList.toggle('hidden', !d.description);
  }

  // SELECTED indication — the single-adapter readonly confirmation only.
  adapterSelNote.classList.toggle('hidden', !state.selectedNote);

  // Picker — a native <select> (SELECT/CHANGE ADAPTER); only in select mode.
  const isSelect = state.mode === 'select';
  adapterPick.classList.toggle('hidden', !isSelect);
  if (isSelect) {
    adapterPickLabel.textContent = state.selectorLabel;
    adapterSelect.replaceChildren(...state.options.map((o) => {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      if (o.disabled) opt.disabled = true;
      return opt;
    }));
    adapterSelect.value = state.selected;
  } else {
    adapterSelect.replaceChildren();
  }

  // Headline for guide/failed/missing (there is no adapter to detail).
  adapterStatus.classList.toggle('hidden', !state.status);
  adapterStatus.classList.toggle('warn', !!state.warn);
  adapterStatus.textContent = state.status || '';

  adapterHint.textContent = state.hint || '';
  adapterHint.classList.toggle('hidden', !state.hint);

  // Card-level RESCAN for the degraded states; the join-pane RESCAN would be
  // redundant there (and points at a network list you can't populate without a
  // working adapter), so it hides while this one shows.
  adapterRescan.classList.toggle('hidden', !state.rescan);
  el('netRescan').classList.toggle('hidden', !!state.rescan);
}

// Single adapter passes undefined — netsh's default interface, the exact
// pre-picker behavior; only an actual picker choice pins the interface.
function chosenAdapter() {
  return adapterMode === 'select' ? (adapterSelect.value || undefined) : undefined;
}

// True while the picker demands a decision: the SAVED adapter was not
// detected, so nothing is selected yet. Scan/join must not proceed then —
// falling through to netsh's default interface would silently use an adapter
// the user never chose (audit M2/Q7).
function adapterUnresolved() {
  return adapterMode === 'select' && !adapterSelect.value;
}

adapterSelect.addEventListener('change', () => {
  sounds.uiTick();
  const value = adapterSelect.value;
  save({ network: { adapter: value } });
  // Reflect the newly chosen adapter in the card immediately (its connection
  // state comes straight from the cached listing, never merged across
  // adapters), then rescan pinned to it.
  if (adapterRes) renderAdapterCard(adapterRowState(adapterRes, value));
  rescan();
});

function leavePitwall() {
  pitwallEpoch += 1;
  clearInterval(hintTimer);
  hintTimer = null;
  const patch = {
    iphoneAddr: isValidIpv4(addrInput.value.trim()) ? addrInput.value.trim() : '',
    network: {
      kind: netKind,
      hotspot: { ssid: el('hsSsid').value.trim(), password: el('hsPass').value },
    },
  };
  save(patch);
}

function generatePassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  const rnd = new Uint32Array(10);
  crypto.getRandomValues(rnd);
  for (const r of rnd) out += chars[r % chars.length];
  return out;
}

// Hotspot credential status note (audit E1). Truthful, non-secret: the note
// only reflects the STORAGE state main reports — it never shows the password.
function credNoteText(c) {
  if (!c) return '';
  switch (c.state) {
    case 'session-only':
    case 'unavailable':
      return 'Secure storage is unavailable here — the hotspot password is kept for this session only and will not be saved when you close the app.';
    case 'undecryptable':
      return 'The saved hotspot password could not be read on this machine — enter it again to use the hotspot.';
    case 'migration-failed':
      return 'The saved hotspot password could not be secured — it will be re-secured next time it is saved.';
    default:
      return '';
  }
}

function renderCredNote() {
  const text = credNoteText(credential);
  hsCredNote.textContent = text;
  hsCredNote.classList.toggle('hidden', !text);
}

// Re-pull the non-secret credential status after a save that (re)sets the
// password, so e.g. an "enter it again" note clears once the credential is
// secured. No secret rides this — only the status field.
async function refreshCredential() {
  if (!gs || !gs.getSettings) return;
  const r = await ipc(gs.getSettings(), null, 'settings:get:cred');
  if (r && r.credential) { credential = r.credential; renderCredNote(); }
}

async function rescan() {
  if (!gs || !caps?.canScan) return;
  if (adapterUnresolved()) {
    netList.replaceChildren();
    joinStatus.textContent = 'SELECT AN ADAPTER — the saved adapter was not detected';
    return;
  }
  joinStatus.textContent = 'SCANNING…';
  const res = await ipc(
    gs.wifiScan({ iface: chosenAdapter() }),
    { ok: false, error: 'scan did not complete — RESCAN to retry' },
    'wifi:scan',
  );
  const nets = res.networks || [];
  joinStatus.textContent = scanStatusText(res);
  netList.replaceChildren(...nets.map((n) => {
    const row = document.createElement('button');
    row.className = 'netrow';
    row.innerHTML = `<b></b><span class="sig"></span><span class="known"></span>`;
    row.querySelector('b').textContent = n.ssid;
    row.querySelector('.sig').textContent = `${n.signalPct ?? '--'}%`;
    // Right-aligned tag: KNOWN for a saved profile, else the normalized
    // security kind (audit B3) — so the user sees what a row needs before
    // clicking it, never a raw localized auth string.
    row.querySelector('.known').textContent = networkBadge(n);
    row.addEventListener('click', () => selectNetwork(n, row));
    return row;
  }));
}
// RESCAN — either the card's degraded-state button or the join pane's — always
// re-detects adapters first, so plugging the dongle in while sitting on PIT
// WALL must not require leaving the step.
async function rescanAll() { sounds.uiTick(); await refreshAdapters(); rescan(); }
el('netRescan').addEventListener('click', rescanAll);
adapterRescan.addEventListener('click', rescanAll);

// Selecting a network branches on the normalized security kind via joinPlan
// (shared/wifiView.mjs), never on localized prose (audit B3 / Q3):
//   reject   — WPA3-only / enterprise: a controlled message, no join.
//   join     — a saved secured profile: connect directly (no password prompt).
//   open     — OPEN NETWORK warning + JOIN, password field hidden (no key).
//   password — a secured network with no saved profile: prompt for the key.
function showSecNote(text, warn, diag) {
  netSecNote.textContent = text;
  netSecNote.classList.remove('hidden');
  netSecNote.classList.toggle('warn', !!warn);
  // The sanitized raw auth/enc (unknown-security rejects) rides a tooltip for
  // diagnostics — never the primary message, never raw localized prose on screen.
  if (diag) netSecNote.title = diag; else netSecNote.removeAttribute('title');
}
// Show/hide an expandable DETAILS box (2E). Lines is a string or array; empty
// hides and collapses the box so a stale detail can never linger under a new
// operation's status line. Never a secret — callers pass already-redacted text.
function showErrDetail(detailsEl, textEl, lines) {
  const text = (Array.isArray(lines) ? lines.filter(Boolean).join('\n') : (lines || '')).trim();
  if (!detailsEl || !textEl) return;
  textEl.textContent = text;
  detailsEl.classList.toggle('hidden', !text);
  if (!text) detailsEl.removeAttribute('open');
}

function selectNetwork(n, row) {
  sounds.uiTick();
  for (const r of netList.children) r.classList.toggle('on', r === row);
  // Reset the join controls before applying the plan.
  netSecNote.classList.add('hidden');
  netPwRow.classList.add('hidden');
  netPassword.classList.remove('hidden');
  joinStatus.textContent = '';
  joinStatus.classList.remove('live');
  showErrDetail(joinDetail, joinDetailText, '');   // 2E: clear stale detail on a new selection
  const plan = joinPlan(n);
  joinTarget = plan.action === 'reject' ? null : n;
  if (plan.action === 'reject') { showSecNote(plan.reject, true, plan.diag); return; }
  if (plan.action === 'join') { doJoin(); return; }
  if (plan.action === 'open') {
    // OPEN NETWORK: warn that it is unencrypted, hide the password field, and
    // let the user confirm with JOIN. The manager installs an open profile
    // when there is no saved one; no credential is entered or persisted.
    showSecNote(plan.warn, true);
    netPassword.classList.add('hidden');
    netPwRow.classList.remove('hidden');
    return;
  }
  // password: a caution note for transition / unrecognized kinds, else none.
  if (plan.note) showSecNote(plan.note, false);
  netPwRow.classList.remove('hidden');
  netPassword.value = '';
  netPassword.focus();
}

async function doJoin() {
  if (!joinTarget) return;
  if (adapterUnresolved()) {
    joinStatus.textContent = 'SELECT AN ADAPTER — the saved adapter was not detected';
    return;
  }
  const ssid = joinTarget.ssid;
  const plan = joinPlan(joinTarget);
  joinStatus.textContent = `JOINING ${ssid}…`;
  showErrDetail(joinDetail, joinDetailText, ''); // 2E: a new attempt clears the previous error's detail
  // The rejection fallback message is FIXED text: no netsh output, and never
  // anything derived from the password. The normalized security + known flags
  // let main pick the right profile (open/WPA2/saved). JOIN/Enter retries.
  const res = await ipc(
    gs.wifiJoin({
      ssid,
      password: plan.action === 'password' ? netPassword.value : undefined,
      iface: chosenAdapter(),
      security: joinTarget.security,
      known: !!joinTarget.known,
    }),
    { ok: false, error: 'JOIN FAILED — the network layer did not respond; retry' },
    'wifi:join',
    { detail: false },
  );
  if (res.ok) {
    netPwRow.classList.add('hidden');
    netSecNote.classList.add('hidden');
    joinStatus.textContent = `CONNECTED: ${ssid}`;
    joinStatus.classList.add('live');
    showErrDetail(joinDetail, joinDetailText, ''); // success clears any prior detail
    radio(`PIT WALL: NETWORK CONFIRMED — ${ssid}`);
    save({ network: { kind: 'join', ssid } });
  } else {
    // 2E: a terse summary in the status line (which now wraps and is width-
    // bounded, so it can never overlap), the full redacted reason in the
    // expandable DETAILS box. The classifier maps the manager's `kind`
    // (adapter-missing / connect-failed / timeout / …) to the headline.
    const c = classifyJoinError(res);
    joinStatus.textContent = c.summary;
    joinStatus.classList.remove('live');
    showErrDetail(joinDetail, joinDetailText, c.hasDetail ? c.detail : '');
  }
}
el('netJoinBtn').addEventListener('click', doJoin);
// Enter in the password field = JOIN (approved M1 behavior). The global
// Enter-advance handler already ignores editable targets; this makes Enter
// submit the join instead of doing nothing.
netPassword.addEventListener('keydown', makeEnterToSubmit(doJoin));

// ---------- hotspot lifecycle mirror (audit B1/N3) ----------
// The MAIN process owns the runtime hotspot state (main/hotspotLifecycle.js);
// this pane renders exclusively from its snapshots via hotspotPaneState
// (shared/wifiView.mjs). The click handlers only issue requests — STARTING…,
// LIVE, failures, and the quit dialog's stop attempts all arrive as pushed
// snapshots, so navigating away and back can never fabricate a state.

function renderHotspotPane() {
  const v = hotspotPaneState(hotspotSnap);
  hsStatus.textContent = v.status;
  hsStatus.classList.toggle('live', v.live);
  hsHint.textContent = v.hint;
  hsHint.classList.toggle('hidden', !v.hint);
  hsStartBtn.disabled = !v.start;
  hsStopBtn.disabled = !v.stop;
  hsSsidInput.disabled = !v.inputs;
  hsPassInput.disabled = !v.inputs;
  hsRecheck.classList.toggle('hidden', !v.recheck);
  // 2D: the DHCP/ICS readiness reasons go in the expandable DETAILS box (the
  // hint carries just the first/headline reason); REVERIFY re-runs the local
  // check on the live hotspot.
  showErrDetail(hsDetail, hsDetailText, v.detail);
  if (hsReverify) hsReverify.classList.toggle('hidden', !v.reverify);
}

if (hsReverify) {
  hsReverify.addEventListener('click', async () => {
    sounds.uiTick();
    if (!gs || !gs.hotspotVerify) return;
    // The authoritative readiness result arrives as a pushed 'hotspot-state'
    // snapshot (VERIFYING… → verified/degraded); this call only triggers it.
    await ipc(gs.hotspotVerify(), null, 'wifi:hotspot-verify');
  });
}

// Snapshot adoption gate for BOTH the pull and the push paths: snapshots
// carry a monotonic `seq` from the main-process authority, and anything older
// than the newest already held is dropped. Electron does not guarantee that
// state pushes arrive in emit order (the sim acceptance pass caught a
// 'probing' push landing AFTER its own completion snapshot, wedging the pane
// on CHECKING…) — causal order comes from the authority, never from arrival.
function adoptHotspotSnap(snap) {
  if (!snap) return false;
  if (hotspotSnap && typeof hotspotSnap.seq === 'number' && typeof snap.seq === 'number'
      && snap.seq < hotspotSnap.seq) return false;
  hotspotSnap = snap;
  return true;
}

// Pushed on every lifecycle/probe change. Off PIT WALL only the cache is
// updated — the DOM belongs to whatever step is active (stale-DOM guard);
// re-entering PIT WALL re-pulls and re-renders the current truth.
if (gs && gs.onHotspotState) {
  gs.onHotspotState((snap) => {
    if (!adoptHotspotSnap(snap)) return;
    if (step === 'pitwall') renderHotspotPane();
  });
}

// ---------- live adapter monitor mirror (2B) ----------
// The MAIN process watches WLAN adapters for the whole app lifetime and pushes
// a snapshot when membership/connection changes; this keeps the ADAPTER card
// live while PIT WALL is open (a dongle plugged in now appears without leaving
// the page; a pulled dongle is removed / marked NOT DETECTED). Snapshots carry
// a monotonic seq (out-of-order pushes dropped). Selection is NEVER auto-
// switched: adapterRowState invalidates a vanished saved adapter to selected:''
// and the user re-picks — the card re-render alone enforces that here.
let adapterSeq = -1;
function adoptAdapterSnap(snap) {
  if (!snap || snap.ok === null || snap.ok === undefined) return false; // not-yet-polled sentinel
  if (typeof snap.seq === 'number') {
    if (snap.seq <= adapterSeq) return false;
    adapterSeq = snap.seq;
  }
  return true;
}
if (gs && gs.onAdapterState) {
  gs.onAdapterState((snap) => {
    if (!adoptAdapterSnap(snap)) return;
    if (!caps?.canScan) return; // guide mode never lists host interfaces as WLAN adapters
    adapterRes = { ok: snap.ok, ifaces: snap.ifaces || [], error: snap.error };
    if (step === 'pitwall') renderAdapterCard(adapterRowState(adapterRes, settings?.network?.adapter));
  });
}

// The probe result normally lands via the state push; awaiting it here only
// backstops an IPC rejection (no push will ever come) with a controlled
// failed state instead of a pane stuck on CHECKING… (audit N3). Duplicate
// suppression lives in main (concurrent probes share one PowerShell run;
// completed results are cached) — re-entering PIT WALL is free.
async function kickHotspotProbe(refresh) {
  if (!gs || !gs.hotspotProbe) return;
  const epoch = pitwallEpoch;
  const res = await ipc(gs.hotspotProbe({ refresh }), { status: 'failed' }, 'wifi:hotspot-probe');
  if (epoch !== pitwallEpoch || step !== 'pitwall') return; // stale completion: leave the DOM alone
  // Only synthesize the failed overlay when the AUTHORITY never delivered a
  // result (IPC rejected). It is a renderer-local fallback layered on the
  // freshest adopted snapshot, keeping its seq so a genuine newer push still
  // wins through adoptHotspotSnap; if main already reported a probe status,
  // that authoritative value stands.
  if (res && res.status === 'failed' && hotspotSnap && hotspotSnap.probe?.status !== 'failed') {
    hotspotSnap = { ...hotspotSnap, probe: { status: 'failed' } };
    renderHotspotPane();
  }
}

hsStartBtn.addEventListener('click', async () => {
  sounds.uiTick();
  const ssid = hsSsidInput.value.trim();
  const password = hsPassInput.value;
  // Fixed rejection fallback — no output text, never the password. Everything
  // non-rejected is rendered from the pushed lifecycle snapshots.
  const res = await ipc(
    gs.hotspotStart({ ssid, password }),
    { ok: false, rejected: true },
    'wifi:hotspot-start',
    { detail: false },
  );
  if (res.ok) {
    radio(`PIT WALL: HOTSPOT ${res.ssid} IS LIVE`);
    await save({ network: { kind: 'hotspot', hotspot: { ssid, password } } });
    refreshCredential();
  } else if (res.rejected && step === 'pitwall') {
    hsStatus.textContent = 'HOTSPOT FAILED — the network layer did not respond; retry';
  }
});

hsStopBtn.addEventListener('click', async () => {
  sounds.uiTick();
  const res = await ipc(
    gs.hotspotStop(),
    { ok: false, rejected: true },
    'wifi:hotspot-stop',
  );
  if (res.ok && !res.noop) {
    radio('PIT WALL: HOTSPOT STOPPED');
  } else if (res.rejected && step === 'pitwall') {
    hsStatus.textContent = 'HOTSPOT STOP FAILED — the network layer did not respond; retry';
  }
});

hsRecheck.addEventListener('click', () => { sounds.uiTick(); kickHotspotProbe(true); });

el('guideVerify').addEventListener('click', async () => {
  sounds.uiTick();
  const st = await ipc(gs.wifiStatus(), null, 'wifi:status');
  if (!st || st.ok === false) {
    // Distinct from "not detected": the check itself failed (IPC rejection or
    // a netsh error reported by the manager). VERIFY retries.
    guideStatus.textContent = 'WIFI CHECK FAILED — VERIFY to retry';
    return;
  }
  const ips = (st.adapterIps || []).map((a) => `${a.name} ${a.addr}`).join(' · ');
  guideStatus.textContent = `${st.connected ? `WIFI: ${st.ssid}` : 'WIFI: not detected'}${ips ? ` — ${ips}` : ''}`;
});

async function pollAddrHint() {
  if (!gs) return;
  // Background 2 s poll: a rejection just means "no suggestion this tick".
  const hint = await ipc(gs.getAddrHint(), null, 'setup:addr-hint');
  const addr = suggestionFromHint(hint);
  const current = addrInput.value.trim();
  if (addr && addr !== current) {
    addrSuggest.textContent = `USE ${addr} · from HUD traffic`;
    addrSuggest.classList.remove('hidden');
    addrSuggest.onclick = () => { addrInput.value = addr; addrSuggest.classList.add('hidden'); sounds.uiTick(); };
  } else {
    addrSuggest.classList.add('hidden');
  }
}

el('addrCheck').addEventListener('click', async () => {
  sounds.uiTick();
  const addr = addrInput.value.trim();
  addrNote.classList.add('hidden');
  if (!isValidIpv4(addr)) { addrStatus.textContent = 'INVALID IP'; return; }
  addrStatus.textContent = 'PINGING…';
  const res = await ipc(gs.probeHost(addr), { ok: false, status: 'command-error', error: 'check failed — retry' }, 'setup:probe-host');
  // The line is honest per status class (audit B4); a reachable result says
  // "network path only". On success also show the full path-only caveat, so a
  // green check can never be read as "the iPhone HUD is receiving" (decision C4).
  addrStatus.textContent = probeStatusLine(res);
  if (res.ok) { addrNote.textContent = PATH_ONLY_NOTE; addrNote.classList.remove('hidden'); }
});

// ---------- SEAT FIT ----------
const padList = el('padList'), presetRow = el('presetRow'), padPreview = el('padPreview');
const ctlSource = el('ctlSource'), ctlMeta = el('ctlMeta');
const camModes = el('camModes'), camRequested = el('camRequested'), camActive = el('camActive');
let padTimer = null;
// Session-stable device selection (task §3). `chosenPadKey` is gamepadKey (slot
// index + id) and lives only for this session — '' means "auto: first slot". We
// do NOT restore it from settings: across a restart the OS may reassign the slot,
// and identical devices share an id, so a persisted key cannot honestly pin the
// same unit. `persistedPadId` is the model id kept only for layout auto-detect
// and for the live-HUD's best-effort model-id matching / persistence.
let chosenPadKey = '';
let persistedPadId = '';
let chosenPreset = DEFAULT_PRESET;
let presetManual = false; // a pill click this visit beats auto-detection

function enterSeatfit() {
  persistedPadId = settings?.controller?.id || '';
  chosenPadKey = '';
  chosenPreset = settings?.controller?.preset || DEFAULT_PRESET;
  presetManual = false;
  presetRow.replaceChildren(...Object.entries(PRESETS).map(([key, p]) => {
    const b = document.createElement('button');
    b.className = 'pill';
    b.textContent = p.label;
    b.dataset.preset = key;
    b.addEventListener('click', () => { chosenPreset = key; presetManual = true; applyChoice(); sounds.uiTick(); });
    return b;
  }));
  renderCameraMode();
  applyChoice();
  seatfitTick();                              // paint device list + mirror at once
  padTimer = setInterval(seatfitTick, 250);   // then keep it live (hot-plug/disconnect)
}

// CAMERA MODE section (task §4). Rendered from the pure model: Manual is the only
// selectable/requested mode; Head Tracking is VISIBLE but LOCKED. The cards are
// DISPLAY-ONLY — a locked card carries no handler at all, and the selectable one
// only re-renders the local view. Neither can emit a control request: there is
// no mode-request preload method (pinned by test/ipcSurface.test.js), so `gs` is
// never touched here. AVAILABLE/REQUESTED and ACTIVE AUTHORITY are shown as
// separate lines and never conflated: the requested line is this setup's default,
// while active authority is NOT REPORTED BY MAPPER — this viewer does not observe
// which source the mapper selected, so it never fabricates one (task §1A). No
// activeAuthority is passed in, so the model reports it unknown.
let requestedCameraMode = 'manual';
function renderCameraMode() {
  const view = cameraModeView({ requested: requestedCameraMode });
  requestedCameraMode = view.requested;
  camRequested.textContent = view.requestedLabel;
  camActive.textContent = view.activeAuthorityLabel;
  // Style the active-authority value as unknown (muted) unless a real source
  // reports it, so "NOT REPORTED BY MAPPER" never reads as a confirmed value.
  camActive.classList.toggle('unreported', !view.activeAuthorityReported);
  camModes.replaceChildren(...view.modes.map((m) => {
    const card = document.createElement(m.locked ? 'div' : 'button');
    card.className = `cammode${m.selected ? ' on' : ''}${m.locked ? ' locked' : ''}`;
    card.dataset.mode = m.key;
    const head = document.createElement('b');
    head.textContent = m.label;
    card.appendChild(head);
    if (m.lock) {
      const lock = document.createElement('span');
      lock.className = 'camlock';
      lock.textContent = m.lock;
      card.appendChild(lock);
    }
    const help = document.createElement('span');
    help.className = 'camhelp';
    help.textContent = m.help;
    card.appendChild(help);
    // Only the selectable card gets a handler, and it does not touch `gs`: it just
    // sets the requested mode locally and re-renders. Coerced back to a selectable
    // mode by the model, so it can never land on a locked mode.
    if (!m.locked) {
      card.addEventListener('click', () => { requestedCameraMode = m.key; renderCameraMode(); sounds.uiTick(); });
    }
    return card;
  }));
}

// Auto-suggest the layout from the pad type. Loses to: a manual pill click
// this visit, and a persisted choice saved for this exact pad. Unrecognized
// pads keep the current layout.
function maybeAutoPreset(padId) {
  if (presetManual || !padId) return;
  if (persistedPadId === padId) return;
  const detected = detectPresetFromId(padId);
  if (detected) chosenPreset = detected;
}

// Model id (NOT the session key) of the pad SEAT FIT currently follows — for the
// live-HUD selection (setControllerChoice → selectGamepad matches by model id)
// and for persistence. Falls back to the persisted id when the chosen device is
// absent: the live HUD keeps its own best-effort model-id matching, a documented
// limitation for identical devices (docs/camera_aim_display_semantics.md §5).
function selectedModelId() {
  const pads = dedupeGamepads(navigator.getGamepads ? navigator.getGamepads() : []);
  const p = resolveSelectedPad(pads, { chosenKey: chosenPadKey });
  return p ? p.id : persistedPadId;
}

function leaveSeatfit() {
  clearInterval(padTimer);
  padTimer = null;
  // Persist the MODEL id only (never the session key): identical devices are not
  // distinguishable across restarts without a stable hardware identifier (§3).
  save({ controller: { id: selectedModelId(), preset: chosenPreset } });
}

function applyChoice() {
  setControllerChoice({ id: selectedModelId(), preset: chosenPreset });
  for (const b of presetRow.children) b.classList.toggle('on', b.dataset.preset === chosenPreset);
  padPreview.innerHTML = padPreviewSvg(chosenPreset);
}

// Position a stick's live dot inside its SVG well from a -1..1 (x, y). Neutral
// (0, 0) sits exactly on the drawn centre marker; a padless read passes 0/0 so a
// disconnect returns the dot to neutral (never a stale deflection).
function placeStickDot(side, x, y) {
  const dot = padPreview.querySelector(`[data-stick="${side}"]`);
  if (!dot) return;
  const cx0 = Number(dot.dataset.cx), cy0 = Number(dot.dataset.cy);
  const spread = 18; // well radius minus the dot radius, in SVG units
  dot.setAttribute('cx', String(cx0 + x * spread));
  dot.setAttribute('cy', String(cy0 + y * spread));
}

function seatfitTick() {
  // Deduplicate the raw slots for display so one device is one row (a doubled
  // slot reference collapses; two distinct pads — even two identical models in
  // different slots — are both kept).
  const pads = dedupeGamepads(navigator.getGamepads ? navigator.getGamepads() : []);
  // Signature keys on the session identity (slot + id), so a device that moves
  // slots (a reconnect the OS placed elsewhere) rebuilds the list honestly
  // instead of reusing stale rows. Rebuild only when the set changes (avoid
  // killing :hover constantly).
  const sig = pads.map((p) => gamepadKey(p)).join('|');
  if (padList.dataset.sig !== sig) {
    padList.dataset.sig = sig;
    padList.replaceChildren(...(pads.length ? pads.map((p) => {
      const key = gamepadKey(p);
      const b = document.createElement('button');
      b.className = 'netrow';
      b.dataset.padKey = key;                 // session-stable identity (index + id)
      const name = document.createElement('b');
      name.textContent = p.id;
      // The slot makes two IDENTICAL controllers distinguishable on screen — they
      // share an id, so the row text would otherwise be ambiguous (task §3).
      const slot = document.createElement('small');
      slot.className = 'padslot';
      slot.textContent = `SLOT ${typeof p.index === 'number' ? p.index : '?'}`;
      const tag = document.createElement('span');
      tag.className = 'known';
      tag.textContent = 'auto';
      b.append(name, slot, tag);
      // A click selects EXACTLY this session device (index + id) — never its
      // identical peer. seatfitTick() runs immediately for a responsive highlight.
      b.addEventListener('click', () => { chosenPadKey = key; maybeAutoPreset(p.id); applyChoice(); seatfitTick(); sounds.uiTick(); });
      return b;
    }) : [Object.assign(document.createElement('div'), { className: 'netstatus', textContent: 'NO CONTROLLER DETECTED — keyboard fallback stays available' })]));
    // No manual pick yet: the first slot is the auto choice — suggest its layout.
    if (!chosenPadKey && pads[0]) { maybeAutoPreset(pads[0].id); applyChoice(); }
  }
  // Resolve the followed pad from the session key. Auto (no key) → first slot; an
  // explicit choice that has disappeared → null (MISSING), never a silent switch
  // to an identical peer (task §3). Its presence is the single source of the
  // input-source badge AND the live visualization, so the two can never disagree
  // (task §5: no NO CONTROLLER beside a live axis).
  const p = resolveSelectedPad(pads, { chosenKey: chosenPadKey });
  const activeKey = p ? gamepadKey(p) : chosenPadKey;
  for (const b of padList.children) {
    if (b.tagName !== 'BUTTON') continue;
    b.classList.toggle('on', b.dataset.padKey === activeKey);
    const tag = b.querySelector('.known');
    if (tag) tag.style.visibility = !chosenPadKey && pads[0] && b.dataset.padKey === gamepadKey(pads[0]) ? 'visible' : 'hidden';
  }
  const src = inputSourceView({ pad: p });
  ctlSource.textContent = src.label;
  ctlSource.className = `ctlsource ${src.source}`;
  ctlMeta.textContent = p
    ? `${getPreset(chosenPreset).label} PROFILE · TRANSPORT ${transportLabel(p)}`
    : `${getPreset(chosenPreset).label} PROFILE`;

  // Live test strip + stick wells through the chosen preset — proves the mapping
  // instantly. axisValues returns neutral 0s with no pad, so everything centres.
  const m = getPreset(chosenPreset).map;
  const { steer, camPan, camTilt } = axisValues(p, chosenPreset);
  const thr = p && p.buttons[m.throttleBtn] ? p.buttons[m.throttleBtn].value : 0;
  const brk = p && p.buttons[m.brakeBtn] ? p.buttons[m.brakeBtn].value : 0;
  el('tsSteer').style.left = `${50 + steer * 42}%`;
  el('tsThr').style.width = `${(thr * 100).toFixed(0)}%`;
  el('tsBrk').style.width = `${(brk * 100).toFixed(0)}%`;
  el('tsPan').style.left = `${50 + camPan * 42}%`;
  el('tsTilt').style.left = `${50 + camTilt * 42}%`;
  // Stick wells: left = steering (X only), right = camera pan/tilt (X/Y).
  placeStickDot('left', steer, 0);
  placeStickDot('right', camPan, camTilt);
  padPreview.classList.toggle('nopad', !p);
  // Light up pressed buttons in the mapping preview (class toggles only —
  // applyChoice() re-renders the SVG, so no stale highlights survive it).
  // No pad -> empty set -> everything clears, including on disconnect.
  const active = new Set(pressedRoles(p, chosenPreset));
  for (const part of padPreview.querySelectorAll('[data-role]')) {
    part.classList.toggle('on', active.has(part.dataset.role));
  }
}

// ---------- GRID ----------
const checkList = el('checkList'), startBtn = el('startBtn'), startAnywayBtn = el('startAnywayBtn');
let gridTimer = null;
let gridEpoch = 0; // bumped on GRID entry/leave (audit D2): a session apply resolving after the user left must not start the poll timer or touch the DOM
let checks = [];
let probing = false;
const announced = new Set();

// W2-on-GRID preflight wording (audit C5/Q5): iPhone Cockpit mode begins the
// telemetry stream on GRID entry (confirmed IP) so live data can be verified on
// the phone before START; ping only proves the path, the phone screen is the
// real evidence. No new preflight packet type — this is the existing W2 sender.
const GRID_W2_NOTE = 'The iPhone HUD begins receiving telemetry on GRID so you can verify it before START. Ping proves the network path only — live data visible on the iPhone is the final evidence.';

async function enterGrid() {
  gridEpoch += 1;
  const epoch = gridEpoch;
  radio('GRID: RUNNING FINAL CHECKS');
  if (envOverridden.telemetrySource || envOverridden.iphoneBridge || envOverridden.w3) {
    radio('NOTE: SOME SETTINGS ARE LOCKED BY ENV VARS');
  }
  // Desktop FPV never streams to a phone, so the note is iPhone-mode only —
  // desktop mode must not show misleading iPhone wording.
  const gridNote = el('gridNote');
  gridNote.textContent = mode === 'iphone-hud' ? GRID_W2_NOTE : '';
  gridNote.classList.toggle('hidden', mode !== 'iphone-hud');
  const applied = gs ? await ipc(gs.applySession(), null, 'session:apply') : { telemetry: 'none' };
  // Left GRID while the session apply was in flight (audit D2): main has
  // applied the session (idempotent), but the checklist DOM and the 1 s poll
  // interval belong to the active step — a stale continuation leaking that
  // interval would ping/probe forever from the wrong screen.
  if (epoch !== gridEpoch) return;
  if (applied) {
    setW3Chip(!!applied.w3);
    // Replay chip follows the EFFECTIVE telemetry source (audit C2): entering
    // GRID re-applies the session, so this reflects any env-override or ⚙ change.
    setReplayChip(applied.telemetry === 'replay');
    // What's configured, at a glance — verify without stepping back through
    // the flow. (After applySession so the leave-hook saves have settled.)
    el('setupSummary').textContent = summaryLine(settings);
  } else {
    // Session apply rejected: the runtime state is unknown. Say so where the
    // summary belongs and keep the checklist honest (telemetry unconfirmed)
    // instead of leaving GRID blank. Re-entering GRID retries the apply.
    radio('GRID: SESSION APPLY FAILED');
    el('setupSummary').textContent = 'SESSION APPLY FAILED — telemetry state unknown; CHANGE SETUP and return to retry';
  }
  checks = buildChecklist({
    mode,
    telemetryConfigured: !!applied && applied.telemetry !== 'none',
    elrsConfigured: !!(settings && settings.elrsPath),
  });
  renderChecks();
  gridTimer = setInterval(gridTick, 1000);
  gridTick();
}

function leaveGrid() {
  gridEpoch += 1;
  clearInterval(gridTimer);
  gridTimer = null;
  announced.clear();
}

async function gridTick() {
  if (probing || !gs) return;
  probing = true;
  try {
    const hud = hudStatus();
    const results = {
      'video-lock': hud.videoPlaying,
      controller: hud.controllerConnected,
    };
    if (checks.some((c) => c.id === 'telemetry')) {
      results.telemetry = hud.telemetryState === 'live' || hud.telemetryState === 'link-lost';
    }
    if (checks.some((c) => c.id === 'iphone-reachable')) {
      const addr = settings?.iphoneAddr;
      results['iphone-reachable'] = isValidIpv4(addr)
        ? (await ipc(gs.probeHost(addr), { ok: false }, 'setup:probe-host')).ok
        : false;
    }
    const elrsCheck = checks.find((c) => c.id === 'elrs-running');
    if (elrsCheck) {
      // A rejected probe reads as "not confirmed" (red row + hint), the
      // honest state — never as skipped/green.
      const st = await ipc(gs.elrsStatus(), null, 'elrs:status');
      results['elrs-running'] = st ? (st.configured ? st.detected : 'skipped') : false;
    }
    checks = applyProbes(checks, results);
    for (const c of checks) {
      if (c.status === 'ok' && !announced.has(c.id)) {
        announced.add(c.id);
        radio(`${c.label} CONFIRMED`);
      }
    }
    renderChecks();
  } finally {
    probing = false;
  }
}

function renderChecks() {
  const ready = canStart(checks);
  checkList.replaceChildren(...checks.map((c) => {
    const row = document.createElement('div');
    row.className = `checkrow ${c.status}`;
    const label = document.createElement('b');
    label.textContent = c.label;
    const status = document.createElement('span');
    status.textContent = c.status === 'ok' ? 'OK' : c.status === 'fail' ? 'NO' : c.status === 'skipped' ? 'SKIP' : '…';
    row.append(label, status);
    if (c.id === 'elrs-running' && c.status !== 'ok' && settings?.elrsPath) {
      const btn = document.createElement('button');
      btn.className = 'minibtn';
      btn.textContent = 'LAUNCH';
      btn.addEventListener('click', async () => {
        sounds.uiTick();
        const res = await ipc(gs.elrsLaunch(), { ok: false, error: 'launcher unavailable — retry' }, 'elrs:launch');
        radio(res.ok ? 'ELRS CONTROL LAUNCHED' : `ELRS LAUNCH FAILED: ${res.error}`);
      });
      row.append(btn);
    }
    // The fix hint (from checklist.mjs) shows only while the check fails —
    // a red row always says what to do about it.
    if (c.status === 'fail' && c.hint) {
      const hint = document.createElement('div');
      hint.className = 'checkhint';
      hint.textContent = c.hint;
      row.append(hint);
    }
    return row;
  }));
  startBtn.disabled = !ready;
  startAnywayBtn.classList.toggle('hidden', ready);
}

el('changeSetup').addEventListener('click', () => { sounds.uiTick(); showStep('garage'); });
startBtn.addEventListener('click', () => beginStart());
startAnywayBtn.addEventListener('click', () => beginStart());

async function beginStart() {
  if (lightsRunning) return;
  leaveGrid();
  await save({ setupCompleted: true });
  runLights();
}

// ---------- start lights ----------
function finishStart(message, fadeMs) {
  radio(message);
  gate.classList.add('fade');
  setTimeout(() => {
    startRide();
    gate.classList.remove('fade');
    lightsEl.classList.add('hidden');
    lightsRunning = false;
  }, fadeMs);
}

function runLights() {
  lightsRunning = true;
  for (const s of screens) s.classList.remove('active');
  setupNav.classList.add('hidden');
  el('gateFootnote').classList.add('hidden');
  // Start-lights countdown is a ⚙ setting (on by default); off = straight in.
  if (settings && settings.startLightsEnabled === false) {
    finishStart('SESSION LIVE', 250);
    return;
  }
  lightsEl.classList.remove('hidden');
  lightsEl.replaceChildren(...Array.from({ length: 5 }, () => {
    const col = document.createElement('div');
    col.className = 'lightcol';
    col.append(document.createElement('i'), document.createElement('i'));
    return col;
  }));
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const stepMs = reduced ? 220 : 900;
  const cols = [...lightsEl.children];
  cols.forEach((col, i) => {
    setTimeout(() => { col.classList.add('on'); sounds.lightOn(); }, stepMs * (i + 1));
  });
  const holdMs = reduced ? 500 : 200 + Math.random() * 2800;
  setTimeout(() => {
    cols.forEach((c) => c.classList.remove('on'));
    sounds.lightsOut();
    finishStart('LIGHTS OUT — SESSION LIVE', 450);
  }, stepMs * 5 + holdMs);
}

// ---------- settings menu (modal: backdrop click / Escape closes) ----------
const settingsScrim = el('settingsScrim'), setStatus = el('setStatus');

el('settingsBtn').addEventListener('click', () => {
  const opening = settingsScrim.classList.contains('hidden');
  settingsScrim.classList.toggle('hidden');
  if (opening) populateSettingsMenu();
});
settingsScrim.addEventListener('click', (e) => {
  if (e.target === settingsScrim) settingsScrim.classList.add('hidden');
});
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') settingsScrim.classList.add('hidden');
});

// Apply an env lock to a ⚙ control (audit C3/Q8): toggle the ENV badge (with
// the var-naming tooltip + accessible description), and make the control
// non-editable while it is overridden. A text input uses `readonly` so it keeps
// focus + tooltip; a <select>/checkbox has no readonly, so it is `disabled` and
// the focusable badge carries the accessible name. `aria-describedby` links a
// still-focusable readonly control to its badge.
function applyEnvLock(control, badge, key, { readonly = false } = {}) {
  const lock = envLockState(key, envOverridden);
  badge.classList.toggle('hidden', !lock.locked);
  if (lock.locked) {
    badge.title = lock.title;
    badge.setAttribute('aria-label', lock.title);
    control.setAttribute('aria-describedby', badge.id);
  } else {
    badge.removeAttribute('title');
    badge.removeAttribute('aria-label');
    control.removeAttribute('aria-describedby');
  }
  if (readonly) control.readOnly = lock.locked; else control.disabled = lock.locked;
  return lock.locked;
}

function populateSettingsMenu() {
  if (!settings) return;
  el('setSound').checked = settings.soundEnabled;
  el('setLights').checked = settings.startLightsEnabled;
  el('setElrsPath').value = settings.elrsPath;
  // Env-locked controls show the EFFECTIVE value (never the ignored persisted
  // one) and are non-editable; unlocked controls behave exactly as before.
  const w3Locked = applyEnvLock(el('setW3'), el('setW3Env'), 'w3');
  el('setW3').checked = w3Locked ? !!envEffective.w3 : settings.w3DiagnosticEnabled;
  const srcLocked = applyEnvLock(el('setTelemetrySource'), el('setTelemetrySourceEnv'), 'telemetrySource');
  el('setTelemetrySource').value = srcLocked
    ? (envEffective.telemetrySource ?? settings.telemetry.source)
    : settings.telemetry.source;
  const portLocked = applyEnvLock(el('setTelemetryPort'), el('setTelemetryPortEnv'), 'telemetryPort', { readonly: true });
  el('setTelemetryPort').value = portLocked
    ? String(envEffective.telemetryPort ?? settings.telemetry.port ?? '')
    : settings.telemetry.port;
  setStatus.textContent = '';
}

el('setSound').addEventListener('change', async (e) => {
  setSoundEnabled(e.target.checked);
  await save({ soundEnabled: e.target.checked });
  sounds.radioOpen();
});
el('setLights').addEventListener('change', async (e) => {
  await save({ startLightsEnabled: e.target.checked });
});
el('setW3').addEventListener('change', async (e) => {
  // Locked by W17_HEADTRACK: env wins, so never persist a UI edit (the control
  // is disabled anyway — this is defense in depth). Audit C3/Q8.
  if (envOverridden.w3) return;
  await save({ w3DiagnosticEnabled: e.target.checked });
  const applied = await ipc(gs.applySession(), null, 'session:apply');
  if (!applied) { setStatus.textContent = 'APPLY FAILED — toggle again to retry'; return; }
  setStatus.textContent = applied.w3 ? 'HEAD-TRACK LOGGING ON (log-only)' : 'HEAD-TRACK LOGGING OFF';
  setW3Chip(!!applied.w3);
});
el('setElrsPath').addEventListener('change', async (e) => { await save({ elrsPath: e.target.value.trim() }); });
async function telemetryChanged() {
  // Partial-lock safe (audit C3/Q8): persist ONLY the fields env is NOT
  // overriding. Saving a locked field would write its displayed EFFECTIVE
  // (env) value back into settings as if the user chose it — a misleading edit.
  const patch = {};
  if (!envOverridden.telemetrySource) patch.source = el('setTelemetrySource').value;
  if (!envOverridden.telemetryPort) patch.port = el('setTelemetryPort').value.trim();
  if (Object.keys(patch).length) await save({ telemetry: patch });
  const applied = await ipc(gs.applySession(), null, 'session:apply');
  if (applied) {
    // Runtime source switch updates the replay chip immediately (audit C2).
    setReplayChip(applied.telemetry === 'replay');
    setStatus.textContent = `TELEMETRY: ${applied.telemetry.toUpperCase()}`;
  } else {
    setStatus.textContent = 'APPLY FAILED — change the setting again to retry';
  }
}
el('setTelemetrySource').addEventListener('change', telemetryChanged);
el('setTelemetryPort').addEventListener('change', telemetryChanged);
el('setRerun').addEventListener('click', () => {
  settingsScrim.classList.add('hidden');
  gate.classList.remove('hidden', 'fade');
  el('gateFootnote').classList.remove('hidden');
  showStep('garage');
});

// ---------- boot ----------
// A rejected initial settings load must not leave the gate blank (audit N1):
// it renders the visible SETUP DATA UNAVAILABLE state, and RETRY re-runs
// boot(). No setup step is shown until settings actually load.
const bootError = el('bootError');
el('bootRetry').addEventListener('click', () => { sounds.uiTick(); boot(); });

async function boot() {
  if (!gs) { showStep('garage'); return; } // bench preview outside Electron
  let res;
  try {
    res = await gs.getSettings();
  } catch (err) {
    console.error('[setup] settings load failed:', err && err.message ? err.message : err);
    bootError.classList.remove('hidden');
    return;
  }
  bootError.classList.add('hidden');
  settings = res.settings;
  envOverridden = res.envOverridden || {};
  envEffective = res.effective || {};
  credential = res.credential || null;
  mode = settings.fpvMode;
  setSoundEnabled(settings.soundEnabled);
  if (settings.setupCompleted) {
    radio('WELCOME BACK — STRAIGHT TO THE GRID');
    showStep('grid');
  } else {
    showStep('garage');
  }
}
boot();
