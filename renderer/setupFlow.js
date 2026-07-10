// Pre-ride setup flow: GARAGE (mode) -> PIT WALL (network) -> SEAT FIT
// (controller) -> GRID (checklist) -> start lights -> HUD. Owns the gate
// overlay; hud.js keeps owning the HUD and exposes startRide()/hudStatus().
//
// Everything OS-touching goes through the preload surface; this file is UI
// glue over the pure step/checklist/address modules in shared/. It never
// touches control — the START buttons only dismiss a viewer overlay.

import { startRide, hudStatus, setControllerChoice } from './hud.js';
import { stepsFor, nextStep, prevStep, LIGHTS } from '../shared/setupSteps.mjs';
import { buildChecklist, applyProbes, canStart } from '../shared/checklist.mjs';
import { isValidIpv4, suggestionFromHint } from '../shared/addressProviders.mjs';
import { PRESETS, DEFAULT_PRESET, getPreset, detectPresetFromId } from '../shared/inputPresets.mjs';
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

// ---------- persistence ----------
async function save(patch) {
  if (!gs) return settings;
  settings = await gs.setSettings(patch);
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
addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !gate.classList.contains('hidden') && !navNext.classList.contains('hidden')) navNext.click();
});

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
const netList = el('netList'), netPwRow = el('netPwRow'), netPassword = el('netPassword');
const joinStatus = el('joinStatus'), hsStatus = el('hsStatus'), guideStatus = el('guideStatus');
const addrInput = el('iphoneAddr'), addrSuggest = el('addrSuggest'), addrStatus = el('addrStatus');
const adapterRow = el('adapterRow'), adapterSelect = el('adapterSelect');
let netKind = 'join';
let joinTarget = null;
let hintTimer = null;
let caps = null;

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
  addrInput.value = settings?.iphoneAddr || '';
  el('hsSsid').value = settings?.network?.hotspot?.ssid || 'W17-GRID';
  el('hsPass').value = settings?.network?.hotspot?.password || generatePassword();
  caps = gs ? await gs.wifiCapabilities() : { canScan: false, canHotspot: false };
  netTabs.classList.toggle('hidden', !caps.canScan && !caps.canHotspot);
  if (!caps.canScan && !caps.canHotspot) {
    showNetTab('guide');
  } else {
    await refreshAdapters();
    showNetTab(settings?.network?.kind === 'hotspot' && caps.canHotspot ? 'hotspot' : 'join');
    rescan();
  }
  hintTimer = setInterval(pollAddrHint, 2000);
  pollAddrHint();
}

// WLAN adapter picker: shown only when more than one adapter exists (built-in
// vs USB dongle); the choice pins netsh scan/join to that interface.
async function refreshAdapters() {
  const ifaces = gs && gs.wifiInterfaces ? await gs.wifiInterfaces() : [];
  adapterRow.classList.toggle('hidden', ifaces.length < 2);
  if (ifaces.length < 2) { adapterSelect.replaceChildren(); return; }
  adapterSelect.replaceChildren(...ifaces.map((i) => {
    const o = document.createElement('option');
    o.value = i.name;
    o.textContent = `${i.name}${i.description ? ` — ${i.description}` : ''}${i.connected ? ` · ${i.ssid}` : ''}`;
    return o;
  }));
  const saved = settings?.network?.adapter;
  if (saved && ifaces.some((i) => i.name === saved)) adapterSelect.value = saved;
}

function chosenAdapter() {
  return adapterRow.classList.contains('hidden') ? undefined : (adapterSelect.value || undefined);
}

adapterSelect.addEventListener('change', () => {
  sounds.uiTick();
  save({ network: { adapter: adapterSelect.value } });
  rescan();
});

