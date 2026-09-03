// @vitest-environment jsdom
// Unmissable low-battery banner (vision operator model, done-bar item 8).
//
// WHY THIS FILE EXISTS: the warn-never-auto-cut safety invariant means UX
// carries the ENTIRE burden of low battery — if the banner is missable, wrong,
// or flickery, nothing else stands behind it. Two layers are pinned here:
// the pure level model (thresholds + hysteresis, shared/lowBattery.mjs) and
// the REAL renderer/hud.js against renderer/index.html under jsdom (the
// armFailsafeLabel.test.js pattern), so the copy, the tones, the no-telemetry
// absence, and the never-overlaps-the-indicators placement contract are all
// asserted at the integration level.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_LOW_BATTERY, LOW_BATTERY_HYSTERESIS_V, LOW_BATTERY_LABELS,
  normalizeLowBatterySettings, lowBatteryLevel,
} from '../shared/lowBattery.mjs';

const html = readFileSync('renderer/index.html', 'utf8');
const css = readFileSync('renderer/hud.css', 'utf8');
const bodyHtml = html
  .match(/<body>([\s\S]*)<\/body>/)[1]
  .replace(/<script[\s\S]*?<\/script>/g, ''); // the test imports the module itself

const el = (id) => document.getElementById(id);

const WARN_COPY = 'BATTERY LOW — finish your lap and park';
const CRIT_COPY = 'BATTERY CRITICAL — park the car now';

function rule(sel) {
  const re = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const m = css.match(re);
  if (!m) throw new Error(`no CSS rule found for "${sel}"`);
  return m[1];
}

// ---------- pure model ----------

describe('normalizeLowBatterySettings — thresholds are settings with safe defaults', () => {
  it('defaults are the 2S pack values: warn 7.0 V, critical 6.6 V', () => {
    expect(DEFAULT_LOW_BATTERY).toEqual({ warnV: 7, criticalV: 6.6 });
    expect(normalizeLowBatterySettings()).toEqual({ warnV: 7, criticalV: 6.6 });
    expect(normalizeLowBatterySettings(null)).toEqual({ warnV: 7, criticalV: 6.6 });
    expect(normalizeLowBatterySettings('garbage')).toEqual({ warnV: 7, criticalV: 6.6 });
  });

  it('both thresholds are configurable and repair field-by-field', () => {
    expect(normalizeLowBatterySettings({ warnV: 7.4, criticalV: 6.9 }))
      .toEqual({ warnV: 7.4, criticalV: 6.9 });
    // one bad field never nukes the good one
    expect(normalizeLowBatterySettings({ warnV: 'lots', criticalV: 6.9 }))
      .toEqual({ warnV: 7, criticalV: 6.9 });
    expect(normalizeLowBatterySettings({ warnV: 7.4, criticalV: NaN }))
      .toEqual({ warnV: 7.4, criticalV: 6.6 });
  });

  it('rejects out-of-band values (unit mistakes) back to defaults', () => {
    for (const bad of [0, -7, 0.99, 60.5, 7000, Infinity, -Infinity]) {
      expect(normalizeLowBatterySettings({ warnV: bad }).warnV).toBe(7);
      expect(normalizeLowBatterySettings({ criticalV: bad }).criticalV).toBe(6.6);
    }
  });

  it('an inverted pair repairs conservatively: critical is lowered to warn', () => {
    expect(normalizeLowBatterySettings({ warnV: 6.8, criticalV: 7.6 }))
      .toEqual({ warnV: 6.8, criticalV: 6.8 });
    // …including when the inversion comes from one field defaulting
    expect(normalizeLowBatterySettings({ warnV: 6.0 }))
      .toEqual({ warnV: 6, criticalV: 6 });
  });
});

