// @vitest-environment jsdom
// Viewer-only disclaimer — presence + once-per-session contract (2026-07-25).
//
// WHY THIS FILE EXISTS: commit 0950298 deleted the pinned #gateFootnote overlay
// carrying the ONLY in-UI statement that this app is a viewer, and nothing failed
// — the string had no test. It is a safety-adjacent honesty claim (the mapper,
// elrs-joystick-control, drives the car; this app mirrors and overlays), so it is
// now asserted in both of its homes:
//   - PERMANENT: the ⚙ settings panel (#viewerOnlySetNote), always available.
//   - ONCE PER APP SESSION: the GARAGE landing (#viewerOnlyNote), because GARAGE
//     is re-entered by CHANGE SETUP / RE-RUN SETUP / BACK and re-showing the
//     notice every time would recreate the nuisance the overlay was deleted for.
//
// The markup assertions read renderer/index.html directly and pin ONE literal in
// both places, so the two copies cannot drift apart. The CSS assertions pin the
// RESOLVED rules, not just class names: jsdom applies no linked stylesheet, so a
// class-only assertion passes vacuously even when the element is visible — the
// exact defect 085e1d1 fixed on .barsrc (`hidden` was inert because hud.css has
// no generic .hidden rule).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// cwd-relative: under the jsdom environment import.meta.url is not a file URL.
const html = readFileSync('renderer/index.html', 'utf8');
const css = readFileSync('renderer/hud.css', 'utf8');
const bodyHtml = html
  .match(/<body>([\s\S]*)<\/body>/)[1]
  .replace(/<script[\s\S]*?<\/script>/g, ''); // modules are imported by the test, not the page

// THE canonical literal. Both homes must carry exactly this text.
const NOTICE =
  'Viewer only — elrs-joystick-control drives the car; this window mirrors inputs and overlays telemetry.';