function leavePitwall() {
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

async function rescan() {
  if (!gs || !caps?.canScan) return;
  joinStatus.textContent = 'SCANNING…';
  const nets = await gs.wifiScan({ iface: chosenAdapter() });
  joinStatus.textContent = nets.length ? '' : 'NO NETWORKS FOUND';
  netList.replaceChildren(...nets.map((n) => {
    const row = document.createElement('button');
    row.className = 'netrow';
    row.innerHTML = `<b></b><span class="sig"></span><span class="known"></span>`;
    row.querySelector('b').textContent = n.ssid;
    row.querySelector('.sig').textContent = `${n.signalPct ?? '--'}%`;
    row.querySelector('.known').textContent = n.known ? 'known' : (n.auth || '');
    row.addEventListener('click', () => selectNetwork(n, row));
    return row;
  }));
}
el('netRescan').addEventListener('click', () => { sounds.uiTick(); rescan(); });

function selectNetwork(n, row) {
  sounds.uiTick();
  for (const r of netList.children) r.classList.toggle('on', r === row);
  joinTarget = n;
  if (n.known) { doJoin(); } else {
    netPwRow.classList.remove('hidden');
    netPassword.value = '';
    netPassword.focus();
  }
}

async function doJoin() {
  if (!joinTarget) return;
  const ssid = joinTarget.ssid;
  joinStatus.textContent = `JOINING ${ssid}…`;
  const res = await gs.wifiJoin({
    ssid,
    password: joinTarget.known ? undefined : netPassword.value,
    iface: chosenAdapter(),
  });
  if (res.ok) {
    netPwRow.classList.add('hidden');
    joinStatus.textContent = `CONNECTED: ${ssid}`;
    radio(`PIT WALL: NETWORK CONFIRMED — ${ssid}`);
    save({ network: { kind: 'join', ssid } });
  } else {
    joinStatus.textContent = res.error || 'JOIN FAILED';
  }
}
el('netJoinBtn').addEventListener('click', doJoin);

el('hsStart').addEventListener('click', async () => {
  sounds.uiTick();
  const ssid = el('hsSsid').value.trim();
  const password = el('hsPass').value;
  hsStatus.textContent = 'STARTING HOTSPOT…';
  const res = await gs.hotspotStart({ ssid, password });
  if (res.ok) {
    hsStatus.textContent = `LIVE (${res.method}) — join "${res.ssid}" on the iPhone${res.hostIp ? ` · this PC: ${res.hostIp}` : ''}`;
    radio(`PIT WALL: HOTSPOT ${res.ssid} IS LIVE`);
    save({ network: { kind: 'hotspot', hotspot: { ssid, password } } });
  } else {
    hsStatus.textContent = res.error || 'HOTSPOT FAILED';
  }
});

el('guideVerify').addEventListener('click', async () => {
  sounds.uiTick();
  const st = await gs.wifiStatus();
  const ips = (st.adapterIps || []).map((a) => `${a.name} ${a.addr}`).join(' · ');
  guideStatus.textContent = `${st.connected ? `WIFI: ${st.ssid}` : 'WIFI: not detected'}${ips ? ` — ${ips}` : ''}`;
});

async function pollAddrHint() {
  if (!gs) return;
  const hint = await gs.getAddrHint();
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
  if (!isValidIpv4(addr)) { addrStatus.textContent = 'INVALID IP'; return; }
  addrStatus.textContent = 'PINGING…';
  const res = await gs.probeHost(addr);
  addrStatus.textContent = res.ok ? `REPLY ${res.rttMs}ms` : (res.error || 'NO REPLY').toUpperCase();
});

// ---------- SEAT FIT ----------
const padList = el('padList'), presetRow = el('presetRow'), padPreview = el('padPreview');
let padTimer = null;
let chosenPadId = '';
let chosenPreset = DEFAULT_PRESET;
let presetManual = false; // a pill click this visit beats auto-detection

function enterSeatfit() {
  chosenPadId = settings?.controller?.id || '';
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
  padTimer = setInterval(seatfitTick, 250);
  applyChoice();
}

// Auto-suggest the layout from the pad type. Loses to: a manual pill click
// this visit, and a persisted choice saved for this exact pad. Unrecognized
// pads keep the current layout.
function maybeAutoPreset(padId) {
  if (presetManual || !padId) return;
  if (settings?.controller?.id === padId) return;
  const detected = detectPresetFromId(padId);
  if (detected) chosenPreset = detected;
}

function leaveSeatfit() {
  clearInterval(padTimer);
  padTimer = null;
  save({ controller: { id: chosenPadId, preset: chosenPreset } });
}

function applyChoice() {
  setControllerChoice({ id: chosenPadId, preset: chosenPreset });
  for (const b of presetRow.children) b.classList.toggle('on', b.dataset.preset === chosenPreset);
  padPreview.innerHTML = padPreviewSvg(chosenPreset);
}