describe('lowBatteryLevel — thresholds and hysteresis (no flicker at the boundary)', () => {
  const T = DEFAULT_LOW_BATTERY; // warn 7.0 / critical 6.6
  const step = (batteryV, prevLevel) => lowBatteryLevel({ batteryV, prevLevel, thresholds: T });

  it('enters warn/critical the instant the voltage touches the threshold', () => {
    expect(step(7.5, 'ok')).toBe('ok');
    expect(step(7.0, 'ok')).toBe('warn');      // exactly at warn
    expect(step(6.9, 'ok')).toBe('warn');
    expect(step(6.6, 'ok')).toBe('critical');  // exactly at critical
    expect(step(6.6, 'warn')).toBe('critical');
    expect(step(3.2, 'ok')).toBe('critical');  // entry never waits on hysteresis
  });

  it('warn does NOT flicker while a sagging pack hovers at the boundary', () => {
    let level = 'ok';
    // Throttle sag / idle recovery oscillating just around 7.0 V, always
    // inside the hysteresis band above it: once warned, stays warned.
    for (const v of [6.98, 7.05, 6.97, 7.1, 6.99, 7.14, 7.05]) {
      level = step(v, level);
      expect(level).toBe('warn');
    }
    // Full recovery (warn + hysteresis) is what clears it.
    expect(step(7 + LOW_BATTERY_HYSTERESIS_V, level)).toBe('ok');
    // …and the same voltage arriving fresh from 'ok' was never a warning.
    expect(step(7.05, 'ok')).toBe('ok');
  });

  it('critical is sticky the same way, and steps DOWN through warn, never straight to ok', () => {
    let level = step(6.55, 'ok');
    expect(level).toBe('critical');
    level = step(6.7, level); // above critical but inside its hysteresis band
    expect(level).toBe('critical');
    level = step(6.9, level); // recovered past 6.75 — but that is still warn territory
    expect(level).toBe('warn');
    level = step(7.05, level); // inside warn's hysteresis band — still warn
    expect(level).toBe('warn');
    level = step(7.2, level);
    expect(level).toBe('ok');
  });

  it('a single-reading jump from critical past warn+hysteresis still ratchets through warn', () => {
    // The adversarial-review case: a worn pack sags to critical under
    // throttle, then one idle reading recovers FAR past warn + hysteresis.
    // Without the prevLevel==='critical' ratchet this returned 'ok' in one
    // frame — the banner blinked straight off, contradicting the
    // one-level-at-a-time exit contract.
    let level = step(6.5, 'ok');
    expect(level).toBe('critical');
    level = step(7.3, level); // ≥ warnV + hysteresis in ONE reading
    expect(level).toBe('warn'); // ratchet: never straight to ok
    level = step(7.3, level); // warn's own exit runs on the NEXT reading
    expect(level).toBe('ok');
    // …and the ratchet is critical-only: the same jump from 'warn' clears.
    expect(step(7.3, 'warn')).toBe('ok');
  });

  it('no reading, no claim: non-finite voltages are ok from any previous level', () => {
    for (const v of [undefined, null, NaN, 'seven', {}]) {
      expect(lowBatteryLevel({ batteryV: v, prevLevel: 'critical', thresholds: T })).toBe('ok');
    }
  });

  it('respects custom thresholds (a bigger pack)', () => {
    const t3s = { warnV: 10.5, criticalV: 9.9 };
    expect(lowBatteryLevel({ batteryV: 10.4, prevLevel: 'ok', thresholds: t3s })).toBe('warn');
    expect(lowBatteryLevel({ batteryV: 9.9, prevLevel: 'ok', thresholds: t3s })).toBe('critical');
    expect(lowBatteryLevel({ batteryV: 7.5, prevLevel: 'ok', thresholds: DEFAULT_LOW_BATTERY })).toBe('ok');
  });
});

// ---------- the real renderer under jsdom ----------

let rafCb = null;
let emitTelemetry = null;
let emitRaceDay = null;

