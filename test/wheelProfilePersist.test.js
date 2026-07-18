import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// Settings model is CommonJS (main-process side); load via require from ESM.
const require = createRequire(import.meta.url);
const {
  DEFAULT_SETTINGS,
  normalizeSettings,
  normalizeWheelProfile,
} = require('../shared/settings.js');
const { createSettingsStore } = require('../main/settingsStore.js');

// The REAL validator lives in ESM (shared/wheelProfile.mjs) and cannot be
// require()'d synchronously from the CJS settings model, which is exactly why
// settings.js carries a hand-mirrored copy (normalizeWheelProfile). This test is
// what makes the mirror safe: over a broad hostile corpus, the mirror must
// deep-equal the real validator. If they ever drift, this fails.
const { normalizeWheelSettings, MAX_DEADZONE } = await import('../shared/wheelProfile.mjs');

// A hostile own `__proto__` data key (an object literal's `__proto__` sets the
// prototype, not an own property — JSON.parse creates a genuine own key).
const protoPolluted = JSON.parse('{"__proto__": {"polluted": true}, "steer": {"axis": 1}}');

const CORPUS = [
  // --- non-object / absent raws: pins the mirrored defaults exactly ---
  undefined,
  null,
  42,
  'wheel',
  true,
  [],
  [{ axis: 1 }],
  {},

  // --- a valid full profile (separate pedals) ---
  {
    steer: { axis: 0 },
    pedalMode: 'separate',
    throttle: { axis: 2, rest: 0.9, full: -0.85 },
    brake: { axis: 3, rest: 1, full: -1 },
    combined: { axis: 1, rest: 0, throttleEnd: 1, brakeEnd: -1 },
    deadzone: 0.12,
    buttons: { gearUp: 7, gearDown: 6, drs: 3, boost: 1, overtake: 2 },
  },
  // --- a valid full profile (combined pedal axis) ---
  {
    steer: { axis: 4 },
    pedalMode: 'combined',
    combined: { axis: 5, rest: 0.1, throttleEnd: 0.95, brakeEnd: -0.9 },
    deadzone: 0,
    buttons: { gearUp: 0, gearDown: 1, drs: 2, boost: 3, overtake: 4 },
  },

  // --- partial ---
  { steer: { axis: 3 } },
  { throttle: { axis: 9 } },
  { deadzone: 0.2 },
  { buttons: { gearUp: 8 } },
  { pedalMode: 'combined' },

  // --- wrong-typed ---
  { steer: 'nope', throttle: 5, brake: null, combined: [], buttons: 'x', deadzone: 'lots' },
  { steer: { axis: 'two' }, throttle: { rest: 'high', full: {} } },
  { pedalMode: 42 },
  { buttons: 42 },

  // --- hostile: prototype key, NaN, Infinity, huge numbers ---
  protoPolluted,
  { steer: { axis: NaN }, deadzone: NaN },
  { steer: { axis: Infinity }, throttle: { axis: -Infinity, rest: Infinity, full: -Infinity } },
  { steer: { axis: 1e9 }, deadzone: 1e12, throttle: { axis: 999999999 } },
  { deadzone: Number.MAX_SAFE_INTEGER, brake: { rest: 1e300, full: -1e300 } },

  // --- boundary: deadzone at / over MAX_DEADZONE / negative ---
  { deadzone: MAX_DEADZONE },
  { deadzone: MAX_DEADZONE + 0.25 },
  { deadzone: -0.3 },
  { deadzone: 1 },

  // --- boundary: negative & float axis indices ---
  { steer: { axis: -1 }, throttle: { axis: -5 } },
  { steer: { axis: 2.7 }, brake: { axis: 3.999 }, combined: { axis: 0.4 } },
  { buttons: { gearUp: -2, gearDown: 4.9, drs: -0.0 } },

  // --- boundary: calibration endpoints past [-1, 1] ---
  { throttle: { rest: 5, full: -5 }, brake: { rest: -9, full: 9 } },
  { combined: { rest: 2, throttleEnd: -3, brakeEnd: 4 } },

  // --- garbage pedalMode ---
  { pedalMode: 'turbo' },
  { pedalMode: '' },
  { pedalMode: 'Combined' }, // case-sensitive: not the whitelisted 'combined'

  // --- explicit-null buttons (deliberate unassign, must be preserved) ---
  { buttons: { gearUp: null, gearDown: null, drs: null, boost: null, overtake: null } },
  { buttons: { gearUp: null, gearDown: 6 } },
  { buttons: { drs: undefined, boost: 'x', overtake: null } },
];

