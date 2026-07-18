// @vitest-environment jsdom
// DOM-level tests of the REAL renderer (audit M1 + N1): renderer/index.html
// plus the real hud.js/setupFlow.js modules run under jsdom against a mocked
// `window.groundStation` preload surface. These pin the two audit defects at
// the integration level — global key handlers fighting setup inputs, and IPC
// rejections leaving the gate blank / unhandled — which pure helper tests
// cannot see. Any IPC rejection these flows fail to handle fails this file
// (vitest surfaces unhandled rejections as errors).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// The REAL main-process hotspot authority (CJS), reused as the DOM tests'
// backend so clicks drive the real state machine driving the real renderer.
// (cwd-based require: under jsdom import.meta.url is not a file URL.)
const require = createRequire(`${process.cwd()}/`);
const { HotspotManager } = require('./main/hotspot.js');
const { HotspotLifecycle } = require('./main/hotspotLifecycle.js');

// (cwd-relative: under the jsdom environment import.meta.url is not a file URL)
const html = readFileSync('renderer/index.html', 'utf8');
const bodyHtml = html
  .match(/<body>([\s\S]*)<\/body>/)[1]
  .replace(/<script[\s\S]*?<\/script>/g, ''); // modules are imported by the test, not the page

// One macrotask flushes every pending microtask chain in the mocked IPC.
const tick = () => new Promise((r) => setTimeout(r, 0));
const el = (id) => document.getElementById(id);
const activeStep = () => document.querySelector('.setup-screen.active')?.dataset.step ?? null;
const keydown = (target, key) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

const PASSWORD = 'p@ss w0rd!'; // deliberately contains a space (real WPA2 passphrases do)
const HS_PASSWORD = 'lights0ut!!';

function defaultSettings() {
  return {
    fpvMode: 'solo', soundEnabled: false, startLightsEnabled: true, setupCompleted: false,
    iphoneAddr: '', w3DiagnosticEnabled: false, elrsPath: '',
    telemetry: { source: 'none', port: '' },
    network: { kind: 'join', adapter: '', hotspot: { ssid: 'W17-GRID', password: HS_PASSWORD } },
  };
}

function mockGs(overrides = {}) {
  const settings = defaultSettings();
  return {
    getConfig: vi.fn(async () => ({ whepUrl: '', w3Active: false, feel: null, telemetrySource: 'none' })),
    getSettings: vi.fn(async () => ({ settings, envOverridden: {} })),
    setSettings: vi.fn(async () => settings),
    applySession: vi.fn(async () => ({ telemetry: 'none', w3: false })),
    wifiCapabilities: vi.fn(async () => ({ canScan: true, canHotspot: true, sim: true })),
    wifiInterfaces: vi.fn(async () => ({
      ok: true, ifaces: [{ name: 'Wi-Fi', description: 'Test adapter', connected: false }],
    })),
    wifiScan: vi.fn(async () => ({
      ok: true, networks: [{ ssid: 'PaddockNet', signalPct: 87, known: false, auth: 'WPA2-Personal', security: 'wpa2-personal' }],
    })),
    wifiJoin: vi.fn(async () => ({ ok: true })),
    wifiStatus: vi.fn(async () => ({ connected: false, adapterIps: [] })),
    hotspotStart: vi.fn(async () => ({ ok: true, method: 'mobile', ssid: 'W17-GRID', hostIp: null })),
    hotspotStop: vi.fn(async () => ({ ok: true })),
    hotspotState: vi.fn(async () => ({
      seq: 0, phase: 'inactive', owned: false, backend: null, ssid: '', hostIp: null, lastError: null,
      probe: { status: 'supported', backend: 'mobile', mobileState: 'Off', externallyActive: false },
    })),
    hotspotProbe: vi.fn(async () => ({ status: 'supported', backend: 'mobile', mobileState: 'Off', externallyActive: false })),
    onHotspotState: vi.fn(() => () => {}),
    getAddrHint: vi.fn(async () => null),
    probeHost: vi.fn(async () => ({ ok: false, error: 'no reply' })),
    elrsStatus: vi.fn(async () => ({ configured: false, detected: false })),
    elrsLaunch: vi.fn(async () => ({ ok: true })),
    onTelemetry: vi.fn(() => () => {}),
    sendCommandMirror: vi.fn(),
    ...overrides,
  };
}

// Loads the real renderer against the given mock. resetModules gives each
// test fresh module state; the fresh body gives it fresh elements.
async function loadRenderer(gs) {
  vi.resetModules();
  document.body.innerHTML = bodyHtml;
  window.requestAnimationFrame = () => 0; // no 60 fps HUD loop in tests
  window.groundStation = gs;
  await import('../renderer/setupFlow.js');
  await tick();
}

// Boot into PIT WALL (iphone-hud mode) — the step both audit defects hit. Batch
// 8b reordered the flow to GARAGE -> SEAT FIT -> PIT WALL -> GRID, so PIT WALL is
// reached by advancing once past SEAT FIT (the network step no longer sits first).
async function loadPitwall(gs) {
  await loadRenderer(gs);
  document.querySelector('.modecard[data-mode="iphone-hud"]').click();
  await tick(); // GARAGE -> SEAT FIT
  el('navNext').click();
  await tick(); // SEAT FIT -> PIT WALL
  expect(activeStep()).toBe('pitwall');
}

// Entering a screen opens a real setInterval (padTimer 250 ms / gridTimer 1 s /
// hintTimer 2 s) that the module clears only on LEAVING that screen. A test that
// ends still on the screen never leaves, and loadRenderer's vi.resetModules()
// orphans the timer instead of clearing it — so a stale tick from a prior test's
// module can re-render into the next test's shared DOM (e.g. re-marking the wheel
// device list, a flaky selection). Track every real interval the module opens and
// clear it between tests. (Fake-timer tests replace globalThis.setInterval while
// active, so their ids never enter this set — only real, leakable ids do.)
const _openIntervals = new Set();
const _realSetInterval = globalThis.setInterval.bind(globalThis);
globalThis.setInterval = (fn, ms, ...rest) => {
  const id = _realSetInterval(fn, ms, ...rest);
  _openIntervals.add(id);
  return id;
};
afterEach(() => {
  for (const id of _openIntervals) clearInterval(id);
  _openIntervals.clear();
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('boot failure state (audit N1)', () => {
  it('a rejected initial settings load renders the visible error state, and RETRY recovers', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let fail = true;
    const gs = mockGs({
      getSettings: vi.fn(async () => {
        if (fail) throw new Error('settings store unavailable');
        return { settings: defaultSettings(), envOverridden: {} };
      }),
    });
    await loadRenderer(gs);
    // Not a blank gate: the error block is visible and no step is shown.
    expect(el('bootError').classList.contains('hidden')).toBe(false);
    expect(activeStep()).toBeNull();
    // RETRY re-runs boot and lands on GARAGE once settings load.
    fail = false;
    el('bootRetry').click();
    await tick();
    expect(el('bootError').classList.contains('hidden')).toBe(true);
    expect(activeStep()).toBe('garage');
  });
});

describe('keyboard scoping end-to-end (audit M1)', () => {
  it('space and arrows in the password field reach the field; Enter joins without navigating', async () => {
    const gs = mockGs();
    await loadPitwall(gs);
    document.querySelector('#netList .netrow').click(); // unknown net -> password row
    expect(el('netPwRow').classList.contains('hidden')).toBe(false);
    const pw = el('netPassword');
    pw.focus();
    // The HUD's global handler must not steal these from the field.
    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    pw.dispatchEvent(space);
    expect(space.defaultPrevented).toBe(false);
    const left = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true });
    pw.dispatchEvent(left);
    expect(left.defaultPrevented).toBe(false);
    // Enter submits the JOIN with the typed password — and does NOT advance.
    pw.value = PASSWORD;
    keydown(pw, 'Enter');
    await tick();
    expect(gs.wifiJoin).toHaveBeenCalledWith({ ssid: 'PaddockNet', password: PASSWORD, iface: undefined, security: 'wpa2-personal', known: false });
    expect(activeStep()).toBe('pitwall');
    expect(el('joinStatus').textContent).toBe('CONNECTED: PaddockNet');
  });

  it('Enter in an unrelated editable field does not advance; Enter on a plain focus still does', async () => {
    const gs = mockGs();
    await loadPitwall(gs);
    const addr = el('iphoneAddr'); // unrelated text field on the same step
    addr.focus();
    keydown(addr, 'Enter');
    await tick();
    expect(activeStep()).toBe('pitwall'); // stayed put
    // No editable control focused: Enter = NEXT still works (PIT WALL -> GRID).
    addr.blur();
    keydown(document.body, 'Enter');
    await tick();
    expect(activeStep()).toBe('grid');
  });
});

describe('operational IPC rejections (audit N1)', () => {
  it('a rejected join shows the fixed retry message — never the password — and retry works', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const gs = mockGs({
      wifiJoin: vi.fn(async () => { throw new Error(`netsh blew up with key="${PASSWORD}"`); }),
    });
    await loadPitwall(gs);
    document.querySelector('#netList .netrow').click();
    el('netPassword').value = PASSWORD;
    el('netJoinBtn').click();
    await tick();
    // 2E: the status line is a terse summary (never overlaps), the full fixed
    // fallback rides the expandable DETAILS box; neither carries the password.
    expect(el('joinStatus').textContent).toBe('JOIN FAILED');
    expect(el('joinStatus').textContent).not.toContain(PASSWORD);
    expect(el('joinDetail').classList.contains('hidden')).toBe(false);
    expect(el('joinDetailText').textContent).toBe('JOIN FAILED — the network layer did not respond; retry');
    expect(el('joinDetailText').textContent).not.toContain(PASSWORD);
    expect(activeStep()).toBe('pitwall'); // a failed join never advances the flow
    // The rejection message carried the password; the renderer log must not.
    const logged = errSpy.mock.calls.flat().map(String).join('\n');
    expect(logged).not.toContain(PASSWORD);
    // The password row is still up — JOIN again succeeds.
    expect(el('netPwRow').classList.contains('hidden')).toBe(false);
    gs.wifiJoin.mockImplementation(async () => ({ ok: true }));
    el('netJoinBtn').click();
    await tick();
    expect(el('joinStatus').textContent).toBe('CONNECTED: PaddockNet');
    expect(el('joinDetail').classList.contains('hidden')).toBe(true); // success clears the detail
  });

  it('a rejected scan shows SCAN FAILED with a retry hint, and RESCAN recovers', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let fail = true;
    const gs = mockGs({
      wifiScan: vi.fn(async () => {
        if (fail) throw new Error('scan handler died');
        return { ok: true, networks: [{ ssid: 'PaddockNet', signalPct: 87, known: false, auth: 'WPA2-Personal', security: 'wpa2-personal' }] };
      }),
    });
    await loadPitwall(gs);
    expect(el('joinStatus').textContent).toBe('SCAN FAILED — scan did not complete — RESCAN to retry');
    expect(el('netList').children.length).toBe(0);
    fail = false;
    el('netRescan').click();
    await tick();
    expect(el('joinStatus').textContent).toBe('');
    expect(el('netList').children.length).toBe(1);
  });

  it('a rejected hotspot start shows the fixed message and never the password', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const gs = mockGs({
      hotspotStart: vi.fn(async () => { throw new Error(`WinRT exploded holding "${HS_PASSWORD}"`); }),
    });
    await loadPitwall(gs);
    document.querySelector('[data-nettab="hotspot"]').click();
    expect(el('hsPass').value).toBe(HS_PASSWORD); // persisted hotspot credentials
    el('hsStart').click();
    await tick();
    expect(el('hsStatus').textContent).toBe('HOTSPOT FAILED — the network layer did not respond; retry');
    expect(el('hsStatus').textContent).not.toContain(HS_PASSWORD);
    const logged = errSpy.mock.calls.flat().map(String).join('\n');
    expect(logged).not.toContain(HS_PASSWORD);
  });

  it('a rejected settings save warns on the team radio and does not block the flow', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const gs = mockGs({
      setSettings: vi.fn(async () => { throw new Error('disk full'); }),
    });
    await loadRenderer(gs);
    document.querySelector('.modecard[data-mode="solo"]').click();
    await tick();
    expect(activeStep()).toBe('seatfit'); // flow continues on in-memory settings
    expect(el('radioLog').textContent).toContain('SETTINGS SAVE FAILED — CHANGES MAY NOT PERSIST');
  });

  it('a rejected adapter listing renders the failed card (ADAPTER CHECK FAILED) with the reason and a card RESCAN', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const gs = mockGs({
      wifiInterfaces: vi.fn(async () => { throw new Error('handler died'); }),
    });
    await loadPitwall(gs);
    expect(el('adapterRow').classList.contains('hidden')).toBe(false);
    expect(el('adapterStatus').classList.contains('hidden')).toBe(false);
    expect(el('adapterStatus').textContent).toBe('ADAPTER CHECK FAILED');
    expect(el('adapterHint').textContent).toContain('adapter listing unavailable');
    expect(el('adapterRescan').classList.contains('hidden')).toBe(false); // card RESCAN offered
    expect(el('netRescan').classList.contains('hidden')).toBe(true);      // join-pane RESCAN hides (no duplicate)
    expect(el('adapterDetail').classList.contains('hidden')).toBe(true);  // no adapter to detail
  });

  it('a rejected session apply on GRID entry is visible instead of a blank checklist', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const settings = { ...defaultSettings(), setupCompleted: true };
    const gs = mockGs({
      getSettings: vi.fn(async () => ({ settings, envOverridden: {} })),
      applySession: vi.fn(async () => { throw new Error('runtime apply died'); }),
    });
    await loadRenderer(gs);
    // Batch 8a: a returning user lands on GARAGE with the fast-path card; the
    // card's button runs the existing resume path to GRID.
    expect(activeStep()).toBe('garage');
    el('fastPathBtn').click();
    await tick();
    expect(activeStep()).toBe('grid');
    expect(el('setupSummary').textContent).toContain('SESSION APPLY FAILED');
    expect(el('checkList').children.length).toBeGreaterThan(0); // checklist still renders
  });
});