async function loadHud({ settings = null } = {}) {
  vi.resetModules();
  document.body.innerHTML = bodyHtml;
  rafCb = null;
  emitTelemetry = null;
  emitRaceDay = null;
  window.requestAnimationFrame = (cb) => { rafCb = cb; return 1; };
  Object.defineProperty(window.navigator, 'getGamepads', { configurable: true, value: () => [] });
  window.groundStation = {
    getConfig: vi.fn(async () => ({ whepUrl: '', w3Active: false, feel: null, telemetrySource: 'none' })),
    getSettings: vi.fn(async () => ({ settings, envOverridden: {} })),
    onTelemetry: vi.fn((cb) => { emitTelemetry = cb; return () => {}; }),
    onRaceDayState: vi.fn((cb) => { emitRaceDay = cb; return () => {}; }),
    sendCommandMirror: vi.fn(),
  };
  const hud = await import('../renderer/hud.js');
  await new Promise((r) => setTimeout(r, 0)); // let init()'s awaits settle
  return hud;
}
const stepFrame = (ts) => rafCb(ts);
const banner = () => el('lowBattBanner');

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.clearAllTimers(); delete window.groundStation; });

describe('low-battery banner — absent without telemetry', () => {
  it('is hidden and empty before any telemetry has ever arrived (sim state)', async () => {
    await loadHud();
    stepFrame(0);
    expect(banner()).not.toBeNull();
    expect(banner().classList.contains('hidden')).toBe(true);
    expect(banner().textContent).toBe('');
  });

  it('stays hidden while live telemetry simply lacks a battery field', async () => {
    await loadHud();
    emitTelemetry({ speedKmh: 12, linkQualityPct: 95, gear: 2 });
    stepFrame(0);
    expect(banner().classList.contains('hidden')).toBe(true);
  });

  it('a healthy battery raises nothing', async () => {
    await loadHud();
    emitTelemetry({ batteryV: 7.9, linkQualityPct: 95 });
    stepFrame(0);
    expect(banner().classList.contains('hidden')).toBe(true);
  });
});

describe('low-battery banner — plain-language copy and severity tones', () => {
  it('warn: exact copy, amber class, visible', async () => {
    await loadHud();
    emitTelemetry({ batteryV: 6.9, linkQualityPct: 95 });
    stepFrame(0);
    expect(banner().classList.contains('hidden')).toBe(false);
    expect(banner().textContent).toBe(WARN_COPY);
    expect(banner().className).toBe('lowbatt warn');
  });

  it('critical: more severe — its own copy and class', async () => {
    await loadHud();
    emitTelemetry({ batteryV: 6.5, linkQualityPct: 95 });
    stepFrame(0);
    expect(banner().textContent).toBe(CRIT_COPY);
    expect(banner().className).toBe('lowbatt critical');
  });

  it('the copy has one source of truth in shared/lowBattery.mjs', () => {
    expect(LOW_BATTERY_LABELS.warn).toBe(WARN_COPY);
    expect(LOW_BATTERY_LABELS.critical).toBe(CRIT_COPY);
  });

  it('hysteresis carries through the real render loop — no flicker at the boundary', async () => {
    await loadHud();
    emitTelemetry({ batteryV: 6.98, linkQualityPct: 95 });
    stepFrame(0);
    expect(banner().className).toBe('lowbatt warn');
    // recovers a hair above the threshold: still warned, no flicker
    emitTelemetry({ batteryV: 7.05, linkQualityPct: 95 });
    stepFrame(16);
    expect(banner().className).toBe('lowbatt warn');
    expect(banner().textContent).toBe(WARN_COPY);
    // full recovery clears it
    emitTelemetry({ batteryV: 7.2, linkQualityPct: 95 });
    stepFrame(32);
    expect(banner().classList.contains('hidden')).toBe(true);
    expect(banner().textContent).toBe('');
  });

  it('critical de-escalates through warn as the pack recovers at idle', async () => {
    await loadHud();
    emitTelemetry({ batteryV: 6.5, linkQualityPct: 95 });
    stepFrame(0);
    expect(banner().className).toBe('lowbatt critical');
    emitTelemetry({ batteryV: 6.7, linkQualityPct: 95 }); // inside critical's hysteresis band
    stepFrame(16);
    expect(banner().className).toBe('lowbatt critical');
    emitTelemetry({ batteryV: 6.9, linkQualityPct: 95 });
    stepFrame(32);
    expect(banner().className).toBe('lowbatt warn');
    expect(banner().textContent).toBe(WARN_COPY);
  });
});