describe('normalizeWheelProfile — parity with the real ESM validator', () => {
  it.each(CORPUS.map((x, i) => [i, x]))(
    'case %#: deep-equals normalizeWheelSettings for corpus[%i]',
    (_i, raw) => {
      expect(normalizeWheelProfile(raw)).toStrictEqual(normalizeWheelSettings(raw));
    },
  );

  it('the corpus is broad (defends against a one-happy-path regression)', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(30);
  });

  it('never throws on any corpus input', () => {
    for (const raw of CORPUS) {
      expect(() => normalizeWheelProfile(raw)).not.toThrow();
    }
  });
});

describe('wheel profile persistence — through the REAL settings store', () => {
  const freshDir = () => mkdtempSync(join(tmpdir(), 'w17-wheel-'));

  // The captured calibration from the audit repro: BTN 7 / AXIS 2 · REST 0.90 ·
  // FULL -0.85. Deliberately off-default so a revert-to-default is unmistakable.
  const CAPTURED = {
    steer: { axis: 0 },
    pedalMode: 'separate',
    throttle: { axis: 2, rest: 0.9, full: -0.85 },
    brake: { axis: 3, rest: 1, full: -1 },
    combined: { axis: 1, rest: 0, throttleEnd: 1, brakeEnd: -1 },
    deadzone: 0.1,
    buttons: { gearUp: 7, gearDown: 6, drs: 3, boost: 1, overtake: 2 },
  };
  const NORMALIZED_CAPTURED = normalizeWheelProfile(CAPTURED);

  it('save({wheel:{profile}}) RETURNS the wheel key (audit §3.1 repro, inverted)', () => {
    const store = createSettingsStore({ dir: freshDir() });
    const saved = store.save({ wheel: { profile: CAPTURED } });
    expect(saved.wheel).toEqual({ profile: NORMALIZED_CAPTURED });
  });

  it('the profile PERSISTS to disk and survives a restart (fresh store, same file)', () => {
    const dir = freshDir();
    createSettingsStore({ dir }).save({ wheel: { profile: CAPTURED } });

    // A new store instance over the same dir = an app restart.
    const restarted = createSettingsStore({ dir });
    const loaded = restarted.load();
    expect(loaded.wheel).toEqual({ profile: NORMALIZED_CAPTURED });

    // And it is genuinely on disk (not just an in-memory artifact).
    const onDisk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    expect(onDisk.wheel).toEqual({ profile: NORMALIZED_CAPTURED });
    expect(onDisk.wheel.profile.throttle).toEqual({ axis: 2, rest: 0.9, full: -0.85 });
    expect(onDisk.wheel.profile.buttons.gearUp).toBe(7);
  });

  it('a hand-corrupt profile on disk is repaired (not dropped) on load', () => {
    const dir = freshDir();
    createSettingsStore({ dir }).save({
      wheel: { profile: { steer: { axis: -3 }, deadzone: 99, pedalMode: 'turbo', buttons: { gearUp: 'x' } } },
    });
    const loaded = createSettingsStore({ dir }).load();
    // repaired to defaults field-by-field, never absent
    expect(loaded.wheel.profile).toEqual(normalizeWheelSettings({
      steer: { axis: -3 }, deadzone: 99, pedalMode: 'turbo', buttons: { gearUp: 'x' },
    }));
  });

  it('a NO-WHEEL session persists EXACTLY the 12 pre-existing keys (no wheel key on disk)', () => {
    const dir = freshDir();
    const store = createSettingsStore({ dir });
    const saved = store.save({ soundEnabled: true }); // a save that never touches the wheel

    // On disk: exactly the 12 baseline keys, no `wheel`.
    const onDisk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    expect(Object.keys(onDisk).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
    expect(Object.keys(onDisk)).toHaveLength(12);
    expect(onDisk).not.toHaveProperty('wheel');

    // And the returned/reloaded logical object has no wheel key either.
    expect(saved).not.toHaveProperty('wheel');
    expect(store.load()).not.toHaveProperty('wheel');
    expect(existsSync(join(dir, 'settings.json'))).toBe(true);
  });

  it('same-session leave+return: a second unrelated save keeps the wheel profile', () => {
    const dir = freshDir();
    const store = createSettingsStore({ dir });
    store.save({ wheel: { profile: CAPTURED } });
    // An unrelated save funnels through normalizeSettings again — the wheel
    // subtree must ride through untouched (the same-session-reset half of §3.1).
    const after = store.save({ soundEnabled: true });
    expect(after.wheel).toEqual({ profile: NORMALIZED_CAPTURED });
    expect(store.load().wheel).toEqual({ profile: NORMALIZED_CAPTURED });
  });

  it('normalizeSettings alone drops a wheel with no profile (shape guard)', () => {
    expect(normalizeSettings({ wheel: {} })).not.toHaveProperty('wheel');
    expect(normalizeSettings({ wheel: null })).not.toHaveProperty('wheel');
    expect(normalizeSettings({ wheel: 'x' })).not.toHaveProperty('wheel');
  });
});