// Deterministic previews of the ADAPTER card states (audit M2/A3, Q7 option 2):
// the same states W17_WIFI_SIM shows in the app, pinned here against the real
// renderer so they cannot silently regress.
describe('ADAPTER card states (audit Q7 option 2)', () => {
  it('guide mode still shows the ADAPTER card with the Windows note and the sim hint', async () => {
    const gs = mockGs({
      wifiCapabilities: vi.fn(async () => ({ canScan: false, canHotspot: false, sim: false })),
    });
    await loadPitwall(gs);
    expect(el('paneGuide').classList.contains('hidden')).toBe(false);
    expect(el('adapterRow').classList.contains('hidden')).toBe(false);
    expect(el('adapterStatus').textContent).toBe('Adapter selection is available in the Windows application.');
    expect(el('adapterHint').textContent).toContain('W17_WIFI_SIM');
    expect(el('adapterDetail').classList.contains('hidden')).toBe(true);
    expect(el('adapterPick').classList.contains('hidden')).toBe(true);  // never a picker in guide mode
    expect(gs.wifiInterfaces).not.toHaveBeenCalled();                   // no adapter listing without netsh
  });

  it('zero adapters shows NO WLAN ADAPTER DETECTED + troubleshooting + a card RESCAN that re-detects', async () => {
    const gs = mockGs({ wifiInterfaces: vi.fn(async () => ({ ok: true, ifaces: [] })) });
    await loadPitwall(gs);
    expect(el('adapterStatus').textContent).toBe('NO WLAN ADAPTER DETECTED');
    expect(el('adapterStatus').classList.contains('warn')).toBe(true);
    expect(el('adapterHint').textContent).toMatch(/dongle/i);
    expect(el('adapterRescan').classList.contains('hidden')).toBe(false);
    expect(el('netRescan').classList.contains('hidden')).toBe(true);
    // Plug the dongle in and RESCAN from the card — no need to leave the step.
    gs.wifiInterfaces.mockImplementation(async () => ({
      ok: true, ifaces: [{ name: 'Wi-Fi', description: 'Built-in', connected: false, ssid: '', signalPct: null }],
    }));
    el('adapterRescan').click();
    await tick();
    expect(el('adapterStatus').classList.contains('hidden')).toBe(true);
    expect(el('adapterDetail').classList.contains('hidden')).toBe(false);
    expect(el('adapterName').textContent).toBe('Wi-Fi');
    expect(el('netRescan').classList.contains('hidden')).toBe(false); // join-pane RESCAN back once an adapter exists
  });

  it('one adapter is a readonly card: name, description, connection chip, SSID+signal, SELECTED, no dropdown', async () => {
    const gs = mockGs({
      wifiInterfaces: vi.fn(async () => ({
        ok: true,
        ifaces: [{ name: 'Wi-Fi', description: 'Intel AX201', connected: true, ssid: 'PaddockNet', signalPct: 90 }],
      })),
    });
    await loadPitwall(gs);
    expect(el('adapterDetail').classList.contains('hidden')).toBe(false);
    expect(el('adapterName').textContent).toBe('Wi-Fi');
    expect(el('adapterDesc').textContent).toBe('Intel AX201');
    expect(el('adapterChip').textContent).toBe('CONNECTED');
    expect(el('adapterChip').classList.contains('connected')).toBe(true);
    expect(el('adapterNet').textContent).toBe('PaddockNet · 90%');
    expect(el('adapterSelNote').classList.contains('hidden')).toBe(false);   // SELECTED shown
    expect(el('adapterPick').classList.contains('hidden')).toBe(true);       // no dropdown for one adapter
    expect(el('adapterRow').classList.contains('interactive')).toBe(false);  // reads readonly
    expect(gs.wifiScan).toHaveBeenCalledWith({ iface: undefined });          // netsh default interface
  });

  it('a saved adapter that is NOT detected blocks scan and join until the user picks one', async () => {
    const settings = defaultSettings();
    settings.network.adapter = 'Wi-Fi 2'; // saved dongle, no longer present
    const gs = mockGs({
      getSettings: vi.fn(async () => ({ settings, envOverridden: {} })),
      setSettings: vi.fn(async () => settings), // saves keep the custom settings object
      wifiInterfaces: vi.fn(async () => ({
        ok: true,
        ifaces: [
          { name: 'Wi-Fi', description: 'Built-in', connected: true, ssid: 'HOME', signalPct: 84 },
          { name: 'Wi-Fi 3', description: 'Other USB', connected: false, ssid: '', signalPct: null },
        ],
      })),
    });
    await loadPitwall(gs);
    // The card demands a decision: amber NOT DETECTED, native <select>, nothing scanned.
    expect(el('adapterPick').classList.contains('hidden')).toBe(false);
    expect(el('adapterPickLabel').textContent).toBe('SELECT ADAPTER');
    expect(el('adapterName').textContent).toBe('Wi-Fi 2');
    expect(el('adapterChip').textContent).toBe('NOT DETECTED');
    expect(el('adapterChip').classList.contains('missing')).toBe(true);
    expect(el('adapterRow').classList.contains('warn')).toBe(true);
    expect(el('adapterSelect').value).toBe('');
    expect(el('adapterSelect').options[0].disabled).toBe(true);
    expect(el('adapterSelect').options[0].textContent).toContain('NOT DETECTED');
    expect(el('joinStatus').textContent).toContain('SELECT AN ADAPTER');
    expect(gs.wifiScan).not.toHaveBeenCalled(); // no silent fallback to another adapter
    // Choosing an available adapter updates the card, persists, and rescans pinned to it.
    el('adapterSelect').value = 'Wi-Fi';
    el('adapterSelect').dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(gs.setSettings).toHaveBeenCalledWith({ network: { adapter: 'Wi-Fi' } });
    expect(el('adapterPickLabel').textContent).toBe('CHANGE ADAPTER');
    expect(el('adapterName').textContent).toBe('Wi-Fi');
    expect(el('adapterChip').textContent).toBe('CONNECTED');
    expect(el('adapterRow').classList.contains('warn')).toBe(false);
    expect(gs.wifiScan).toHaveBeenCalledWith({ iface: 'Wi-Fi' });
    expect(el('netList').children.length).toBe(1);
  });

  it('with two adapters the native <select> pins scan+join and updates the card on change (state kept per-adapter)', async () => {
    const gs = mockGs({
      wifiInterfaces: vi.fn(async () => ({
        ok: true,
        ifaces: [
          { name: 'Wi-Fi', description: 'Built-in', connected: true, ssid: 'HOME', signalPct: 84 },
          { name: 'Wi-Fi 2', description: 'RT5370', connected: false, ssid: '', signalPct: null },
        ],
      })),
    });
    await loadPitwall(gs);
    // Native control — keyboard + screen-reader intact, not a custom popup —
    // with a programmatic accessible name (no visible label is associated).
    expect(el('adapterSelect').tagName).toBe('SELECT');
    expect(el('adapterSelect').disabled).toBe(false);
    expect(el('adapterSelect').getAttribute('aria-label')).toBeTruthy();
    expect(el('adapterPickLabel').textContent).toBe('CHANGE ADAPTER');
    expect(el('adapterRow').classList.contains('interactive')).toBe(true);
    expect(el('adapterName').textContent).toBe('Wi-Fi'); // first preselected, its own state
    expect(el('adapterNet').textContent).toBe('HOME · 84%');
    expect(gs.wifiScan).toHaveBeenCalledWith({ iface: 'Wi-Fi' });
    // Switch to the dongle: the card reflects ITS separate state; scan+join re-pin.
    el('adapterSelect').value = 'Wi-Fi 2';
    el('adapterSelect').dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(gs.setSettings).toHaveBeenCalledWith({ network: { adapter: 'Wi-Fi 2' } });
    expect(el('adapterName').textContent).toBe('Wi-Fi 2');
    expect(el('adapterChip').textContent).toBe('DISCONNECTED');
    expect(el('adapterNet').classList.contains('hidden')).toBe(true); // not connected -> no SSID/signal
    expect(gs.wifiScan).toHaveBeenLastCalledWith({ iface: 'Wi-Fi 2' });
    document.querySelector('#netList .netrow').click();
    el('netPassword').value = PASSWORD;
    el('netJoinBtn').click();
    await tick();
    expect(gs.wifiJoin).toHaveBeenCalledWith({ ssid: 'PaddockNet', password: PASSWORD, iface: 'Wi-Fi 2', security: 'wpa2-personal', known: false });
  });
});

// Wi-Fi security scope end-to-end (audit B3 / Q3): the REAL renderer branches
// on the normalized `security` kind, so an open row warns + hides the password,
// a WPA3-only row is rejected before any join, enterprise is rejected, and
// malformed rows never appear. A multi-security scan drives all of it.
describe('Wi-Fi security scope (audit B3)', () => {
  const NETS = [
    { ssid: 'OpenCafe', signalPct: 80, known: false, auth: 'Open', security: 'open' },
    { ssid: 'HomeWPA2', signalPct: 75, known: false, auth: 'WPA2-Personal', security: 'wpa2-personal' },
    { ssid: 'Modern6E', signalPct: 65, known: false, auth: 'WPA3-Personal', security: 'wpa3-only' },
    { ssid: 'CorpNet', signalPct: 50, known: false, auth: 'WPA2-Enterprise', security: 'enterprise' },
    { ssid: 'SavedOpen', signalPct: 60, known: true, auth: 'Open', security: 'open' },
  ];
  const rowByName = (name) => [...document.querySelectorAll('#netList .netrow')]
    .find((r) => r.querySelector('b').textContent === name);

  async function pitwallWith(networks, extra = {}) {
    const gs = mockGs({ wifiScan: vi.fn(async () => ({ ok: true, networks })), ...extra });
    await loadPitwall(gs);
    return gs;
  }

  it('an OPEN network shows the OPEN NETWORK / unencrypted warning and NO password field; JOIN sends security:open', async () => {
    const gs = await pitwallWith(NETS);
    rowByName('OpenCafe').click();
    expect(el('netSecNote').classList.contains('hidden')).toBe(false);
    expect(el('netSecNote').textContent).toMatch(/OPEN NETWORK/);
    expect(el('netSecNote').textContent).toMatch(/unencrypted/i);
    expect(el('netPwRow').classList.contains('hidden')).toBe(false); // JOIN is available…
    expect(el('netPassword').classList.contains('hidden')).toBe(true); // …but no password field
    el('netJoinBtn').click();
    await tick();
    expect(gs.wifiJoin).toHaveBeenCalledWith({ ssid: 'OpenCafe', password: undefined, iface: undefined, security: 'open', known: false });
    expect(el('joinStatus').textContent).toBe('CONNECTED: OpenCafe');
  });

  it('a WPA2 network still prompts for a password (unchanged behavior)', async () => {
    await pitwallWith(NETS);
    rowByName('HomeWPA2').click();
    expect(el('netPwRow').classList.contains('hidden')).toBe(false);
    expect(el('netPassword').classList.contains('hidden')).toBe(false); // password field present
    expect(el('netSecNote').classList.contains('hidden')).toBe(true);   // no caution note for plain WPA2
  });

  it('a WPA3-only network is rejected with the exact Q3 message, no password field, no join call', async () => {
    const gs = await pitwallWith(NETS);
    rowByName('Modern6E').click();
    expect(el('netSecNote').textContent).toBe('WPA3-only networks are not currently supported. Use a WPA2 network or start the W17 hotspot.');
    expect(el('netSecNote').classList.contains('warn')).toBe(true);
    expect(el('netPwRow').classList.contains('hidden')).toBe(true); // no JOIN affordance
    el('netJoinBtn').click();
    await tick();
    expect(gs.wifiJoin).not.toHaveBeenCalled();
  });

  it('an ENTERPRISE network gets a clear unsupported message, not a PSK password prompt', async () => {
    const gs = await pitwallWith(NETS);
    rowByName('CorpNet').click();
    expect(el('netSecNote').textContent).toMatch(/Enterprise \(802\.1X\) networks are not currently supported/);
    expect(el('netPwRow').classList.contains('hidden')).toBe(true);
    el('netJoinBtn').click();
    await tick();
    expect(gs.wifiJoin).not.toHaveBeenCalled();
  });

  it('a SAVED open network joins via its profile (known:true), still showing the unencrypted warning', async () => {
    const gs = await pitwallWith(NETS);
    rowByName('SavedOpen').click();
    expect(el('netSecNote').textContent).toMatch(/OPEN NETWORK/);
    expect(el('netPassword').classList.contains('hidden')).toBe(true);
    el('netJoinBtn').click();
    await tick();
    expect(gs.wifiJoin).toHaveBeenCalledWith({ ssid: 'SavedOpen', password: undefined, iface: undefined, security: 'open', known: true });
  });

  it('selecting a rejected row then a valid one clears the warning and restores the password field', async () => {
    await pitwallWith(NETS);
    rowByName('Modern6E').click();               // WPA3-only reject
    expect(el('netPwRow').classList.contains('hidden')).toBe(true);
    rowByName('HomeWPA2').click();               // back to a normal WPA2 row
    expect(el('netSecNote').classList.contains('hidden')).toBe(true);
    expect(el('netPwRow').classList.contains('hidden')).toBe(false);
    expect(el('netPassword').classList.contains('hidden')).toBe(false);
  });

  it('the row badge shows the security kind (KNOWN when saved), never a raw localized auth string', async () => {
    await pitwallWith(NETS);
    expect(rowByName('OpenCafe').querySelector('.known').textContent).toBe('OPEN');
    expect(rowByName('HomeWPA2').querySelector('.known').textContent).toBe('WPA2');
    expect(rowByName('Modern6E').querySelector('.known').textContent).toBe('WPA3');
    expect(rowByName('SavedOpen').querySelector('.known').textContent).toBe('known');
  });

  it('a NEW unknown-security network is rejected conservatively: controlled message, no password, no join, raw only in the tooltip', async () => {
    const weird = { ssid: 'WeirdNet', signalPct: 45, known: false, auth: 'Some Odd Auth', encryption: 'CCMP', security: 'unknown' };
    const gs = await pitwallWith([...NETS, weird]);
    expect(rowByName('WeirdNet').querySelector('.known').textContent).toBe('?'); // badge, not raw auth
    rowByName('WeirdNet').click();
    // Controlled message is the primary text; the raw auth is NOT shown on screen…
    expect(el('netSecNote').textContent).toBe('This network’s security type could not be identified. Use a known WPA2 network or start the W17 hotspot.');
    expect(el('netSecNote').textContent).not.toMatch(/Some Odd Auth/);
    // …but the sanitized raw rides the tooltip for diagnostics.
    expect(el('netSecNote').title).toMatch(/Some Odd Auth/);
    expect(el('netPwRow').classList.contains('hidden')).toBe(true); // no password field, no JOIN
    el('netJoinBtn').click();
    await tick();
    expect(gs.wifiJoin).not.toHaveBeenCalled(); // no speculative join
  });

  it('an unknown-security network WITH a saved profile joins via it (known:true, builds nothing)', async () => {
    const savedWeird = { ssid: 'WeirdSaved', signalPct: 55, known: true, auth: 'Some Odd Auth', security: 'unknown' };
    const gs = await pitwallWith([...NETS, savedWeird]);
    rowByName('WeirdSaved').click();
    await tick();
    expect(gs.wifiJoin).toHaveBeenCalledWith({ ssid: 'WeirdSaved', password: undefined, iface: undefined, security: 'unknown', known: true });
    expect(el('joinStatus').textContent).toBe('CONNECTED: WeirdSaved');
  });
});