// Body of an EXACT selector rule (hud.css is one-selector-per-rule).
function rule(sel) {
  const re = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const m = css.match(re);
  if (!m) throw new Error(`no CSS rule found for "${sel}"`);
  return m[1];
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const el = (id) => document.getElementById(id);
const activeStep = () => document.querySelector('.setup-screen.active')?.dataset.step ?? null;

describe('viewer-only disclaimer — present in BOTH homes (markup)', () => {
  it('the exact string appears in renderer/index.html exactly twice', () => {
    // Two homes, one literal — a third copy or a reworded copy fails here, which
    // is the point: the copy is a safety-adjacent claim, not decoration.
    const occurrences = html.split(NOTICE).length - 1;
    expect(occurrences, `expected the viewer-only notice exactly twice, found ${occurrences}`).toBe(2);
  });

  it('the PERMANENT home is inside the ⚙ settings panel (#viewerOnlySetNote)', () => {
    document.body.innerHTML = bodyHtml;
    const note = el('viewerOnlySetNote');
    expect(note, '#viewerOnlySetNote must exist').not.toBeNull();
    expect(note.textContent).toBe(NOTICE);
    expect(note.closest('#settingsMenu'), 'must live inside the ⚙ panel').not.toBeNull();
    // No tabbable control inside the note: it is a statement, not a dialog.
    expect(note.querySelectorAll('a[href], button, input, select, textarea, [tabindex]').length).toBe(0);
  });

  it('the ONCE-PER-SESSION home is inside the GARAGE step (#viewerOnlyNote), with no dismiss control', () => {
    document.body.innerHTML = bodyHtml;
    const note = el('viewerOnlyNote');
    expect(note, '#viewerOnlyNote must exist').not.toBeNull();
    expect(note.textContent).toBe(NOTICE);
    const garage = note.closest('.setup-screen');
    expect(garage, 'must live inside a setup screen').not.toBeNull();
    expect(garage.dataset.step).toBe('garage');
    // NO dismiss button on purpose: a focusable here would enter GARAGE's
    // document order and could disturb the fast-path card's boot-only focus
    // (renderer/setupFlow.js boot()) and uiNav's document-order walk.
    expect(note.querySelectorAll('a[href], button, input, select, textarea, [tabindex]').length).toBe(0);
  });
});

describe('viewer-only disclaimer — resolved CSS contract, not just class names', () => {
  it('neither home is a position:fixed overlay that can cross content', () => {
    // The deleted .keys.footnote WAS position:fixed, which is why it transiently
    // crossed content at scrollTop 0 and permanently reserved viewport height.
    expect(rule('.viewernote')).not.toMatch(/position:\s*fixed/);
    expect(rule('.setnote')).not.toMatch(/position:\s*fixed/);
  });

  it('.viewernote.hidden actually hides — hud.css has no generic .hidden rule (085e1d1 lesson)', () => {
    // Without this element-scoped rule the `hidden` class toggled by
    // updateViewerNote() would be visually inert and the jsdom class assertions
    // below would pass while the notice stayed on screen every GARAGE entry.
    const hidden = rule('.viewernote.hidden');
    expect(hidden.replace(/\s/g, '')).toContain('display:none');
  });

  it('the GARAGE notice is muted, not an alarm colour (an identity statement, not a warning)', () => {
    expect(rule('.viewernote')).toMatch(/color:\s*var\(--muted\)/);
    expect(rule('.setnote')).toMatch(/color:\s*var\(--muted\)/);
  });
});

// Behavioural half: the real renderer under jsdom against a mocked preload.
function defaultSettings() {
  return {
    fpvMode: 'solo', soundEnabled: false, startLightsEnabled: true, setupCompleted: false,
    iphoneAddr: '', w3DiagnosticEnabled: false, elrsPath: '',
    telemetry: { source: 'none', port: '' },
    network: { kind: 'join', adapter: '', hotspot: { ssid: 'W17-GRID', password: 'lights0ut!!' } },
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
    wifiInterfaces: vi.fn(async () => ({ ok: true, ifaces: [] })),
    wifiScan: vi.fn(async () => ({ ok: true, networks: [] })),
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

async function loadRenderer(gs) {
  vi.resetModules();
  document.body.innerHTML = bodyHtml;
  window.requestAnimationFrame = () => 0; // no 60 fps HUD loop in tests
  window.groundStation = gs;
  await import('../renderer/setupFlow.js');
  await tick();
}

describe('viewer-only disclaimer — ONCE per app session on GARAGE', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('is visible on the first GARAGE of a run', async () => {
    await loadRenderer(mockGs());
    expect(activeStep()).toBe('garage');
    expect(el('viewerOnlyNote').classList.contains('hidden')).toBe(false);
  });

  it('does NOT come back on a later GARAGE entry (CHANGE SETUP re-entry)', async () => {
    const settings = { ...defaultSettings(), setupCompleted: true, fpvMode: 'solo' };
    const gs = mockGs({ getSettings: vi.fn(async () => ({ settings, envOverridden: {} })) });
    await loadRenderer(gs);
    expect(el('viewerOnlyNote').classList.contains('hidden')).toBe(false); // shown once, on boot

    el('fastPathBtn').click(); // resume to GRID
    await tick();
    expect(activeStep()).toBe('grid');
    expect(el('viewerOnlyNote').classList.contains('hidden')).toBe(true);  // GARAGE left

    el('changeSetup').click(); // CHANGE SETUP -> showStep('garage')
    await tick();
    expect(activeStep()).toBe('garage');
    // Re-entry must NOT re-show it: that nuisance is why the overlay was removed.
    expect(el('viewerOnlyNote').classList.contains('hidden')).toBe(true);
  });

  it('a fresh renderer (new app run) states it again — the flag is module-level, not persisted', async () => {
    const settings = { ...defaultSettings(), setupCompleted: true, fpvMode: 'solo' };
    const gs = mockGs({ getSettings: vi.fn(async () => ({ settings, envOverridden: {} })) });
    await loadRenderer(gs);
    el('fastPathBtn').click();
    await tick();
    el('changeSetup').click();
    await tick();
    expect(el('viewerOnlyNote').classList.contains('hidden')).toBe(true); // spent for this run

    // A second run = a fresh renderer. Nothing about the notice is written to
    // settings.json, so the new run must state what the app is again.
    await loadRenderer(gs);
    expect(activeStep()).toBe('garage');
    expect(el('viewerOnlyNote').classList.contains('hidden')).toBe(false);
    expect(gs.setSettings).not.toHaveBeenCalled(); // no persistence side effect
  });

  it('does not disturb the fast-path card\'s boot-only focus (setupFlow.js boot())', async () => {
    const settings = { ...defaultSettings(), setupCompleted: true, fpvMode: 'solo' };
    const gs = mockGs({ getSettings: vi.fn(async () => ({ settings, envOverridden: {} })) });
    await loadRenderer(gs);
    // The notice is a sibling with no focusable content, so boot() still lands
    // the returning operator on the card for a single-Enter resume (finding 6).
    expect(el('viewerOnlyNote').classList.contains('hidden')).toBe(false);
    expect(document.activeElement).toBe(el('fastPathBtn'));
  });
});
