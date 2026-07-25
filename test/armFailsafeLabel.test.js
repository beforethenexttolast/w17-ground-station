// @vitest-environment jsdom
// ARM / FAILSAFE honesty labelling (audit R01, owner decision 2026-07-25).
//
// WHY THIS FILE EXISTS: `armed`/`failsafe` are demo-only fields — the car computes
// both but `link2` carries them only to board #2, the real CRSF backchannel carries
// no such field, and the handset only ever sees `M%u`. That was recorded in code
// comments and in docs/TELEMETRY.md, and was invisible on screen: a replayed
// failsafe episode raised a LINK LOST alarm indistinguishable from a real radio
// drop, and the contract's `armed` field had no UI at all. The owner's decision is
// that the indicators STAY SIMULATED BUT MUST SAY SO. This is the same class of gap
// as the deleted viewer-only footnote — an honesty claim with nothing asserting it —
// so it is asserted here.
//
// These drive the REAL renderer/hud.js against renderer/index.html under jsdom,
// stepping its requestAnimationFrame loop by hand (the hudWheel.test.js pattern).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const html = readFileSync('renderer/index.html', 'utf8');
const css = readFileSync('renderer/hud.css', 'utf8');
const bodyHtml = html
  .match(/<body>([\s\S]*)<\/body>/)[1]
  .replace(/<script[\s\S]*?<\/script>/g, ''); // the test imports the module itself

const el = (id) => document.getElementById(id);

const UNREPORTED = 'ARM / FAILSAFE · NOT REPORTED BY CAR';
const SIMULATED = 'ARM / FAILSAFE · SIMULATED';

function rule(sel) {
  const re = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const m = css.match(re);
  if (!m) throw new Error(`no CSS rule found for "${sel}"`);
  return m[1];
}

let rafCb = null;
let emitTelemetry = null;

// Loads hud.js with a preload mock, so init() runs and the telemetry listener is
// registered. `telemetrySource` decides whether the replay chip (and therefore the
// arm chip's wording) reports a synthetic source.
async function loadHud({ telemetrySource = 'none' } = {}) {
  vi.resetModules();
  document.body.innerHTML = bodyHtml;
  rafCb = null;
  emitTelemetry = null;
  window.requestAnimationFrame = (cb) => { rafCb = cb; return 1; };
  Object.defineProperty(window.navigator, 'getGamepads', { configurable: true, value: () => [] });
  window.groundStation = {
    getConfig: vi.fn(async () => ({ whepUrl: '', w3Active: false, feel: null, telemetrySource })),
    getSettings: vi.fn(async () => ({ settings: null, envOverridden: {} })),
    onTelemetry: vi.fn((cb) => { emitTelemetry = cb; return () => {}; }),
    sendCommandMirror: vi.fn(),
  };
  const hud = await import('../renderer/hud.js');
  await new Promise((r) => setTimeout(r, 0)); // let init()'s awaits settle
  return hud;
}
const stepFrame = (ts) => rafCb(ts);

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.clearAllTimers(); delete window.groundStation; });

describe('ARM / FAILSAFE chip — says the values are not the car\'s', () => {
  it('reads NOT REPORTED BY CAR with no replay source, and is NOT hidden', async () => {
    await loadHud({ telemetrySource: 'none' });
    const chip = el('armChip');
    expect(chip, '#armChip must exist').not.toBeNull();
    expect(chip.textContent).toBe(UNREPORTED);
    // Always visible: the claim is permanently true, and hiding it would be the
    // same silence this closes (cf. ACTIVE AUTHORITY, which is also never hidden).
    expect(chip.classList.contains('hidden')).toBe(false);
  });

  it('reads SIMULATED while the effective telemetry source is replay', async () => {
    await loadHud({ telemetrySource: 'replay' });
    expect(el('armChip').textContent).toBe(SIMULATED);
    expect(el('replayChip').classList.contains('hidden')).toBe(false); // the source marker agrees
  });

  it('follows a runtime source switch through setReplayChip (the setupFlow hook)', async () => {
    const hud = await loadHud({ telemetrySource: 'none' });
    expect(el('armChip').textContent).toBe(UNREPORTED);
    hud.setReplayChip(true);   // applySession resolved a replay source
    expect(el('armChip').textContent).toBe(SIMULATED);
    hud.setReplayChip(false);  // …and back
    expect(el('armChip').textContent).toBe(UNREPORTED);
  });

  it('exports the two labels so the wording has one source of truth', async () => {
    const hud = await loadHud();
    expect(hud.ARM_UNREPORTED_LABEL).toBe(UNREPORTED);
    expect(hud.ARM_SIMULATED_LABEL).toBe(SIMULATED);
    // The unreported wording deliberately mirrors CAMERA MODE's convention.
    const { ACTIVE_AUTHORITY_UNREPORTED_LABEL } = await import('../shared/cameraMode.mjs');
    expect(ACTIVE_AUTHORITY_UNREPORTED_LABEL).toBe('NOT REPORTED BY MAPPER');
    expect(hud.ARM_UNREPORTED_LABEL).toMatch(/NOT REPORTED BY /);
  });
});