// Reachability wording (audit B4/C4): a successful check proves the PATH only.
describe('reachability wording (audit B4)', () => {
  it('a reachable check shows the path-only line + caveat, and never claims HUD receipt', async () => {
    const gs = mockGs({ probeHost: vi.fn(async () => ({ ok: true, status: 'reachable', rttMs: 5 })) });
    await loadPitwall(gs);
    el('iphoneAddr').value = '192.168.1.9';
    el('addrCheck').click();
    await tick();
    expect(el('addrStatus').textContent).toMatch(/network path only/);
    expect(el('addrNote').classList.contains('hidden')).toBe(false);
    expect(el('addrNote').textContent).toMatch(/proves the network path only/);
    expect(el('addrNote').textContent).toMatch(/iOS Local Network permission/);
    for (const forbidden of [/receiving/i, /\bHUD\b/, /permission (is )?granted/i]) {
      expect(el('addrStatus').textContent + el('addrNote').textContent).not.toMatch(forbidden);
    }
  });

  it('an unreachable check (exit-0 false-green upstream) shows a red line and no caveat', async () => {
    const gs = mockGs({ probeHost: vi.fn(async () => ({ ok: false, status: 'unreachable', error: 'destination unreachable — no route to the phone' })) });
    await loadPitwall(gs);
    el('iphoneAddr').value = '192.168.1.50';
    el('addrCheck').click();
    await tick();
    expect(el('addrStatus').textContent).toMatch(/UNREACHABLE/);
    expect(el('addrNote').classList.contains('hidden')).toBe(true); // no path-only caveat on a red result
  });
});

// IPHONE LINK row stability (Batch 1 / P3): the row holds ONLY label + input +
// CHECK. #addrStatus (a block .netstatus whose min-height reserves the line) and
// the #addrSuggest pill live on their OWN lines below the row, so a growing
// status string or the 2s suggest toggle can never re-center / horizontally
// shift the row. This pins the STRUCTURE; the CSS width/alignment contract lives
// in test/responsiveLayout.test.js.
describe('IPHONE LINK row structure (Batch 1 / P3)', () => {
  it('#addrStatus and #addrSuggest sit OUTSIDE .addrrow; the row holds only label/input/CHECK', async () => {
    await loadPitwall(mockGs());
    const addrrow = document.querySelector('.setup-screen[data-step="pitwall"] .addrrow');
    expect(addrrow).toBeTruthy();
    // The volatile bits moved out of the row (onto their own lines below it).
    expect(el('addrStatus').closest('.addrrow')).toBeNull();
    expect(el('addrSuggest').closest('.addrrow')).toBeNull();
    // The row still owns exactly the label, the IP input, and the CHECK button.
    expect(el('iphoneAddr').closest('.addrrow')).toBe(addrrow);
    expect(el('addrCheck').closest('.addrrow')).toBe(addrrow);
    expect(addrrow.querySelector('label')).toBeTruthy();
    expect(addrrow.contains(el('addrStatus'))).toBe(false);
    expect(addrrow.contains(el('addrSuggest'))).toBe(false);
    // #addrStatus reserves its own line as a block .netstatus.
    expect(el('addrStatus').classList.contains('netstatus')).toBe(true);
  });
});

// The HOTSPOT pane against the REAL lifecycle authority (audit B1/N3): the
// same HotspotLifecycle main.js runs, over the real HotspotManager with a
// routed fake runner, wired into the mocked preload surface — so a click in
// jsdom exercises the exact state machine the app ships.
const okRes = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '' });
const failRes = (stderr) => ({ ok: false, code: 1, stdout: '', stderr });