describe('low-battery banner — persisted thresholds reach the renderer', () => {
  it('applies settings.lowBattery from the store on init (no new IPC key: getSettings)', async () => {
    await loadHud({ settings: { lowBattery: { warnV: 9, criticalV: 8 } } });
    emitTelemetry({ batteryV: 8.5, linkQualityPct: 95 }); // healthy for 2S, low for this pack
    stepFrame(0);
    expect(banner().className).toBe('lowbatt warn');
  });

  it('setLowBatteryThresholds (the ⚙ hook) retunes the live HUD immediately', async () => {
    const hud = await loadHud();
    emitTelemetry({ batteryV: 7.5, linkQualityPct: 95 });
    stepFrame(0);
    expect(banner().classList.contains('hidden')).toBe(true);
    hud.setLowBatteryThresholds({ warnV: 7.8, criticalV: 7.2 });
    emitTelemetry({ batteryV: 7.5, linkQualityPct: 95 });
    stepFrame(16);
    expect(banner().className).toBe('lowbatt warn');
    // garbage from the ⚙ path degrades to the safe defaults, never a crash
    hud.setLowBatteryThresholds('nonsense');
    emitTelemetry({ batteryV: 7.5, linkQualityPct: 95 });
    stepFrame(32);
    expect(banner().classList.contains('hidden')).toBe(true);
  });
});

describe('low-battery banner — held (dimmed) through TELEMETRY LOST, like every real value', () => {
  it('an active warning stays up and goes stale when the stream dies', async () => {
    await loadHud();
    // Drive the same clock linkState reads (performance.now), so staleness is
    // deterministic — no real waiting, no fake-timer/performance coupling.
    const nowSpy = vi.spyOn(performance, 'now');
    nowSpy.mockReturnValue(1000);
    emitTelemetry({ batteryV: 6.9, linkQualityPct: 95 }); // freshness stamped at 1000
    stepFrame(1000);
    expect(banner().className).toBe('lowbatt warn');
    // No packets for > TELEMETRY_FRESH_MS (1 s): the stream is stale.
    nowSpy.mockReturnValue(2600);
    stepFrame(2600);
    expect(el('linkStatus').textContent).toBe('TELEMETRY LOST');
    expect(banner().className).toBe('lowbatt warn stale'); // still warning, honestly dimmed
    expect(banner().textContent).toBe(WARN_COPY);
    nowSpy.mockRestore();
  });
});

describe('low-battery banner — never overlaps or blocks the failsafe/armed indicators', () => {
  it('lives OUTSIDE the .statusstack (the armed/failsafe/link chips keep their column)', () => {
    document.body.innerHTML = bodyHtml;
    expect(banner().closest('.statusstack')).toBeNull();
    // …and the arm chip is still where its own contract test expects it.
    expect(el('armChip').closest('.statusstack')).not.toBeNull();
  });

  it('resolved CSS contract: centred band below the top chrome, never click-blocking', () => {
    const lowbatt = rule('.lowbatt');
    // pointer-events:none = cannot BLOCK any indicator or control.
    expect(lowbatt).toMatch(/pointer-events:\s*none/);
    // 30vh top anchor = geometrically clear of the .statusstack / rev strip
    // (both end well above 30vh at the 1024×640 floor — see the CSS comment).
    expect(lowbatt).toMatch(/top:\s*30vh/);
    expect(lowbatt).toMatch(/left:\s*50%/);
    // Element-scoped hidden rule (hud.css has no generic .hidden — pinned by
    // armFailsafeLabel.test.js; without this the class would be inert).
    expect(rule('.lowbatt.hidden')).toMatch(/display:\s*none/);
    // Severity tones: warn amber, critical red + pulse (more severe).
    expect(rule('.lowbatt.warn')).toMatch(/var\(--amber\)/);
    expect(rule('.lowbatt.critical')).toMatch(/var\(--red\)/);
    expect(rule('.lowbatt.critical')).toMatch(/animation:\s*lowbattpulse/);
    // The pulse respects prefers-reduced-motion alongside the app's others.
    expect(css).toMatch(/prefers-reduced-motion:reduce\)\{\.rev\.redline i,\.dot,\.ersfill\.deploy,\.lowbatt\.critical\{animation:none\}/);
  });

  it('is aria-live via role=alert so the state change is announced', () => {
    document.body.innerHTML = bodyHtml;
    expect(banner().getAttribute('role')).toBe('alert');
  });
});