describe('LINK LOST provenance — a demo failsafe never looks like a real radio drop', () => {
  it('a REAL trigger (linkQualityPct 0) reads plain LINK LOST', async () => {
    await loadHud();
    // linkQualityPct 0 with fresh telemetry = the ground TX module still reports
    // LINK_STATISTICS and says the link to the car is gone. That is real.
    emitTelemetry({ speedKmh: 0, batteryV: 7.2, linkQualityPct: 0, gear: 1, ersPct: 20 });
    stepFrame(0);
    expect(el('linkStatus').textContent).toBe('LINK LOST');
    expect(el('linkStatus').className).toBe('link lost'); // still a real alarm
  });

  it('a SIMULATED trigger (failsafe true) reads LINK LOST · SIMULATED', async () => {
    await loadHud({ telemetrySource: 'replay' });
    // Only shared/replaySource.js ever sets `failsafe`, so failsafe===true is
    // itself proof of a synthetic trigger — no source plumbing needed.
    emitTelemetry({ speedKmh: 0, batteryV: 7.2, failsafe: true, linkQualityPct: 90, gear: 4, ersPct: 20 });
    stepFrame(0);
    expect(el('linkStatus').textContent).toBe('LINK LOST · SIMULATED');
    expect(el('linkStatus').className).toBe('link lost');
  });

  it('a healthy link is unaffected — LQ still reads plainly', async () => {
    await loadHud();
    emitTelemetry({ speedKmh: 40, batteryV: 8.0, linkQualityPct: 97, gear: 2, ersPct: 80 });
    stepFrame(0);
    expect(el('linkStatus').textContent).toBe('LQ 97%');
    expect(el('linkStatus').className).toBe('link live');
  });

  it('shared/linkState.mjs is untouched: failsafe and LQ==0 still both yield the SAME state', async () => {
    // The suffix is a LABEL, not a new state. Proving the model unchanged is the
    // point — the four states and their tests must not have been reinterpreted.
    const { linkState } = await import('../shared/linkState.mjs');
    const base = { nowMs: 100, lastTelemetryMs: 100, everLive: true };
    expect(linkState({ ...base, linkQualityPct: 0, failsafe: false })).toBe('link-lost');
    expect(linkState({ ...base, linkQualityPct: 90, failsafe: true })).toBe('link-lost');
  });
});

describe('ARM / FAILSAFE chip — resolved CSS contract', () => {
  it('is in the HUD status stack, next to the other provenance markers', () => {
    document.body.innerHTML = bodyHtml;
    const chip = el('armChip');
    expect(chip.closest('.statusstack'), '#armChip must live in the .statusstack').not.toBeNull();
  });

  it('is MUTED — it must not be mistakable for a live value, an alarm, or the replay marker', () => {
    // Class-name-only assertions are the vacuous-pin trap 085e1d1 closed on
    // .barsrc, so pin the resolved declaration: muted token, and explicitly not
    // the teal (live) / amber (alarm) / violet (replay) colours used around it.
    const armchip = rule('.armchip');
    expect(armchip).toMatch(/color:\s*var\(--muted\)/);
    expect(armchip).not.toMatch(/color:\s*var\(--teal\)/);
    expect(armchip).not.toMatch(/color:\s*var\(--amber\)/);
    expect(armchip).not.toMatch(/color:\s*var\(--violet\)/);
    // Same colour token as ACTIVE AUTHORITY's unreported label — one convention.
    expect(rule('.camauthrow b.unreported')).toMatch(/color:\s*var\(--muted\)/);
  });

  it('has no .armchip.hidden rule — nothing may hide it (the claim is always true)', () => {
    expect(css).not.toMatch(/\.armchip\.hidden\s*\{/);
    // …and hud.css has no generic `.hidden` rule that could hide it by accident.
    expect(css).not.toMatch(/(^|\n)\s*\.hidden\s*\{/);
  });
});