function routedRun(routes) {
  return async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`;
    for (const [needle, handler] of Object.entries(routes)) {
      if (key.includes(needle)) return typeof handler === 'function' ? handler() : handler;
    }
    return failRes(`unrouted: ${key.slice(0, 60)}`);
  };
}

const HOTSPOT_ROUTES = () => ({
  PROBE_OK: okRes('PROBE_STATE_Off\nPROBE_OK'),
  'wlan show drivers': okRes('    Hosted network supported  : Yes'),
  StartTetheringAsync: okRes('START_OK'),
  StopTetheringAsync: okRes('STOP_OK'),
});

function hotspotGs(routes, overrides = {}) {
  const manager = new HotspotManager({ run: routedRun(routes), platform: 'win32' });
  const lifecycle = new HotspotLifecycle({ manager });
  const gs = mockGs({
    hotspotStart: vi.fn((opts) => lifecycle.start(opts)),
    hotspotStop: vi.fn(() => lifecycle.stop()),
    hotspotState: vi.fn(async () => lifecycle.snapshot()),
    hotspotProbe: vi.fn((opts) => lifecycle.probe(opts || {})),
    onHotspotState: vi.fn((cb) => lifecycle.onChange(cb)),
    ...overrides,
  });
  return { gs, lifecycle, manager };
}

describe('HOTSPOT lifecycle pane (audit B1/N3)', () => {
  it('PIT WALL renders and stays usable while the probe is pending; completion updates the pane', async () => {
    let releaseProbe;
    const gate = new Promise((r) => { releaseProbe = r; });
    const { gs } = hotspotGs({
      ...HOTSPOT_ROUTES(),
      PROBE_OK: async () => { await gate; return okRes('PROBE_STATE_Off\nPROBE_OK'); },
    });
    await loadPitwall(gs);
    // The probe has NOT resolved, yet the step is fully rendered and usable.
    expect(el('hsStatus').textContent).toBe('CHECKING HOTSPOT SUPPORT…');
    expect(el('hsStart').disabled).toBe(true);
    expect(el('hsStop').disabled).toBe(true);
    expect(el('netList').children.length).toBe(1);                        // scan ran
    expect(el('adapterRow').classList.contains('hidden')).toBe(false);    // adapter card up
    expect(el('hsSsid').disabled).toBe(false);                            // inputs editable during probing
    releaseProbe();
    await tick();
    expect(el('hsStatus').textContent).toBe('READY — mobile backend');
    expect(el('hsStart').disabled).toBe(false);
    expect(el('hsStop').disabled).toBe(true); // nothing owned yet
  });

  it('a rejected probe IPC yields the controlled FAILED state, not CHECKING… forever', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const gs = mockGs({
      hotspotState: vi.fn(async () => ({
        phase: 'inactive', owned: false, backend: null, ssid: '', hostIp: null, lastError: null,
        probe: { status: 'probing' },
      })),
      hotspotProbe: vi.fn(async () => { throw new Error('ipc pipe died'); }),
    });
    await loadPitwall(gs);
    expect(el('hsStatus').textContent).toBe('HOTSPOT SUPPORT CHECK FAILED — RECHECK to retry');
    expect(el('hsRecheck').classList.contains('hidden')).toBe(false);
    expect(el('hsStart').disabled).toBe(true);
  });

  it('a broken support check is retryable from the pane: RECHECK re-probes and recovers', async () => {
    let broken = true;
    const { gs } = hotspotGs({
      ...HOTSPOT_ROUTES(),
      PROBE_OK: () => { if (broken) throw new Error('winrt exploded'); return okRes('PROBE_STATE_Off\nPROBE_OK'); },
    });
    await loadPitwall(gs);
    await tick();
    expect(el('hsStatus').textContent).toBe('HOTSPOT SUPPORT CHECK FAILED — RECHECK to retry');
    broken = false;
    el('hsRecheck').click();
    await tick();
    expect(el('hsStatus').textContent).toBe('READY — mobile backend');
    expect(el('hsStart').disabled).toBe(false);
  });

  it('an unsupported machine says so (capability, NOT adapter state) and disables START', async () => {
    const { gs } = hotspotGs({
      PROBE_OK: { ok: false, code: 2, stdout: 'RESULT_NO_PROFILE', stderr: '' },
      'wlan show drivers': okRes('    Hosted network supported  : No'),
    });
    await loadPitwall(gs);
    await tick();
    expect(el('hsStatus').textContent).toContain('NOT SUPPORTED');
    expect(el('hsStart').disabled).toBe(true);
    // adapter/network UI is independent of hotspot capability
    expect(el('adapterRow').classList.contains('hidden')).toBe(false);
    expect(el('netList').children.length).toBe(1);
  });

  it('START drives STARTING… -> LIVE; the state survives leaving and returning; STOP returns to READY', async () => {
    const { gs, lifecycle } = hotspotGs(HOTSPOT_ROUTES());
    await loadPitwall(gs);
    await tick();
    document.querySelector('[data-nettab="hotspot"]').click();
    el('hsStart').click();
    await tick();
    expect(el('hsStatus').textContent).toBe('LIVE (mobile) — join "W17-GRID" on the iPhone');
    expect(el('hsStatus').classList.contains('live')).toBe(true);
    expect(el('hsStart').disabled).toBe(true);
    expect(el('hsStop').disabled).toBe(false);
    expect(el('radioLog').textContent).toContain('HOTSPOT W17-GRID IS LIVE');
    // Navigate away and back while LIVE: the pane re-reads the authority. Batch
    // 8b: SEAT FIT now precedes PIT WALL, so BACK leaves and NEXT returns.
    el('navBack').click();
    await tick();
    expect(activeStep()).toBe('seatfit');
    el('navNext').click();
    await tick();
    expect(activeStep()).toBe('pitwall');
    expect(el('hsStatus').textContent).toContain('LIVE (mobile)');
    expect(el('hsStop').disabled).toBe(false);
    // STOP: back to INACTIVE/READY, ownership released.
    el('hsStop').click();
    await tick();
    expect(el('hsStatus').textContent).toBe('READY — mobile backend');
    expect(el('hsStop').disabled).toBe(true);
    expect(el('radioLog').textContent).toContain('HOTSPOT STOPPED');
    expect(lifecycle.snapshot()).toMatchObject({ phase: 'inactive', owned: false });
  });

  it('conflicting controls are disabled while STARTING (no duplicate requests from the UI)', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { gs } = hotspotGs({
      ...HOTSPOT_ROUTES(),
      StartTetheringAsync: async () => { await gate; return okRes('START_OK'); },
    });
    await loadPitwall(gs);
    await tick();
    el('hsStart').click();
    await tick();
    expect(el('hsStatus').textContent).toBe('STARTING HOTSPOT…');
    expect(el('hsStart').disabled).toBe(true);
    expect(el('hsStop').disabled).toBe(true);
    expect(el('hsSsid').disabled).toBe(true);
    expect(el('hsPass').disabled).toBe(true);
    release();
    await tick();
    expect(el('hsStatus').textContent).toContain('LIVE (mobile)');
  });

  it('a failed STOP keeps LIVE + ownership with the error shown; retry succeeds', async () => {
    let stopBroken = true;
    const { gs, lifecycle } = hotspotGs({
      ...HOTSPOT_ROUTES(),
      StopTetheringAsync: () => (stopBroken ? failRes('winrt stop threw') : okRes('STOP_OK')),
    });
    await loadPitwall(gs);
    await tick();
    el('hsStart').click();
    await tick();
    el('hsStop').click();
    await tick();
    expect(el('hsStatus').textContent).toContain('STOP FAILED');
    expect(el('hsHint').textContent).toContain('STOP HOTSPOT to retry');
    expect(el('hsStop').disabled).toBe(false); // retry stays available
    expect(lifecycle.snapshot()).toMatchObject({ phase: 'live', owned: true });
    stopBroken = false;
    el('hsStop').click();
    await tick();
    expect(el('hsStatus').textContent).toBe('READY — mobile backend');
    expect(lifecycle.snapshot()).toMatchObject({ phase: 'inactive', owned: false });
  });

  it('a late-arriving OLDER snapshot never overwrites a newer one (IPC delivery-order guard)', async () => {
    // Electron does not guarantee push arrival order (seen in the Electron sim
    // acceptance pass: 'probing' delivered AFTER its own completion snapshot).
    // The renderer must key on the authority's seq, not on arrival order.
    let push;
    const gs = mockGs({ onHotspotState: vi.fn((cb) => { push = cb; return () => {}; }) });
    await loadPitwall(gs);
    const base = {
      phase: 'inactive', owned: false, backend: null, ssid: '', hostIp: null, lastError: null,
    };
    push({ ...base, seq: 2, probe: { status: 'supported', backend: 'mobile', externallyActive: false } });
    expect(el('hsStatus').textContent).toBe('READY — mobile backend');
    push({ ...base, seq: 1, probe: { status: 'probing' } }); // stale push arrives late
    expect(el('hsStatus').textContent).toBe('READY — mobile backend'); // dropped, not rendered
    expect(el('hsStart').disabled).toBe(false);
  });

  it('a probe resolving after leaving PIT WALL never touches the DOM; re-entry reuses the cached result', async () => {
    let probeRuns = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const { gs } = hotspotGs({
      ...HOTSPOT_ROUTES(),
      PROBE_OK: async () => { probeRuns += 1; await gate; return okRes('PROBE_STATE_Off\nPROBE_OK'); },
    });
    await loadPitwall(gs);
    expect(el('hsStatus').textContent).toBe('CHECKING HOTSPOT SUPPORT…');
    el('navBack').click(); // leave while the probe is in flight (Batch 8b: SEAT FIT precedes PIT WALL)
    await tick();
    expect(activeStep()).toBe('seatfit');
    release();
    await tick();
    // The stale completion did NOT rewrite the (now hidden) PIT WALL pane.
    expect(el('hsStatus').textContent).toBe('CHECKING HOTSPOT SUPPORT…');
    el('navNext').click();
    await tick();
    // Re-entry renders the cached result — and spawned no second probe.
    expect(el('hsStatus').textContent).toBe('READY — mobile backend');
    expect(probeRuns).toBe(1);
  });
});

// The renderer's snapshot-adoption ordering guard (the lifecycle sequence race
// found in the Electron sim acceptance pass): Electron does NOT guarantee that
// main->renderer state pushes arrive in emit order, so the renderer keys on the
// authority's monotonic `seq`, dropping any snapshot older than the newest it
// holds. These drive the REAL renderer through both the push path (the captured
// onHotspotState callback) and the pull path (PIT WALL re-entry).
describe('hotspot snapshot adoption / lifecycle sequence race (audit B1)', () => {
  // A push-capturing mock: `push(snap)` delivers a main-shaped snapshot; the
  // pull (`hotspotState`) returns whatever `pull.snap` currently is. The probe
  // resolves 'supported' but never auto-pushes (no real lifecycle wired), so
  // tests control every snapshot the renderer sees.
  function captureGs(initialPull) {
    let push;
    const pull = { snap: initialPull };
    const gs = mockGs({
      onHotspotState: vi.fn((cb) => { push = cb; return () => {}; }),
      hotspotState: vi.fn(async () => pull.snap),
    });
    return { gs, deliver: (s) => push(s), pull };
  }
  const LIVE = (seq) => ({
    seq, phase: 'live', owned: true, backend: 'mobile', ssid: 'W17-GRID', hostIp: null,
    lastError: null, probe: { status: 'supported', backend: 'mobile', externallyActive: false },
  });
  const STARTING = (seq) => ({
    seq, phase: 'starting', owned: false, backend: null, ssid: '', hostIp: null,
    lastError: null, probe: { status: 'supported', backend: 'mobile', externallyActive: false },
  });
  const STOPPING = (seq) => ({
    seq, phase: 'stopping', owned: true, backend: 'mobile', ssid: 'W17-GRID', hostIp: null,
    lastError: null, probe: { status: 'supported', backend: 'mobile', externallyActive: false },
  });
  const READY = (seq) => ({
    seq, phase: 'inactive', owned: false, backend: null, ssid: '', hostIp: null,
    lastError: null, probe: { status: 'supported', backend: 'mobile', externallyActive: false },
  });
  const STOP_FAILED = (seq) => ({
    seq, phase: 'live', owned: true, backend: 'mobile', ssid: 'W17-GRID', hostIp: null,
    lastError: { kind: 'stop-failed', error: 'winrt stop threw' },
    probe: { status: 'supported', backend: 'mobile', externallyActive: false },
  });

  it('pushed LIVE seq 5 then a stale PULLED STARTING seq 4 (on re-entry) leaves LIVE', async () => {
    const { gs, deliver, pull } = captureGs(READY(1));
    await loadPitwall(gs);
    deliver(LIVE(5));
    expect(el('hsStatus').textContent).toContain('LIVE (mobile)');
    // Re-entry pulls a STALE snapshot (seq 4) — it must be dropped.
    pull.snap = STARTING(4);
    el('navBack').click(); await tick(); // Batch 8b: SEAT FIT precedes PIT WALL — leave and return
    el('navNext').click(); await tick();
    expect(el('hsStatus').textContent).toContain('LIVE (mobile)');
    expect(el('hsStart').disabled).toBe(true);
    expect(el('hsStop').disabled).toBe(false);
  });

  it('pulled LIVE seq 5 then a stale PUSHED STARTING seq 4 leaves LIVE', async () => {
    const { gs, deliver } = captureGs(LIVE(5));
    await loadPitwall(gs);
    expect(el('hsStatus').textContent).toContain('LIVE (mobile)');
    deliver(STARTING(4)); // stale push arrives late
    expect(el('hsStatus').textContent).toContain('LIVE (mobile)');
    expect(el('hsStop').disabled).toBe(false);
  });

  it('an equal-sequence duplicate delivery is idempotent (re-render, same result, no throw)', async () => {
    const { gs, deliver } = captureGs(READY(3));
    await loadPitwall(gs);
    expect(el('hsStatus').textContent).toBe('READY — mobile backend');
    deliver(READY(3)); // exact duplicate seq
    deliver(READY(3));
    expect(el('hsStatus').textContent).toBe('READY — mobile backend');
    expect(el('hsStart').disabled).toBe(false);
  });

  it('a NEWER STOPPING sequence is adopted over LIVE', async () => {
    const { gs, deliver } = captureGs(READY(1));
    await loadPitwall(gs);
    deliver(LIVE(5));
    expect(el('hsStatus').textContent).toContain('LIVE (mobile)');
    deliver(STOPPING(6));
    expect(el('hsStatus').textContent).toBe('STOPPING HOTSPOT…');
    expect(el('hsStart').disabled).toBe(true);
    expect(el('hsStop').disabled).toBe(true);
  });

  it('a NEWER LIVE-with-stop-error sequence is adopted (STOP FAILED, retry enabled)', async () => {
    const { gs, deliver } = captureGs(READY(1));
    await loadPitwall(gs);
    deliver(LIVE(5));
    deliver(STOP_FAILED(8));
    expect(el('hsStatus').textContent).toContain('STOP FAILED');
    expect(el('hsHint').textContent).toContain('STOP HOTSPOT to retry');
    expect(el('hsStop').disabled).toBe(false);
    expect(el('hsStart').disabled).toBe(true);
  });

  it('an OLD snapshot cannot re-enable START while the hotspot is owned', async () => {
    const { gs, deliver } = captureGs(READY(1));
    await loadPitwall(gs);
    deliver(LIVE(5)); // owned, START disabled
    expect(el('hsStart').disabled).toBe(true);
    expect(el('hsStop').disabled).toBe(false);
    deliver(READY(4)); // stale "inactive/READY" would enable START — must be dropped
    expect(el('hsStart').disabled).toBe(true);
    expect(el('hsStop').disabled).toBe(false);
    expect(el('hsStatus').textContent).toContain('LIVE (mobile)');
  });

  it('initial boot with no previously held snapshot adopts the first pull (seq 0)', async () => {
    const { gs } = captureGs(READY(0)); // main just started: seq 0
    await loadPitwall(gs);
    expect(el('hsStatus').textContent).toBe('READY — mobile backend');
    expect(el('hsStart').disabled).toBe(false);
  });

  it('over the REAL lifecycle, seq survives start -> live -> stop and re-entry restores the authoritative state', async () => {
    const { gs, lifecycle } = hotspotGs(HOTSPOT_ROUTES());
    await loadPitwall(gs);
    await tick();
    const seq0 = lifecycle.snapshot().seq;
    document.querySelector('[data-nettab="hotspot"]').click();
    el('hsStart').click();
    await tick();
    expect(el('hsStatus').textContent).toContain('LIVE (mobile)');
    const seqLive = lifecycle.snapshot().seq;
    expect(seqLive).toBeGreaterThan(seq0);
    // Leave and return while LIVE: the re-entry pull carries the authoritative
    // (higher) seq and is adopted — the pane restores LIVE, not a stale READY.
    el('navBack').click(); await tick(); // Batch 8b: SEAT FIT precedes PIT WALL — leave and return
    el('navNext').click(); await tick();
    expect(el('hsStatus').textContent).toContain('LIVE (mobile)');
    expect(el('hsStop').disabled).toBe(false);
    el('hsStop').click();
    await tick();
    expect(el('hsStatus').textContent).toBe('READY — mobile backend');
    expect(lifecycle.snapshot().seq).toBeGreaterThan(seqLive);
  });
});

// ===================== Batch C DOM integration =====================

// C1 (audit L3): the video-state model drives BOTH the HUD overlay wording and
// the GRID VIDEO LOCK check from one authority. Media events are dispatched on
// the real <video>; a stalled/reconnecting stream must never read as green.
describe('video state -> HUD overlay + GRID lock (audit C1)', () => {
  it('the feed note follows the media events and hides only when confidently live', async () => {
    await loadRenderer(mockGs());
    const feed = el('feed');
    const noteText = () => el('feedNoteText').textContent;
    const hidden = () => el('feedNote').classList.contains('hidden');
    expect(noteText()).toBe('NO VIDEO');       // idle at boot
    expect(hidden()).toBe(false);
    feed.dispatchEvent(new Event('playing'));
    expect(hidden()).toBe(true);               // VIDEO LIVE -> overlay hidden
    feed.dispatchEvent(new Event('waiting'));
    expect(hidden()).toBe(false);
    expect(noteText()).toBe('BUFFERING');
    feed.dispatchEvent(new Event('stalled'));
    expect(noteText()).toBe('STREAM STALLED');
    expect(el('feedNote').classList.contains('v-warn')).toBe(true);
    feed.dispatchEvent(new Event('error'));
    expect(noteText()).toBe('VIDEO ERROR');
    expect(el('feedNote').classList.contains('v-error')).toBe(true);
    feed.dispatchEvent(new Event('emptied'));
    expect(noteText()).toBe('NO VIDEO');        // torn down -> inactive
    feed.dispatchEvent(new Event('playing'));   // reconnect -> live again
    expect(hidden()).toBe(true);
  });

  it('GRID VIDEO LOCK goes green on live frames and drops (no stale green) when the stream stalls', async () => {
    const gs = mockGs();
    await loadRenderer(gs);
    const videoRow = () => [...el('checkList').children]
      .find((r) => r.querySelector('b')?.textContent === 'VIDEO LOCK');
    // Frames flow BEFORE reaching GRID, so the immediate gridTick sees live.
    el('feed').dispatchEvent(new Event('playing'));
    document.querySelector('.modecard[data-mode="solo"]').click(); // -> seatfit
    await tick();
    el('navNext').click(); // -> grid; enterGrid runs an immediate gridTick
    await tick(); await tick();
    expect(activeStep()).toBe('grid');
    expect(videoRow().classList.contains('ok')).toBe(true);
    // The stream dies with a 'stalled' (NOT 'emptied'): re-entering GRID, the
    // immediate gridTick must now read the lock as NOT green.
    el('feed').dispatchEvent(new Event('stalled'));
    el('changeSetup').click(); // -> garage
    await tick();
    document.querySelector('.modecard[data-mode="solo"]').click(); // -> seatfit
    await tick();
    el('navNext').click(); // -> grid again
    await tick(); await tick();
    expect(videoRow().classList.contains('ok')).toBe(false);
  });
});

// C2 (audit D1/Q4): a compact persistent TELEMETRY · REPLAY chip in the HUD
// session panel whenever the EFFECTIVE telemetry source is replay/synthetic —
// separate from the PIT WALL SIMULATED WIFI tag and the W3 log-only chip.
describe('replay telemetry chip (audit C2)', () => {
  const chipHidden = () => el('replayChip').classList.contains('hidden');

  it('shows the chip when the effective telemetry source is replay', async () => {
    const gs = mockGs({ getConfig: vi.fn(async () => ({ whepUrl: '', w3Active: false, feel: null, telemetrySource: 'replay' })) });
    await loadRenderer(gs);
    expect(chipHidden()).toBe(false);
    expect(el('replayChip').textContent).toBe('TELEMETRY · REPLAY');
  });

  it('hides the chip for a live/none source', async () => {
    await loadRenderer(mockGs()); // telemetrySource: 'none'
    expect(chipHidden()).toBe(true);
  });

  it('Wi-Fi simulation alone does NOT trigger the replay chip (separate subsystems)', async () => {
    const gs = mockGs({
      getConfig: vi.fn(async () => ({ whepUrl: '', w3Active: false, feel: null, telemetrySource: 'none' })),
      wifiCapabilities: vi.fn(async () => ({ canScan: true, canHotspot: true, sim: true })),
    });
    await loadPitwall(gs);
    expect(el('wifiSimTag').classList.contains('hidden')).toBe(false); // SIMULATED WIFI up
    expect(chipHidden()).toBe(true);                                   // but no replay chip
  });

  it('replay and the W3 log-only chip are independent (both can show at once)', async () => {
    const gs = mockGs({ getConfig: vi.fn(async () => ({ whepUrl: '', w3Active: true, feel: null, telemetrySource: 'replay' })) });
    await loadRenderer(gs);
    expect(chipHidden()).toBe(false);
    expect(el('w3Chip').classList.contains('hidden')).toBe(false);
    expect(el('replayChip')).not.toBe(el('w3Chip')); // distinct elements
  });

  it('a runtime ⚙ source switch updates the chip immediately, and it carries no dismiss control', async () => {
    let src = 'replay';
    const gs = mockGs({ applySession: vi.fn(async () => ({ telemetry: src, w3: false })) });
    await loadRenderer(gs);
    el('settingsBtn').click(); // open ⚙
    el('setTelemetrySource').value = 'replay';
    el('setTelemetrySource').dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(chipHidden()).toBe(false);
    // Not dismissible: it is a plain marker, no interactive control inside.
    expect(el('replayChip').tagName).toBe('DIV');
    expect(el('replayChip').querySelector('button')).toBeNull();
    // Switch back to a live source -> the chip clears.
    src = 'none';
    el('setTelemetrySource').value = 'none';
    el('setTelemetrySource').dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(chipHidden()).toBe(true);
  });
});

// C3 (audit D3/Q8): env-locked ⚙ controls show the EFFECTIVE value, an amber
// ENV badge naming the exact variable, and are non-editable; unlocked controls
// are unchanged; partial locks work; a locked field's value is never persisted.
describe('env-locked settings presentation (audit C3)', () => {
  function settingsGs({ envOverridden = {}, effective = {} } = {}, overrides = {}) {
    const settings = defaultSettings();
    return mockGs({
      getSettings: vi.fn(async () => ({ settings, envOverridden, effective })),
      ...overrides,
    });
  }
  const openMenu = () => el('settingsBtn').click();

  it('with no env overrides every control is editable and no ENV badge shows', async () => {
    await loadRenderer(settingsGs());
    openMenu();
    expect(el('setTelemetrySource').disabled).toBe(false);
    expect(el('setTelemetryPort').readOnly).toBe(false);
    expect(el('setW3').disabled).toBe(false);
    for (const id of ['setW3Env', 'setTelemetrySourceEnv', 'setTelemetryPortEnv']) {
      expect(el(id).classList.contains('hidden')).toBe(true);
    }
  });

  it('a locked telemetry source shows the effective value, disables the select, and badges W17_TELEMETRY_SOURCE (port stays editable)', async () => {
    await loadRenderer(settingsGs({ envOverridden: { telemetrySource: true }, effective: { telemetrySource: 'replay', telemetryPort: '', w3: false } }));
    openMenu();
    expect(el('setTelemetrySource').disabled).toBe(true);
    expect(el('setTelemetrySource').value).toBe('replay');        // effective, not persisted 'none'
    expect(el('setTelemetrySourceEnv').classList.contains('hidden')).toBe(false);
    expect(el('setTelemetrySourceEnv').title).toContain('W17_TELEMETRY_SOURCE');
    expect(el('setTelemetrySourceEnv').title).toMatch(/precedence/i);
    expect(el('setTelemetrySourceEnv').getAttribute('aria-label')).toContain('W17_TELEMETRY_SOURCE');
    expect(el('setTelemetrySource').getAttribute('aria-describedby')).toBe('setTelemetrySourceEnv');
    // Partial lock: the port is a different variable, still editable.
    expect(el('setTelemetryPort').readOnly).toBe(false);
    expect(el('setTelemetryPortEnv').classList.contains('hidden')).toBe(true);
  });

  it('a locked head-track toggle shows the effective on-state, disables the checkbox, and badges W17_HEADTRACK', async () => {
    await loadRenderer(settingsGs({ envOverridden: { w3: true }, effective: { w3: true, telemetrySource: 'none', telemetryPort: '' } }));
    openMenu();
    expect(el('setW3').disabled).toBe(true);
    expect(el('setW3').checked).toBe(true); // effective on
    expect(el('setW3Env').classList.contains('hidden')).toBe(false);
    expect(el('setW3Env').title).toContain('W17_HEADTRACK');
  });

  it('a locked telemetry port uses readonly (stays focusable) and badges W17_TELEMETRY_PORT without leaking the value', async () => {
    await loadRenderer(settingsGs({ envOverridden: { telemetryPort: true }, effective: { telemetryPort: '9999', telemetrySource: 'none', w3: false } }));
    openMenu();
    expect(el('setTelemetryPort').readOnly).toBe(true);
    expect(el('setTelemetryPort').disabled).toBe(false); // readonly, not disabled -> focusable + tooltip
    expect(el('setTelemetryPort').value).toBe('9999');
    expect(el('setTelemetryPortEnv').classList.contains('hidden')).toBe(false);
    expect(el('setTelemetryPortEnv').title).toContain('W17_TELEMETRY_PORT');
    expect(el('setTelemetryPortEnv').title).not.toContain('9999'); // the VALUE is never in the tooltip
    // Source not locked -> editable.
    expect(el('setTelemetrySource').disabled).toBe(false);
  });

  it('a locked field is never persisted: editing the unlocked port saves only the port, never the locked source', async () => {
    const gs = settingsGs({ envOverridden: { telemetrySource: true }, effective: { telemetrySource: 'replay', telemetryPort: '', w3: false } });
    await loadRenderer(gs);
    openMenu();
    el('setTelemetryPort').value = 'COM7';
    el('setTelemetryPort').dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(gs.setSettings).toHaveBeenCalledWith({ telemetry: { port: 'COM7' } });
    const wroteSource = gs.setSettings.mock.calls.some((c) => c[0]?.telemetry?.source !== undefined);
    expect(wroteSource).toBe(false); // the locked source's effective value is never written back
  });

  it('a locked head-track change is suppressed (never persisted)', async () => {
    const gs = settingsGs({ envOverridden: { w3: true }, effective: { w3: true, telemetrySource: 'none', telemetryPort: '' } });
    await loadRenderer(gs);
    openMenu();
    gs.setSettings.mockClear();
    el('setW3').dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(gs.setSettings).not.toHaveBeenCalled();
  });
});

// C5 (audit D2/Q5): iPhone Cockpit mode documents that W2 telemetry begins on
// GRID entry as preflight evidence; Desktop mode must not show iPhone wording.
describe('W2-on-GRID note (audit C5)', () => {
  it('iPhone mode GRID explains the preflight telemetry behavior + path-only caveat', async () => {
    const settings = { ...defaultSettings(), fpvMode: 'iphone-hud', iphoneAddr: '192.168.1.9', setupCompleted: true };
    const gs = mockGs({ getSettings: vi.fn(async () => ({ settings, envOverridden: {} })) });
    await loadRenderer(gs);
    el('fastPathBtn').click(); // Batch 8a: resume from the GARAGE fast-path card
    await tick();
    expect(activeStep()).toBe('grid');
    expect(el('gridNote').classList.contains('hidden')).toBe(false);
    expect(el('gridNote').textContent).toMatch(/begins receiving telemetry on GRID/);
    expect(el('gridNote').textContent).toMatch(/before START/);
    expect(el('gridNote').textContent).toMatch(/network path only/);
  });

  it('Desktop mode GRID shows no iPhone wording', async () => {
    const settings = { ...defaultSettings(), fpvMode: 'solo', setupCompleted: true };
    const gs = mockGs({ getSettings: vi.fn(async () => ({ settings, envOverridden: {} })) });
    await loadRenderer(gs);
    el('fastPathBtn').click(); // Batch 8a: resume from the GARAGE fast-path card
    await tick();
    expect(activeStep()).toBe('grid');
    expect(el('gridNote').classList.contains('hidden')).toBe(true);
    expect(el('gridNote').textContent).toBe('');
  });
});

// ===================== Batch D2 renderer integration =====================

// Boot/config resilience + subscription/timer hygiene (audit D2): the initial
// config fetch may reject without killing the flow; the push subscriptions are
// module-lifetime singletons; and the step-scoped poll intervals must follow
// entry/leave exactly — an interval that survives navigation would ping/probe
// forever from the wrong screen (the D2 orphaned-timer race, fixed with the
// entry-epoch guards in setupFlow.js).
describe('renderer boot/config integration (audit D2)', () => {
  it('a rejected initial config load keeps the flow booting (HUD falls back; no unhandled rejection)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const gs = mockGs({ getConfig: vi.fn(async () => { throw new Error('config handler died'); }) });
    await loadRenderer(gs);
    expect(activeStep()).toBe('garage'); // the setup flow is unaffected
    expect(gs.onTelemetry).toHaveBeenCalledTimes(1); // HUD kept running and still subscribed
    expect(errSpy.mock.calls.flat().map(String).join('\n')).toContain('config load failed');
  });

  it('push subscriptions are module-lifetime singletons: navigation never re-subscribes', async () => {
    const gs = mockGs();
    await loadPitwall(gs);
    el('navBack').click(); await tick(); // -> seatfit (Batch 8b: SEAT FIT precedes PIT WALL)
    el('navNext').click(); await tick(); // -> pitwall (re-entry)
    el('navBack').click(); await tick();
    el('navNext').click(); await tick();
    expect(gs.onHotspotState).toHaveBeenCalledTimes(1);
    expect(gs.onTelemetry).toHaveBeenCalledTimes(1);
  });

  it('leaving PIT WALL while the capability check is in flight leaks no poll timer (D2 race fix)', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const gs = mockGs({
      wifiCapabilities: vi.fn(async () => { await gate; return { canScan: true, canHotspot: true, sim: true }; }),
    });
    await loadRenderer(gs);
    vi.useFakeTimers();
    try {
      document.querySelector('.modecard[data-mode="iphone-hud"]').click();
      await vi.advanceTimersByTimeAsync(0); // flush the save microtask -> SEAT FIT (Batch 8b order)
      expect(activeStep()).toBe('seatfit');
      el('navNext').click(); // SEAT FIT -> PIT WALL; enterPitwall now awaits capabilities
      await vi.advanceTimersByTimeAsync(0);
      expect(activeStep()).toBe('pitwall'); // rendered; enterPitwall still awaiting capabilities
      el('navBack').click(); // leave before the check resolves
      await vi.advanceTimersByTimeAsync(0);
      expect(activeStep()).toBe('seatfit');
      release();
      await vi.advanceTimersByTimeAsync(0); // let the stale continuation run out
      expect(gs.wifiInterfaces).not.toHaveBeenCalled(); // aborted before the adapter listing
      const polls = gs.getAddrHint.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(gs.getAddrHint.mock.calls.length).toBe(polls); // no orphaned 2 s hint poll
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaving GRID while the session apply is in flight leaks no checklist poll (D2 race fix)', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const settings = {
      ...defaultSettings(), setupCompleted: true, fpvMode: 'iphone-hud',
      iphoneAddr: '192.168.1.9', elrsPath: 'C:/elrs/elrs-joystick-control.exe',
    };
    const gs = mockGs({
      getSettings: vi.fn(async () => ({ settings, envOverridden: {} })),
      applySession: vi.fn(async () => { await gate; return { telemetry: 'none', w3: false }; }),
    });
    await loadRenderer(gs); // Batch 8a: setupCompleted -> GARAGE fast-path card
    el('fastPathBtn').click(); // resume to GRID; apply still pending
    expect(activeStep()).toBe('grid');
    vi.useFakeTimers();
    try {
      el('changeSetup').click(); // leave GRID before the apply resolves
      expect(activeStep()).toBe('garage');
      release();
      await vi.advanceTimersByTimeAsync(0); // stale enterGrid continuation runs out
      const probes = gs.probeHost.mock.calls.length;
      const elrsChecks = gs.elrsStatus.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(gs.probeHost.mock.calls.length).toBe(probes);   // no orphaned 1 s ping loop
      expect(gs.elrsStatus.mock.calls.length).toBe(elrsChecks); // no orphaned elrs poll
    } finally {
      vi.useRealTimers();
    }
  });

  it('the addr-hint poll follows PIT WALL exactly: one interval while active, zero after leaving, one again on re-entry', async () => {
    const gs = mockGs();
    await loadRenderer(gs);
    // Fake timers must own the clock BEFORE the interval is created, so the
    // whole PIT WALL entry happens under them.
    vi.useFakeTimers();
    const settle = async () => {
      for (let i = 0; i < 3; i += 1) await vi.advanceTimersByTimeAsync(1);
    };
    try {
      document.querySelector('.modecard[data-mode="iphone-hud"]').click();
      await settle(); // -> SEAT FIT (Batch 8b order)
      expect(activeStep()).toBe('seatfit');
      el('navNext').click(); // SEAT FIT -> PIT WALL
      await settle();
      expect(activeStep()).toBe('pitwall');
      const initial = gs.getAddrHint.mock.calls.length;
      expect(initial).toBeGreaterThan(0); // the immediate entry poll ran
      await vi.advanceTimersByTimeAsync(6_000);
      expect(gs.getAddrHint.mock.calls.length - initial).toBe(3); // ONE 2 s interval, not two
      el('navBack').click(); // -> seatfit; leavePitwall clears the poll
      await settle();
      const atLeave = gs.getAddrHint.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(gs.getAddrHint.mock.calls.length).toBe(atLeave); // fully stopped off-step
      el('navNext').click(); // re-enter PIT WALL
      await settle();
      const reentry = gs.getAddrHint.mock.calls.length;
      await vi.advanceTimersByTimeAsync(4_000);
      expect(gs.getAddrHint.mock.calls.length - reentry).toBe(2); // still exactly one interval
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('hotspot credential — transient join key + honest storage status (audit E1)', () => {
  it('a Wi-Fi join never persists the join password (it rides wifi:join only)', async () => {
    const gs = mockGs();
    await loadPitwall(gs);
    document.querySelector('#netList .netrow').click(); // unknown net -> password row
    el('netPassword').value = PASSWORD;
    el('netJoinBtn').click();
    await tick();
    expect(gs.wifiJoin).toHaveBeenCalled();
    // The join key is NEVER written to settings — no setSettings patch carries it.
    const persistedJoinKey = gs.setSettings.mock.calls.some(
      (c) => JSON.stringify(c[0] || {}).includes(PASSWORD),
    );
    expect(persistedJoinKey).toBe(false);
  });

  it('shows a session-only note (never the value) when secure storage is unavailable', async () => {
    const gs = mockGs({
      getSettings: vi.fn(async () => ({
        settings: defaultSettings(), envOverridden: {},
        credential: { state: 'session-only', encryptionAvailable: false, hasPassword: true },
      })),
    });
    await loadPitwall(gs);
    const note = el('hsCredNote');
    expect(note.classList.contains('hidden')).toBe(false);
    expect(note.textContent).toMatch(/session only/i);
    expect(note.textContent).not.toContain(HS_PASSWORD);
  });

  it('shows an "enter it again" note when the saved credential is undecryptable', async () => {
    const gs = mockGs({
      getSettings: vi.fn(async () => ({
        settings: defaultSettings(), envOverridden: {},
        credential: { state: 'undecryptable', encryptionAvailable: true, hasPassword: false },
      })),
    });
    await loadPitwall(gs);
    expect(el('hsCredNote').classList.contains('hidden')).toBe(false);
    expect(el('hsCredNote').textContent).toMatch(/enter it again/i);
  });

  it('shows no credential note when the credential is safely persisted', async () => {
    const gs = mockGs({
      getSettings: vi.fn(async () => ({
        settings: defaultSettings(), envOverridden: {},
        credential: { state: 'persisted', encryptionAvailable: true, hasPassword: true },
      })),
    });
    await loadPitwall(gs);
    expect(el('hsCredNote').classList.contains('hidden')).toBe(true);
    expect(el('hsCredNote').textContent).toBe('');
  });
});

describe('live adapter monitor mirror (2B, Windows observation #2/#3)', () => {
  it('a dongle plugged in while PIT WALL is open appears WITHOUT leaving the page; losing the selected adapter invalidates the pick (no auto-switch)', async () => {
    let pushCb = null;
    const settings = { ...defaultSettings(), fpvMode: 'iphone-hud', network: { kind: 'join', adapter: 'Wi-Fi 2', hotspot: { ssid: 'W17-GRID', password: HS_PASSWORD } } };
    const gs = mockGs({
      getSettings: vi.fn(async () => ({ settings, envOverridden: {} })),
      setSettings: vi.fn(async () => settings),
      // seed: both adapters present, saved = 'Wi-Fi 2'
      adapterState: vi.fn(async () => ({ seq: 1, ok: true, ifaces: [{ name: 'Wi-Fi', connected: false }, { name: 'Wi-Fi 2', connected: false }], error: null, added: ['Wi-Fi', 'Wi-Fi 2'], removed: [] })),
      onAdapterState: vi.fn((cb) => { pushCb = cb; return () => {}; }),
    });
    await loadPitwall(gs);
    // seeded from the monitor snapshot: a picker with the saved adapter selected
    expect([...el('adapterSelect').options].map((o) => o.value)).toEqual(['Wi-Fi', 'Wi-Fi 2']);
    expect(el('adapterSelect').value).toBe('Wi-Fi 2');

    // the selected dongle is pulled → live push (higher seq) → the card must
    // mark it NOT DETECTED and select NOTHING (never silently fall to 'Wi-Fi').
    pushCb({ seq: 2, ok: true, ifaces: [{ name: 'Wi-Fi', connected: false }], error: null, added: [], removed: ['Wi-Fi 2'] });
    await tick();
    expect(el('adapterName').textContent).toBe('Wi-Fi 2');
    expect(el('adapterChip').textContent).toBe('NOT DETECTED');
    expect(el('adapterSelect').value).toBe(''); // selection invalidated, NOT auto-switched

    // the dongle comes back → live push → the picker offers it again
    pushCb({ seq: 3, ok: true, ifaces: [{ name: 'Wi-Fi', connected: false }, { name: 'Wi-Fi 2', connected: false }], error: null, added: ['Wi-Fi 2'], removed: [] });
    await tick();
    expect([...el('adapterSelect').options].map((o) => o.value)).toEqual(['Wi-Fi', 'Wi-Fi 2']);
  });

  it('an out-of-order (lower-seq) adapter push is dropped', async () => {
    let pushCb = null;
    const gs = mockGs({
      adapterState: vi.fn(async () => ({ seq: 5, ok: true, ifaces: [{ name: 'Wi-Fi', connected: false }], error: null, added: ['Wi-Fi'], removed: [] })),
      onAdapterState: vi.fn((cb) => { pushCb = cb; return () => {}; }),
    });
    await loadPitwall(gs);
    // a stale push (seq 2 < seeded 5) must not wipe the list
    pushCb({ seq: 2, ok: true, ifaces: [], error: null, added: [], removed: ['Wi-Fi'] });
    await tick();
    expect(el('adapterStatus').textContent).not.toBe('NO WLAN ADAPTER DETECTED');
  });
});

// SEAT FIT — camera mode + controller mirror against the REAL renderer (tasks
// §1A / §3 / §4 / §5). The pure models (shared/cameraMode.mjs, inputPresets.mjs)
// are unit-tested separately; here we prove the renderer wires them honestly:
// the camera cards issue no command, the locked card cannot change mode, active
// authority is never fabricated, the right stick mirrors input only, and two
// identical controllers stay independently selectable.
describe('SEAT FIT — camera mode + controller (tasks §1/§3/§4/§5)', () => {
  // A fake Gamepad. buttons is padded so preset indices (throttle=7…) exist.
  const makePad = (id, index, { axes = [0, 0, 0, 0], buttons = [] } = {}) => ({
    id, index, connected: true, mapping: 'standard',
    axes: axes.slice(),
    buttons: Array.from({ length: 16 }, (_, i) => buttons[i] || { pressed: false, value: 0 }),
  });
  // Stub navigator.getGamepads BEFORE entering SEAT FIT (enterSeatfit paints once
  // immediately). getGamepads may be undefined in jsdom, so defineProperty it.
  const setPads = (pads) => {
    Object.defineProperty(window.navigator, 'getGamepads', { configurable: true, value: () => pads });
  };
  // gs-method call counts, so a test can assert a click added no ground-station call.
  const gsCalls = (gs) => Object.fromEntries(
    Object.entries(gs)
      .filter(([, v]) => typeof v === 'function' && v.mock)
      .map(([k, v]) => [k, v.mock.calls.length]),
  );
  async function enterSeatfit(gs, pads = []) {
    await loadRenderer(gs);
    setPads(pads);
    document.querySelector('.modecard[data-mode="solo"]').click(); // GARAGE -> SEAT FIT
    await tick();
    expect(activeStep()).toBe('seatfit');
  }
  const camCard = (mode) => el('camModes').querySelector(`[data-mode="${mode}"]`);
  const rows = () => [...el('padList').querySelectorAll('.netrow')];

  it('Manual is a selectable button; Head Tracking is a locked, non-button card', async () => {
    await enterSeatfit(mockGs(), []);
    const cards = [...el('camModes').children];
    expect(cards.map((c) => c.dataset.mode)).toEqual(['manual', 'headtrack']);
    expect(camCard('manual').tagName).toBe('BUTTON');
    expect(camCard('manual').classList.contains('on')).toBe(true); // default selected
    // A <div>, not a <button>: no native activation semantics for the locked card.
    expect(camCard('headtrack').tagName).toBe('DIV');
    expect(camCard('headtrack').classList.contains('locked')).toBe(true);
    expect(camCard('headtrack').querySelector('.camlock').textContent).toContain('LOCKED');
  });

  it('AVAILABLE/REQUESTED and ACTIVE AUTHORITY are distinct; active reads NOT REPORTED BY MAPPER', async () => {
    await enterSeatfit(mockGs(), []);
    expect(el('camRequested').textContent).toBe('MANUAL · RIGHT STICK'); // setup default
    expect(el('camActive').textContent).toBe('NOT REPORTED BY MAPPER');
    expect(el('camActive').classList.contains('unreported')).toBe(true);
    // Active authority is never fabricated from W3, head-tracking, or the browser
    // stick, and never echoes the requested mode as if it were live.
    expect(el('camActive').textContent.toLowerCase()).not.toMatch(/w3|head|track|manual|right stick/);
  });

  it('clicking the LOCKED Head Tracking card changes nothing and calls NO ground-station method', async () => {
    const gs = mockGs();
    await enterSeatfit(gs, []);
    const before = gsCalls(gs);
    camCard('headtrack').click();
    await tick();
    expect(el('camRequested').textContent).toBe('MANUAL · RIGHT STICK'); // unchanged
    expect(el('camActive').textContent).toBe('NOT REPORTED BY MAPPER'); // unchanged
    expect(camCard('headtrack').classList.contains('on')).toBe(false); // never selected
    expect(gsCalls(gs)).toEqual(before); // no mode/control RPC — the card cannot emit
  });

  it('clicking the selectable Manual card is display-only — no ground-station method is called', async () => {
    const gs = mockGs();
    await enterSeatfit(gs, []);
    const before = gsCalls(gs);
    camCard('manual').click();
    await tick();
    expect(gsCalls(gs)).toEqual(before);
    expect(el('camRequested').textContent).toBe('MANUAL · RIGHT STICK');
  });

  it('a live controller reads LIVE CONTROLLER with transport shown UNKNOWN (never guessed as Bluetooth)', async () => {
    await enterSeatfit(mockGs(), [makePad('DualShock 4 Wireless Controller', 0)]);
    expect(el('ctlSource').textContent).toBe('LIVE CONTROLLER');
    expect(el('ctlSource').classList.contains('live')).toBe(true);
    expect(el('ctlMeta').textContent).toContain('TRANSPORT UNKNOWN');
    // "Wireless Controller" in the id must NOT be inferred as Bluetooth.
    expect(el('ctlMeta').textContent.toLowerCase()).not.toContain('bluetooth');
  });

  it('no controller: source reads NO CONTROLLER and the preview is neutral (nopad, sticks centred)', async () => {
    await enterSeatfit(mockGs(), []);
    expect(el('ctlSource').textContent).toContain('NO CONTROLLER');
    expect(el('padPreview').classList.contains('nopad')).toBe(true);
    const right = el('padPreview').querySelector('[data-stick="right"]');
    expect(right.getAttribute('cx')).toBe(right.dataset.cx); // centred = neutral
    expect(right.getAttribute('cy')).toBe(right.dataset.cy);
  });

  it('left stick steers and right stick pans/tilts the LIVE MIRROR (visualization only)', async () => {
    const pad = makePad('DualShock 4', 0, { axes: [-0.5, 0, 0.4, -0.8] }); // steer,-,pan,tilt
    await enterSeatfit(mockGs(), [pad]);
    // Test strip (same math as the renderer: 50 + value*42).
    expect(el('tsSteer').style.left).toBe(`${50 + -0.5 * 42}%`);
    expect(el('tsPan').style.left).toBe(`${50 + 0.4 * 42}%`);
    expect(el('tsTilt').style.left).toBe(`${50 + -0.8 * 42}%`);
    // Stick wells: right dot moves in X (pan) AND Y (tilt); left dot in X only.
    // spread = 19 SVG units (well radius 24 − dot radius 5); Batch 7 rider c.
    const right = el('padPreview').querySelector('[data-stick="right"]');
    expect(Number(right.getAttribute('cx'))).toBeCloseTo(Number(right.dataset.cx) + 0.4 * 19);
    expect(Number(right.getAttribute('cy'))).toBeCloseTo(Number(right.dataset.cy) + -0.8 * 19);
    const left = el('padPreview').querySelector('[data-stick="left"]');
    expect(Number(left.getAttribute('cx'))).toBeCloseTo(Number(left.dataset.cx) + -0.5 * 19);
    expect(Number(left.getAttribute('cy'))).toBe(Number(left.dataset.cy)); // steering is X-only
  });

  it('keyboard fallback + log-only are each stated once — no duplicated copies (Batch 2 §1/§2)', async () => {
    // No controller: the maximal-text state — #ctlSource shows KEYBOARD FALLBACK
    // and the keyboard legend is applicable.
    await enterSeatfit(mockGs(), []);
    const seat = document.querySelector('.setup-screen[data-step="seatfit"]');
    const text = seat.textContent;
    const count = (re) => (text.match(re) || []).length;
    // Exactly ONE "keyboard fallback" statement (the #ctlSource line). The key
    // legend line adds the word once more, but a legend is not a second copy of
    // the fallback fact — so total "keyboard" mentions never exceed 2 (was 3:
    // #ctlSource + the LAYOUT hint + the empty-pad row).
    expect(count(/keyboard fallback/gi)).toBe(1);
    expect(count(/keyboard/gi)).toBeLessThanOrEqual(2);
    // The mapper-authority / W3-log-only wording lives once, in #camModeNote
    // (was twice: the head-tracking card help repeated it).
    expect(count(/log-only/gi)).toBe(1);
    // The empty-pad row no longer restates the fallback.
    expect(el('padList').textContent).toBe('NO CONTROLLER DETECTED');
    // The key legend is present (shown only with no controller) and the pairing
    // guidance moved behind PAIRING NOTES.
    expect(el('keyboardHint').textContent).toMatch(/steer/);
    expect(el('pairingNotes').querySelector('summary').textContent).toBe('PAIRING NOTES');
    // Safety semantics remain intact (kept from the existing SEAT FIT tests).
    expect(camCard('headtrack').querySelector('.camlock').textContent).toContain('LOCKED');
    expect(el('camActive').textContent).toBe('NOT REPORTED BY MAPPER');
  });

  it('the keyboard legend hides once a live controller is present (Batch 2 §1)', async () => {
    await enterSeatfit(mockGs(), [makePad('DualShock 4', 0)]);
    expect(el('ctlSource').textContent).toBe('LIVE CONTROLLER');
    expect(el('keyboardHint').classList.contains('hidden')).toBe(true);
  });

  it('two IDENTICAL controllers are two independently selectable rows; selecting the SECOND moves selection to it', async () => {
    await enterSeatfit(mockGs(), [makePad('DualShock 4', 0), makePad('DualShock 4', 1)]);
    expect(rows().length).toBe(2);
    // Same id, so the SLOT label is what tells them apart on screen.
    expect(rows().map((r) => r.querySelector('.padslot').textContent)).toEqual(['SLOT 0', 'SLOT 1']);
    expect(rows()[0].classList.contains('on')).toBe(true);  // auto = first slot
    expect(rows()[1].classList.contains('on')).toBe(false);
    // Click the SECOND identical controller — selection moves to it, not its peer.
    rows()[1].click();
    await tick();
    expect(rows()[1].classList.contains('on')).toBe(true);
    expect(rows()[0].classList.contains('on')).toBe(false);
  });
});

// SEAT FIT — wheel input against the REAL renderer (Batch 6 / P5b). The pure
// wheel model (shared/wheelProfile.mjs) is unit-tested separately; here we prove
// the renderer wires it honestly: the app ALWAYS boots GAMEPAD (activation never
// persists), WHEEL/BOTH reveal the assign/calibrate panel + viz, a listen
// captures a real device change into the profile, the bars mirror the calibrated
// travel, and every wheel save is exactly { wheel: { profile } } — no new IPC.
describe('SEAT FIT — wheel input + persistence (Batch 6 / P5b)', () => {
  const makePad = (id, index, { axes = [0, 0, 0, 0], buttons = [] } = {}) => ({
    id, index, connected: true, mapping: 'standard',
    axes: axes.slice(),
    buttons: Array.from({ length: 16 }, (_, i) => buttons[i] || { pressed: false, value: 0 }),
  });
  const pressAt = (i) => { const b = []; b[i] = { pressed: true, value: 1 }; return b; };
  const setPads = (pads) => {
    Object.defineProperty(window.navigator, 'getGamepads', { configurable: true, value: () => pads });
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const A_PROFILE = {
    steer: { axis: 0 }, pedalMode: 'separate',
    throttle: { axis: 1, rest: 1, full: -1 }, brake: { axis: 2, rest: 1, full: -1 },
    combined: { axis: 1, rest: 0, throttleEnd: 1, brakeEnd: -1 },
    deadzone: 0, buttons: { gearUp: 5, gearDown: 4, drs: 3, boost: 1, overtake: 2 },
  };
  function wheelGs(profile, overrides = {}) {
    const settings = { ...defaultSettings(), wheel: { profile } };
    return mockGs({
      getSettings: vi.fn(async () => ({ settings, envOverridden: {} })),
      setSettings: vi.fn(async () => settings),
      ...overrides,
    });
  }
  async function enterSeatfit(gs, pads = []) {
    await loadRenderer(gs);
    setPads(pads);
    document.querySelector('.modecard[data-mode="solo"]').click(); // GARAGE -> SEAT FIT
    await tick();
    expect(activeStep()).toBe('seatfit');
  }
  const pill = (type) => el('inputTypeRow').querySelector(`[data-input="${type}"]`);
  const wassign = (role) => el('wheelPanel').querySelector(`[data-wassign="${role}"]`);
  const wheelPatches = (gs) => gs.setSettings.mock.calls.map((c) => c[0]).filter((p) => p && p.wheel);

  it('boots GAMEPAD even when a wheel profile is saved — no active wheel DOM', async () => {
    const gs = wheelGs(A_PROFILE);
    await enterSeatfit(gs, [makePad('Fanatec Wheel', 0)]);
    expect(pill('gamepad').classList.contains('on')).toBe(true);
    expect(pill('wheel').classList.contains('on')).toBe(false);
    expect(el('wheelPanel').classList.contains('hidden')).toBe(true);
    expect(el('wheelMirror').classList.contains('hidden')).toBe(true);
    expect(el('gamepadMirror').classList.contains('hidden')).toBe(false);
    expect(el('wheelPanel').children.length).toBe(0);  // panel not built while off
    expect(el('wheelPreview').innerHTML).toBe('');      // viz not built while off
  });

  it('switching GAMEPAD -> WHEEL -> GAMEPAD reveals then tears down the wheel viz (no stale highlights)', async () => {
    const gs = mockGs();
    await enterSeatfit(gs, [makePad('Wheel', 0)]);
    pill('wheel').click();
    await tick();
    expect(el('wheelMirror').classList.contains('hidden')).toBe(false);
    expect(el('gamepadMirror').classList.contains('hidden')).toBe(true);
    expect(el('wheelPreview').querySelector('[data-wheel="steer"]')).toBeTruthy();
    expect(el('wheelPanel').querySelector('[data-wassign="steer"]')).toBeTruthy();
    pill('gamepad').click();
    await tick();
    expect(el('wheelMirror').classList.contains('hidden')).toBe(true);
    expect(el('gamepadMirror').classList.contains('hidden')).toBe(false);
    expect(el('wheelPreview').innerHTML).toBe('');       // no stale viz/highlight
    expect(el('wheelPanel').children.length).toBe(0);
  });

  it('WHEEL: an ASSIGN listen captures a fake-gamepad button press into the profile; the save is { wheel: { profile } } only', async () => {
    const gs = mockGs();
    await enterSeatfit(gs, [makePad('Wheel', 0)]); // no button pressed at listen start
    pill('wheel').click();
    await tick();
    wassign('drs').click();                         // arm the listen for DRS
    await tick();
    expect(el('wheelPanel').querySelector('[data-wval="drs"]').classList.contains('listening')).toBe(true);
    setPads([makePad('Wheel', 0, { buttons: pressAt(7) })]); // now press button 7
    await sleep(320);                               // let one 250ms detect tick run
    const patches = wheelPatches(gs);
    expect(patches.length).toBeGreaterThan(0);
    const patch = patches[patches.length - 1];
    // Exact shape: nothing but the profile rides the wheel save.
    expect(Object.keys(patch)).toEqual(['wheel']);
    expect(Object.keys(patch.wheel)).toEqual(['profile']);
    expect(patch.wheel.profile.buttons.drs).toBe(7);
    // The listen cleared once captured.
    expect(el('wheelPanel').querySelector('[data-wval="drs"]').classList.contains('listening')).toBe(false);
    expect(el('wheelPanel').querySelector('[data-wval="drs"]').textContent).toBe('BTN 7');
  });

  it('WHEEL: the pedal bars fill from the calibrated rest/full travel', async () => {
    const gs = wheelGs(A_PROFILE);
    // axis1 floored (-1) -> throttle travel 1.0 (rest 1 -> full -1); axis2 at rest (+1) -> brake 0.
    await enterSeatfit(gs, [makePad('Wheel', 0, { axes: [0, -1, 1, 0] })]);
    pill('wheel').click();
    await tick();
    const thr = el('wheelPreview').querySelector('[data-wheel="thr"]');
    const brk = el('wheelPreview').querySelector('[data-wheel="brk"]');
    const h = Number(thr.dataset.h), y0 = Number(thr.dataset.y0);
    expect(Number(thr.getAttribute('height'))).toBeCloseTo(h);       // fully filled
    expect(Number(thr.getAttribute('y'))).toBeCloseTo(y0 - h);       // grows upward from the base
    expect(Number(brk.getAttribute('height'))).toBeCloseTo(0);       // released
    expect(el('wheelPreview').classList.contains('nopad')).toBe(false); // a wheel is present
  });

  it('WHEEL: SET FULL captures the current axis reading into the profile calibration', async () => {
    const gs = wheelGs(A_PROFILE);
    await enterSeatfit(gs, [makePad('Wheel', 0, { axes: [0, -0.5, 1, 0] })]); // throttle axis at -0.5
    pill('wheel').click();
    await tick();
    el('wheelPanel').querySelector('[data-wcap="throttle.full"]').click();
    await tick();
    const patches = wheelPatches(gs);
    expect(patches[patches.length - 1].wheel.profile.throttle.full).toBeCloseTo(-0.5);
  });

  it('BOTH stacks both mirrors and gives the wheel its OWN device selector defaulting to the pad not selected in DEVICE', async () => {
    const gs = mockGs();
    await enterSeatfit(gs, [makePad('DualShock 4', 0), makePad('G29 Wheel', 1)]);
    pill('both').click();
    await tick();
    expect(el('gamepadMirror').classList.contains('hidden')).toBe(false);
    expect(el('wheelMirror').classList.contains('hidden')).toBe(false);
    const wl = el('wheelPadList');
    expect(wl, 'BOTH mode builds a separate wheel device list').toBeTruthy();
    const on = [...wl.querySelectorAll('.netrow.on')];
    expect(on.length).toBe(1);
    // gamepad DEVICE auto-selects slot 0, so the wheel defaults to slot 1.
    expect(on[0].querySelector('.padslot').textContent).toBe('SLOT 1');
  });
});

// Wheel device resolution & absence (Batch 2 · findings 2 + 3 + 4). These pin the
// three-way concern of WHICH device the wheel mirror follows and what happens when
// none is present: WHEEL mode gets its own device selector (finding 3), an absent
// wheel hands the live HUD a null wheelKey — not the first pad — so it tags
// INPUT · WHEEL (NO DEVICE) instead of reading a gamepad through wheel calibration
// (finding 2), and the selection is session-only, never persisted (decision #2).
// The HUD-side neutral/fallback behavior (finding 4) is pinned in hudWheel.test.js.
describe('SEAT FIT — wheel device resolution & absence (Batch 2 · findings 2 + 3 + 4)', () => {
  const makePad = (id, index) => ({
    id, index, connected: true, mapping: 'standard',
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })),
  });
  const setPads = (pads) => {
    Object.defineProperty(window.navigator, 'getGamepads', { configurable: true, value: () => pads });
  };
  const pill = (type) => el('inputTypeRow').querySelector(`[data-input="${type}"]`);
  async function enterSeatfit(gs, pads = []) {
    await loadRenderer(gs);
    setPads(pads);
    document.querySelector('.modecard[data-mode="solo"]').click(); // GARAGE -> SEAT FIT
    await tick();
    expect(activeStep()).toBe('seatfit');
  }
  const slotOf = (row) => row.querySelector('.padslot').textContent;

  it('WHEEL mode shows the device selector; it defaults to the first slot and a click overrides it (finding 3)', async () => {
    const gs = mockGs();
    await enterSeatfit(gs, [makePad('DualShock 4', 0), makePad('G29 Wheel', 1)]);
    pill('wheel').click();
    await tick();
    const wl = el('wheelPadList');
    expect(wl, 'WHEEL mode builds a wheel device list (finding 3)').toBeTruthy();
    const rows = [...wl.querySelectorAll('.netrow')];
    expect(rows.length).toBe(2);
    // Default: first slot — single-device users see no change.
    let on = [...wl.querySelectorAll('.netrow.on')];
    expect(on.length).toBe(1);
    expect(slotOf(on[0])).toBe('SLOT 0');
    // Override: pick slot 1 → the session selection follows it.
    rows.find((r) => slotOf(r) === 'SLOT 1').click();
    await tick();
    on = [...wl.querySelectorAll('.netrow.on')];
    expect(on.length).toBe(1);
    expect(slotOf(on[0])).toBe('SLOT 1');
  });

  it('a device picked in WHEEL does NOT leak into BOTH — switching modes re-derives auto-separate (F1)', async () => {
    const gs = mockGs();
    await enterSeatfit(gs, [makePad('DualShock 4', 0), makePad('G29 Wheel', 1)]);
    pill('wheel').click();
    await tick();
    // Deliberately point the WHEEL selector at slot 0 (the pad BOTH auto-assigns
    // to the gamepad). If this session pick leaked, BOTH would resolve the wheel to
    // slot 0 too and the two inputs would collide on one device.
    [...el('wheelPadList').querySelectorAll('.netrow')].find((r) => slotOf(r) === 'SLOT 0').click();
    await tick();
    pill('both').click();
    await tick();
    // BOTH re-derives: gamepad DEVICE auto-selects slot 0, so the wheel auto-separates
    // to the unused slot 1 — NOT the slot 0 carried over from the WHEEL pick.
    const on = [...el('wheelPadList').querySelectorAll('.netrow.on')];
    expect(on.length).toBe(1);
    expect(slotOf(on[0])).toBe('SLOT 1');
  });

  it('the wheel device selection is session-only — a pick never writes settings (decision #2)', async () => {
    const gs = mockGs();
    await enterSeatfit(gs, [makePad('DualShock 4', 0), makePad('G29 Wheel', 1)]);
    pill('wheel').click();
    await tick();
    const before = gs.setSettings.mock.calls.length;
    const rows = [...el('wheelPadList').querySelectorAll('.netrow')];
    rows.find((r) => slotOf(r) === 'SLOT 1').click();
    await tick();
    // Switching the wheel device changed only session state — nothing persisted.
    expect(gs.setSettings.mock.calls.length).toBe(before);
  });

  it('hands the HUD a null wheelKey when no wheel resolves → the live HUD tags INPUT · WHEEL (NO DEVICE) (finding 2)', async () => {
    // A merging setSettings + start-lights off, so START hands off deterministically
    // (the no-countdown path) — the same seam the Batch 9 pad-flow test uses.
    const settings = { ...defaultSettings(), startLightsEnabled: false };
    const gs = mockGs({
      getSettings: vi.fn(async () => ({ settings, envOverridden: {} })),
      setSettings: vi.fn(async (patch) => { Object.assign(settings, patch); return settings; }),
    });
    await enterSeatfit(gs, [makePad('DualShock 4', 0)]); // ONE device, no wheel
    pill('both').click();                                 // BOTH: gamepad + a SEPARATE wheel
    await tick();
    // With only the gamepad, the wheel resolves to no device — SEAT FIT must pass
    // null to the HUD, not fall back to the first (gamepad) slot.
    el('navNext').click(); await tick();                  // SEAT FIT -> GRID (solo skips PIT WALL)
    expect(activeStep()).toBe('grid');
    el('startAnywayBtn').click();                         // beginStart() → applyInputSource() (sync)
    await vi.waitFor(() => {
      expect(document.querySelector('.demoToggle').classList.contains('hidden')).toBe(false);
    });
    expect(el('inputSrcTag').textContent).toBe('INPUT · WHEEL (NO DEVICE)');
  });

  it("a resolved wheel is NOT tagged (NO DEVICE): a present device hands the HUD its key, plain INPUT · WHEEL", async () => {
    const settings = { ...defaultSettings(), startLightsEnabled: false };
    const gs = mockGs({
      getSettings: vi.fn(async () => ({ settings, envOverridden: {} })),
      setSettings: vi.fn(async (patch) => { Object.assign(settings, patch); return settings; }),
    });
    await enterSeatfit(gs, [makePad('G29 Wheel', 0)]); // one device, WHEEL mode owns it
    pill('wheel').click();
    await tick();
    el('navNext').click(); await tick();
    expect(activeStep()).toBe('grid');
    el('startAnywayBtn').click();
    await vi.waitFor(() => {
      expect(document.querySelector('.demoToggle').classList.contains('hidden')).toBe(false);
    });
    expect(el('inputSrcTag').textContent).toBe('INPUT · WHEEL'); // resolved → no NO DEVICE suffix
  });
});

// Step rail (Batch 8a / flow chrome). The rail is rendered from the live per-mode
// step list (shared/setupSteps.mjs) in the FIXED design order/labels
// (01 GARAGE · 02 SEAT FIT · 03 PIT WALL · 04 GRID). States are honest: done for
// steps already passed in the ACTUAL path, current for the active step, todo for
// steps still ahead, skipped for a canonical step absent from the mode's path
// (desktop mode omits PIT WALL). Display only — no navigation change.
describe('step rail states (Batch 8a / flow chrome)', () => {
  const railStep = (key) => el('stepRail').querySelector(`[data-step="${key}"]`);
  const railState = (key) => {
    const s = railStep(key);
    return ['done', 'current', 'todo', 'skipped'].find((c) => s.classList.contains(c)) || null;
  };

  it('renders all four canonical steps in the fixed design order/labels on every screen', async () => {
    await loadRenderer(mockGs()); // fresh solo user -> GARAGE
    const steps = [...el('stepRail').querySelectorAll('.railstep')];
    expect(steps.map((s) => s.dataset.step)).toEqual(['garage', 'seatfit', 'pitwall', 'grid']);
    expect(steps.map((s) => s.querySelector('b').textContent)).toEqual(['01', '02', '03', '04']);
    expect(steps.map((s) => s.textContent.replace(/^\d+/, '').replace(/SKIPPED.*$/, '').trim()))
      .toEqual(['GARAGE', 'SEAT FIT', 'PIT WALL', 'GRID']);
  });

  it('desktop/solo mode marks PIT WALL skipped with a SKIPPED · DESKTOP reason chip; the rest track the path', async () => {
    await loadRenderer(mockGs()); // solo, on GARAGE
    expect(railState('garage')).toBe('current');
    expect(railState('seatfit')).toBe('todo');
    expect(railState('pitwall')).toBe('skipped');
    expect(railStep('pitwall').querySelector('.whychip').textContent).toBe('SKIPPED · DESKTOP');
    expect(railState('grid')).toBe('todo');
    // Advance to SEAT FIT (solo skips PIT WALL in the real path): GARAGE done now.
    document.querySelector('.modecard[data-mode="solo"]').click();
    await tick();
    expect(activeStep()).toBe('seatfit');
    expect(railState('garage')).toBe('done');
    expect(railState('seatfit')).toBe('current');
    expect(railState('pitwall')).toBe('skipped'); // still skipped in desktop mode
    expect(railState('grid')).toBe('todo');
    expect(railStep('garage').querySelector('.whychip')).toBeNull(); // no chip on non-skipped
  });

  it('iPhone mode has no skipped step: PIT WALL is a real todo, then current', async () => {
    const gs = mockGs();
    await loadPitwall(gs); // clicks the iphone-hud card -> PIT WALL
    expect(railState('garage')).toBe('done');
    expect(railState('pitwall')).toBe('current');
    expect(railStep('pitwall').querySelector('.whychip')).toBeNull(); // never skipped in iPhone mode
    expect(railState('grid')).toBe('todo');
  });
});

// Returning-user fast path (Batch 8a / flow chrome, design bundle §3 + user
// decision 2026-07-16): a completed prior session lands on GARAGE with a
// green-accent actionable card (mode · controller · telemetry source), focused
// so a single Enter resumes; its button runs the existing path to GRID. A fresh
// user sees GARAGE without the card.
describe('GARAGE fast-path card (Batch 8a / flow chrome)', () => {
  it('a returning user lands on GARAGE with the fast-path card visible, focused, and summarizing the reused config', async () => {
    const settings = { ...defaultSettings(), setupCompleted: true, fpvMode: 'solo', telemetry: { source: 'replay', port: '' } };
    const gs = mockGs({ getSettings: vi.fn(async () => ({ settings, envOverridden: {} })) });
    await loadRenderer(gs);
    expect(activeStep()).toBe('garage');
    expect(el('fastPath').classList.contains('hidden')).toBe(false);
    expect(document.activeElement).toBe(el('fastPathBtn')); // single-Enter resume
    const summary = el('fastPathSummary').textContent;
    expect(summary).toMatch(/DESKTOP FPV/);
    expect(summary).toMatch(/TELEMETRY REPLAY/);
    expect(summary).toMatch(/checks re-run on the GRID/);
  });

  it("the card's button runs the existing resume path to GRID (no new session logic)", async () => {
    const settings = { ...defaultSettings(), setupCompleted: true, fpvMode: 'solo' };
    const gs = mockGs({ getSettings: vi.fn(async () => ({ settings, envOverridden: {} })) });
    await loadRenderer(gs);
    el('fastPathBtn').click();
    await tick();
    expect(activeStep()).toBe('grid');
    expect(gs.applySession).toHaveBeenCalled(); // the standard GRID entry, not a new path
  });

  it('a fresh user (no completed session) sees GARAGE with the fast-path card hidden', async () => {
    await loadRenderer(mockGs()); // setupCompleted:false
    expect(activeStep()).toBe('garage');
    expect(el('fastPath').classList.contains('hidden')).toBe(true);
  });
});

// Batch 8b — step reorder + skip navigation matrix. The flow is now
// GARAGE -> SEAT FIT -> PIT WALL -> GRID; desktop/solo mode omits PIT WALL
// (shared/setupSteps.mjs), so BACK/NEXT traverse the mode's ACTUAL path. CHANGE
// SETUP always returns to GARAGE, where re-picking a mode re-enters its path —
// the PIT WALL skip is a mode default, not a lock.
describe('setup navigation matrix (Batch 8b)', () => {
  const pickMode = async (m) => {
    document.querySelector(`.modecard[data-mode="${m}"]`).click();
    await tick();
  };
  const railStateOf = (key) => {
    const s = el('stepRail').querySelector(`[data-step="${key}"]`);
    return ['done', 'current', 'todo', 'skipped'].find((c) => s.classList.contains(c)) || null;
  };
  const whychip = (key) => el('stepRail').querySelector(`[data-step="${key}"] .whychip`);

  it('desktop/solo NEXT walks GARAGE -> SEAT FIT -> GRID, skipping PIT WALL', async () => {
    await loadRenderer(mockGs());
    await pickMode('solo');
    expect(activeStep()).toBe('seatfit');
    el('navNext').click(); await tick();
    expect(activeStep()).toBe('grid'); // PIT WALL never entered
    expect(railStateOf('pitwall')).toBe('skipped');
    expect(whychip('pitwall').textContent).toBe('SKIPPED · DESKTOP');
  });

  it('desktop/solo BACK from GRID returns to SEAT FIT then GARAGE (never PIT WALL)', async () => {
    await loadRenderer(mockGs());
    await pickMode('solo');
    el('navNext').click(); await tick(); // -> grid
    expect(activeStep()).toBe('grid');
    el('navBack').click(); await tick();
    expect(activeStep()).toBe('seatfit'); // BACK skips PIT WALL too
    el('navBack').click(); await tick();
    expect(activeStep()).toBe('garage');
  });

  it('iPhone mode NEXT walks GARAGE -> SEAT FIT -> PIT WALL -> GRID in the new order', async () => {
    await loadRenderer(mockGs());
    await pickMode('iphone-hud');
    expect(activeStep()).toBe('seatfit'); // SEAT FIT now precedes PIT WALL
    el('navNext').click(); await tick();
    expect(activeStep()).toBe('pitwall');
    el('navNext').click(); await tick();
    expect(activeStep()).toBe('grid');
  });

  it('iPhone mode BACK from GRID walks GRID -> PIT WALL -> SEAT FIT -> GARAGE', async () => {
    await loadRenderer(mockGs());
    await pickMode('iphone-hud');
    el('navNext').click(); await tick(); // -> pitwall
    el('navNext').click(); await tick(); // -> grid
    expect(activeStep()).toBe('grid');
    el('navBack').click(); await tick();
    expect(activeStep()).toBe('pitwall');
    el('navBack').click(); await tick();
    expect(activeStep()).toBe('seatfit');
    el('navBack').click(); await tick();
    expect(activeStep()).toBe('garage');
  });

  it('iPhone mode has no skipped step: PIT WALL is a real todo on the rail (no reason chip)', async () => {
    await loadRenderer(mockGs());
    await pickMode('iphone-hud'); // -> seatfit
    expect(railStateOf('pitwall')).toBe('todo');
    expect(whychip('pitwall')).toBeNull();
  });

  it('CHANGE SETUP from GRID returns to GARAGE and re-enters the same mode path', async () => {
    await loadRenderer(mockGs());
    await pickMode('solo');
    el('navNext').click(); await tick(); // -> grid (solo)
    expect(activeStep()).toBe('grid');
    el('changeSetup').click(); await tick();
    expect(activeStep()).toBe('garage');
    await pickMode('solo'); // re-pick: same skip path
    el('navNext').click(); await tick();
    expect(activeStep()).toBe('grid');
  });

  it('the PIT WALL skip is a mode default, not a lock: CHANGE SETUP -> iPhone Cockpit re-enters PIT WALL', async () => {
    await loadRenderer(mockGs());
    await pickMode('solo');
    el('navNext').click(); await tick(); // solo -> grid, PIT WALL skipped
    expect(activeStep()).toBe('grid');
    expect(railStateOf('pitwall')).toBe('skipped');
    el('changeSetup').click(); await tick();
    expect(activeStep()).toBe('garage');
    await pickMode('iphone-hud'); // -> seatfit; PIT WALL now in the path
    expect(railStateOf('pitwall')).toBe('todo');
    el('navNext').click(); await tick();
    expect(activeStep()).toBe('pitwall'); // deliberately re-entered — not locked out
  });
});

// Batch 9 — controller-driven UI navigation, INTEGRATION. Loads the REAL
// renderer (setupFlow.js wires the pad-nav singleton at boot) and drives it with
// an injected gamepad via navigator.getGamepads — the same seam the SEAT FIT
// mirror reads. Proves the whole flow is operable pad-only (GARAGE -> ... -> GRID
// -> START, no mouse/keyboard), that ⚙ opens/closes via pad on setup AND on the
// live HUD, and that a wheel capture suspends navigation. VIEWER-ONLY: every
// effect is a DOM focus/click; there is no control path.
describe('controller-driven UI navigation (Batch 9)', () => {
  const CONFIRM = 0, BACK = 1, SETTINGS = 9, DPAD_DOWN = 13;
  const makePad = (down = []) => ({
    id: 'nav-pad', index: 0, connected: true, mapping: 'standard',
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: down.includes(i), value: down.includes(i) ? 1 : 0 })),
  });
  const setPads = (pads) =>
    Object.defineProperty(window.navigator, 'getGamepads', { configurable: true, value: () => pads });

  let nav; // the CONFIGURED singleton (dynamic-imported after resetModules)
  const setDown = (down) => setPads([makePad(down)]);
  const press = (down) => { setDown(down); nav.pollOnce(); };
  const release = () => { setDown([]); nav.pollOnce(); };

  // A boot with a controller present, then grab the SAME uiNav instance
  // setupFlow.js configured (post-resetModules).
  async function bootNav(gs = mockGs()) {
    await loadRenderer(gs);
    // jsdom has no matchMedia; the start-lights hand-off reads reduced-motion.
    window.matchMedia = window.matchMedia || (() => ({ matches: false }));
    setDown([]);
    nav = await import('../renderer/uiNav.js');
    nav.pollOnce(); // seed the edge baseline (neutral pad) — intents fire from the second poll
  }

  // Step focus one control at a time until `target` carries the ring, releasing
  // between presses so each edge re-arms. Returns whether it landed.
  function navToward(target, max = 80) {
    for (let i = 0; i < max; i++) {
      if (nav.focusedElement() === target) return true;
      press([DPAD_DOWN]);
      release();
    }
    return nav.focusedElement() === target;
  }
  const activate = (target) => { expect(navToward(target)).toBe(true); press([CONFIRM]); release(); };

  it('a d-pad press focuses a control and paints the visible focus ring; confirm activates it', async () => {
    await bootNav();
    expect(activeStep()).toBe('garage');
    const solo = document.querySelector('.modecard[data-mode="solo"]');
    expect(navToward(solo)).toBe(true);
    expect(solo.classList.contains('uinav-focus')).toBe(true); // ring visible on the focused control
    expect(document.activeElement).toBe(solo);                  // keyboard parity: same .focus()
    press([CONFIRM]); await tick();                             // confirm activates the mode card
    expect(activeStep()).toBe('seatfit');
  });

  it('completes the whole flow GARAGE -> SEAT FIT -> GRID -> START pad-only (no mouse/keyboard)', async () => {
    // Desktop/solo, start-lights off so START hands off deterministically.
    const settings = { ...defaultSettings(), startLightsEnabled: false };
    // A merging setSettings so save({setupCompleted}) keeps startLightsEnabled
    // false (the default mock returns a fresh lights-on object) — the START
    // hand-off then takes the no-countdown path deterministically.
    const gs = mockGs({
      getSettings: vi.fn(async () => ({ settings, envOverridden: {} })),
      setSettings: vi.fn(async (patch) => { Object.assign(settings, patch); return settings; }),
    });
    await bootNav(gs);

    activate(document.querySelector('.modecard[data-mode="solo"]')); // GARAGE -> SEAT FIT
    await tick();
    expect(activeStep()).toBe('seatfit');

    activate(el('navNext'));                                          // SEAT FIT -> GRID (solo skips PIT WALL)
    await tick();
    expect(activeStep()).toBe('grid');

    // Checks are incomplete in the mock (no video/telemetry), so START ANYWAY is
    // the live action — reach it and confirm, all via the pad.
    expect(el('startAnywayBtn').classList.contains('hidden')).toBe(false);
    activate(el('startAnywayBtn'));                                   // GRID START (ANYWAY)
    await tick();
    // runLights ran the hand-off: the step rail is retired for the start sequence.
    expect(el('stepRail').classList.contains('hidden')).toBe(true);
    // After the 250ms no-lights fade, startRide() dismisses the gate and the
    // HUD preview toggle is visible/reachable again (triage #4 — hidden while
    // the gate covered it, un-hidden by start()).
    await vi.waitFor(() => {
      expect(document.querySelector('.demoToggle').classList.contains('hidden')).toBe(false);
    });
  });

  it('the HUD preview toggle is hidden (and un-navigable) while the gate covers it', async () => {
    await bootNav();
    // Hidden by class from boot (gate up), so uiNav's navigable() filter — which
    // is class-based, not paint-based — excludes the occluded control too.
    expect(document.querySelector('.demoToggle').classList.contains('hidden')).toBe(true);
    expect(navToward(el('demoBtn'), 40)).toBe(false); // never receives pad focus during setup
  });

  it('pad BACK (button 1) never steps the setup flow back — it only closes the settings menu', async () => {
    await bootNav();
    activate(document.querySelector('.modecard[data-mode="solo"]')); // -> SEAT FIT
    await tick();
    expect(activeStep()).toBe('seatfit');
    press([BACK]); release();               // BOOST-collision guard: no navigation
    expect(activeStep()).toBe('seatfit');   // still on SEAT FIT (was: ejected to GARAGE)
    press([SETTINGS]); release();           // open the menu…
    expect(el('settingsScrim').classList.contains('hidden')).toBe(false);
    press([BACK]); release();               // …BACK closes it — its only job now
    expect(el('settingsScrim').classList.contains('hidden')).toBe(true);
    expect(activeStep()).toBe('seatfit');
  });

  it('live session (gate dismissed): nav is settings-only — moves are inert, ⚙ works, and nav resumes inside the open menu', async () => {
    await bootNav();
    el('gate').classList.add('hidden');     // simulate the live HUD
    press([DPAD_DOWN]); release();          // d-pad move: inert (driving shares the pad)
    expect(nav.focusedElement()).toBeNull();
    setDown([]); setPads([{ ...makePad([]), axes: [0.9, 0, 0, 0] }]); nav.pollOnce(); // steer past half-lock
    expect(nav.focusedElement()).toBeNull(); // axis move: inert too
    setDown([]); nav.pollOnce();
    press([SETTINGS]); release();           // the one live intent: ⚙ toggles
    expect(el('settingsScrim').classList.contains('hidden')).toBe(false);
    press([DPAD_DOWN]); release();          // menu open → nav works inside the modal
    const focused = nav.focusedElement();
    expect(focused).not.toBeNull();
    expect(el('settingsScrim').contains(focused)).toBe(true);
    press([BACK]); release();               // back closes the menu, back to settings-only
    expect(el('settingsScrim').classList.contains('hidden')).toBe(true);
  });

  it('the ⚙ pad button (index 9) opens the settings menu and BACK (index 1) closes it — on a setup screen', async () => {
    await bootNav();
    expect(el('settingsScrim').classList.contains('hidden')).toBe(true);
    press([SETTINGS]); release();
    expect(el('settingsScrim').classList.contains('hidden')).toBe(false); // opened via pad
    press([BACK]); release();
    expect(el('settingsScrim').classList.contains('hidden')).toBe(true);  // closed via pad
  });

  it('the ⚙ pad button toggles the settings menu on the LIVE HUD too (gate dismissed)', async () => {
    await bootNav();
    el('gate').classList.add('hidden'); // simulate the live HUD (setup overlay gone)
    press([SETTINGS]); release();
    expect(el('settingsScrim').classList.contains('hidden')).toBe(false);
    press([SETTINGS]); release();       // index 9 toggles it closed again
    expect(el('settingsScrim').classList.contains('hidden')).toBe(true);
  });

  it('a wheel capture SUSPENDS navigation: presses go to the capture, not focus; cancelling restores nav', async () => {
    await bootNav();
    activate(document.querySelector('.modecard[data-mode="solo"]')); // -> SEAT FIT
    await tick();
    expect(activeStep()).toBe('seatfit');

    // WHEEL input reveals the assign/calibrate panel.
    el('inputTypeRow').querySelector('[data-input="wheel"]').click();
    expect(el('wheelPanel').querySelector('[data-wassign]')).not.toBeNull();

    // Before arming: navigation works.
    press([DPAD_DOWN]);
    expect(nav.focusedElement()).not.toBeNull();
    nav.clearFocusRing();
    release();

    // Arm an ASSIGN listen (a wheel-mapping row is now LISTENING).
    el('wheelPanel').querySelector('[data-wassign]').click();
    // While suspended, a d-pad press must NOT move focus (it belongs to the capture).
    press([DPAD_DOWN]);
    expect(nav.focusedElement()).toBeNull();

    // Switching input type cancels the listen (the CANCEL path) — nav restored.
    el('inputTypeRow').querySelector('[data-input="gamepad"]').click();
    release();
    press([DPAD_DOWN]);
    expect(nav.focusedElement()).not.toBeNull();
  });
});