// ---------- the drive-program alarm, on the LIVE HUD (review giftee-ux-5) ----
// The defect: once the gate is hidden the race-day card is off-screen, so a
// drive program that died mid-drive was invisible — the car stopped answering
// the controller and nothing on this screen said why, while the booklet's
// recovery cue pointed at a card the operator could not see.
const driveBanner = () => el('driveAlarmBanner');
const raceDaySnap = (mapperStatus, kind) => ({
  seq: 1,
  running: false,
  mapper: {},
  steps: [
    { id: 'hotspot', status: 'ok', kind: 'verified' },
    { id: 'mapper', status: mapperStatus, kind },
    { id: 'telemetry', status: 'ok', kind: 'live' },
    { id: 'bridge', status: 'ok', kind: 'on' },
  ],
});

describe('drive-program alarm on the live HUD (review giftee-ux-5)', () => {
  it('exists and is silent until something goes wrong', async () => {
    await loadHud();
    expect(driveBanner()).not.toBeNull();
    expect(driveBanner().classList.contains('hidden')).toBe(true);
    emitRaceDay(raceDaySnap('ok', 'running'));
    expect(driveBanner().classList.contains('hidden')).toBe(true);
    expect(driveBanner().textContent).toBe('');
  });

  it('a drive program that died raises the plain line, in red, on the cockpit view', async () => {
    await loadHud();
    emitRaceDay(raceDaySnap('fail', 'exited'));
    expect(driveBanner().classList.contains('hidden')).toBe(false);
    expect(driveBanner().textContent)
      .toBe('DRIVE PROGRAM STOPPED — she is not being driven. Open ⚙ and press RACE DAY again');
    expect(driveBanner().className).toBe('lowbatt drivealarm');
  });

  it('a dead radio names the cable instead', async () => {
    await loadHud();
    emitRaceDay(raceDaySnap('fail', 'link-down'));
    expect(driveBanner().textContent)
      .toBe('THE RADIO STOPPED — she is not being driven. Check the cable to the little radio box, then ⚙ → RACE DAY');
  });

  it('it clears again when the drive program comes back', async () => {
    await loadHud();
    emitRaceDay(raceDaySnap('fail', 'exited'));
    expect(driveBanner().classList.contains('hidden')).toBe(false);
    emitRaceDay(raceDaySnap('ok', 'running'));
    expect(driveBanner().classList.contains('hidden')).toBe(true);
  });

  it('it never blocks a control (pointer-events discipline is shared with the low-battery banner)', async () => {
    await loadHud();
    emitRaceDay(raceDaySnap('fail', 'exited'));
    // Same base class, so the same pointer-events:none / positioning rules.
    expect(driveBanner().classList.contains('lowbatt')).toBe(true);
    // …and the two can coexist without one replacing the other.
    emitTelemetry({ batteryV: 6.5, linkQualityPct: 95 });
    stepFrame(0);
    expect(banner().classList.contains('hidden')).toBe(false);
    expect(driveBanner().classList.contains('hidden')).toBe(false);
  });

  it('a HUD opened outside Electron (no push channel) simply has no alarm', async () => {
    await loadHud();
    // The subscription is optional at the preload boundary; renderDriveAlarm is
    // still safe to call directly with anything.
    const hud = await import('../renderer/hud.js');
    expect(hud.renderDriveAlarm(null)).toBeNull();
    expect(driveBanner().classList.contains('hidden')).toBe(true);
  });
});