function seatfitTick() {
  const pads = [...(navigator.getGamepads ? navigator.getGamepads() : [])].filter(Boolean);
  // Rebuild only when the set changes (avoid killing :hover constantly).
  const sig = pads.map((p) => p.id).join('|');
  if (padList.dataset.sig !== sig) {
    padList.dataset.sig = sig;
    padList.replaceChildren(...(pads.length ? pads.map((p) => {
      const b = document.createElement('button');
      b.className = 'netrow';
      b.dataset.padId = p.id;
      const name = document.createElement('b');
      name.textContent = p.id;
      const tag = document.createElement('span');
      tag.className = 'known';
      tag.textContent = 'auto';
      b.append(name, tag);
      b.addEventListener('click', () => { chosenPadId = p.id; maybeAutoPreset(p.id); applyChoice(); sounds.uiTick(); });
      return b;
    }) : [Object.assign(document.createElement('div'), { className: 'netstatus', textContent: 'NO CONTROLLER DETECTED — keyboard fallback stays available' })]));
    // No manual pick yet: the first pad is the auto choice — suggest its layout.
    if (!chosenPadId && pads[0]) { maybeAutoPreset(pads[0].id); applyChoice(); }
  }
  const activeId = chosenPadId || pads[0]?.id;
  for (const b of padList.children) {
    if (b.tagName !== 'BUTTON') continue;
    b.classList.toggle('on', b.dataset.padId === activeId);
    const tag = b.querySelector('.known');
    if (tag) tag.style.visibility = !chosenPadId && b.dataset.padId === pads[0]?.id ? 'visible' : 'hidden';
  }
  // Live test strip through the chosen preset — proves the mapping instantly.
  const p = pads.find((x) => x.id === chosenPadId) || pads[0];
  const m = getPreset(chosenPreset).map;
  const steer = p ? (p.axes[m.steerAxis] || 0) : 0;
  const thr = p && p.buttons[m.throttleBtn] ? p.buttons[m.throttleBtn].value : 0;
  const brk = p && p.buttons[m.brakeBtn] ? p.buttons[m.brakeBtn].value : 0;
  el('tsSteer').style.left = `${50 + steer * 42}%`;
  el('tsThr').style.width = `${(thr * 100).toFixed(0)}%`;
  el('tsBrk').style.width = `${(brk * 100).toFixed(0)}%`;
}

// ---------- GRID ----------
const checkList = el('checkList'), startBtn = el('startBtn'), startAnywayBtn = el('startAnywayBtn');
let gridTimer = null;
let checks = [];
let probing = false;
const announced = new Set();

async function enterGrid() {
  radio('GRID: RUNNING FINAL CHECKS');
  if (envOverridden.telemetrySource || envOverridden.iphoneBridge || envOverridden.w3) {
    radio('NOTE: SOME SETTINGS ARE LOCKED BY ENV VARS');
  }
  const applied = gs ? await gs.applySession() : { telemetry: 'none' };
  checks = buildChecklist({
    mode,
    telemetryConfigured: applied.telemetry !== 'none',
    elrsConfigured: !!(settings && settings.elrsPath),
  });
  renderChecks();
  gridTimer = setInterval(gridTick, 1000);
  gridTick();
}

function leaveGrid() {
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
      results['iphone-reachable'] = isValidIpv4(addr) ? (await gs.probeHost(addr)).ok : false;
    }
    const elrsCheck = checks.find((c) => c.id === 'elrs-running');
    if (elrsCheck) {
      const st = await gs.elrsStatus();
      results['elrs-running'] = st.configured ? st.detected : 'skipped';
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
        const res = await gs.elrsLaunch();
        radio(res.ok ? 'ELRS CONTROL LAUNCHED' : `ELRS LAUNCH FAILED: ${res.error}`);
      });
      row.append(btn);
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

function populateSettingsMenu() {
  if (!settings) return;
  el('setSound').checked = settings.soundEnabled;
  el('setLights').checked = settings.startLightsEnabled;
  el('setW3').checked = settings.w3DiagnosticEnabled;
  el('setElrsPath').value = settings.elrsPath;
  el('setTelemetrySource').value = settings.telemetry.source;
  el('setTelemetryPort').value = settings.telemetry.port;
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
  await save({ w3DiagnosticEnabled: e.target.checked });
  const applied = await gs.applySession();
  setStatus.textContent = applied.w3 ? 'HEAD-TRACK LOGGING ON (log-only)' : 'HEAD-TRACK LOGGING OFF';
});
el('setElrsPath').addEventListener('change', async (e) => { await save({ elrsPath: e.target.value.trim() }); });
async function telemetryChanged() {
  await save({ telemetry: { source: el('setTelemetrySource').value, port: el('setTelemetryPort').value.trim() } });
  const applied = await gs.applySession();
  setStatus.textContent = `TELEMETRY: ${applied.telemetry.toUpperCase()}`;
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
async function boot() {
  if (!gs) { showStep('garage'); return; } // bench preview outside Electron
  const res = await gs.getSettings();
  settings = res.settings;
  envOverridden = res.envOverridden || {};
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
