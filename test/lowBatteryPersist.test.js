import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// Settings model is CommonJS (main-process side); load via require from ESM.
const require = createRequire(import.meta.url);
const {
  DEFAULT_SETTINGS,
  normalizeSettings,
  normalizeLowBattery,
} = require('../shared/settings.js');
const { createSettingsStore } = require('../main/settingsStore.js');

// The REAL validator lives in ESM (shared/lowBattery.mjs — the renderer needs
// it every frame) and cannot be require()'d synchronously from the CJS settings
// model, which is exactly why settings.js carries a hand-mirrored copy
// (normalizeLowBattery) — the wheelProfilePersist.test.js construction. This
// parity corpus is what makes the mirror safe: if the two ever drift, it fails.
const { normalizeLowBatterySettings, DEFAULT_LOW_BATTERY } = await import('../shared/lowBattery.mjs');

// A hostile own `__proto__` data key (JSON.parse creates a genuine own key).
const protoPolluted = JSON.parse('{"__proto__": {"polluted": true}, "warnV": 7.2}');

const CORPUS = [
  // --- non-object / absent raws: pins the mirrored defaults exactly ---
  undefined,
  null,
  42,
  'volts',
  true,
  [],
  [7, 6.6],
  {},

  // --- valid pairs ---
  { warnV: 7.4, criticalV: 6.9 },
  { warnV: 10.5, criticalV: 9.9 }, // a 3S pack
  { warnV: 7, criticalV: 6.6 },    // exactly the defaults

  // --- partial ---
  { warnV: 7.2 },
  { criticalV: 6.4 },
  { warnV: 6.0 }, // partial that inverts against the DEFAULT critical

  // --- wrong-typed ---
  { warnV: 'high', criticalV: {} },
  { warnV: [], criticalV: 'low' },
  { warnV: null, criticalV: null },
  { warnV: true, criticalV: false }, // booleans: expectation pinned below, not just parity

  // --- hostile: prototype key, NaN, Infinity, huge/tiny numbers ---
  protoPolluted,
  { warnV: NaN, criticalV: NaN },
  { warnV: Infinity, criticalV: -Infinity },
  { warnV: 1e9, criticalV: 1e-9 },
  { warnV: Number.MAX_SAFE_INTEGER, criticalV: Number.MIN_SAFE_INTEGER },

  // --- boundary: the [1, 60] volts sanity band ---
  { warnV: 1, criticalV: 1 },
  { warnV: 60, criticalV: 60 },
  { warnV: 0.99, criticalV: 0.5 },
  { warnV: 60.01, criticalV: 61 },
  { warnV: 0, criticalV: -7 },
  { warnV: 1 }, // in-band warn below the default critical (cross-field repair)

  // --- inverted pairs (critical above warn) ---
  { warnV: 6.8, criticalV: 7.6 },
  { warnV: 7.0, criticalV: 7.0001 },

  // --- numeric strings coerce like every other settings number ---
  { warnV: '7.4', criticalV: '6.9' },
  { warnV: '7,4' }, // locale comma is NOT a number — repairs to default
];

describe('normalizeLowBattery — parity with the real ESM validator', () => {
  it.each(CORPUS.map((x, i) => [i, x]))(
    'case %#: deep-equals normalizeLowBatterySettings for corpus[%i]',
    (_i, raw) => {
      expect(normalizeLowBattery(raw)).toStrictEqual(normalizeLowBatterySettings(raw));
    },
  );

  it('the corpus is broad (defends against a one-happy-path regression)', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(30);
  });

  it('never throws on any corpus input', () => {
    for (const raw of CORPUS) {
      expect(() => normalizeLowBattery(raw)).not.toThrow();
    }
  });

  it('the invariant critical <= warn holds over the whole corpus (both impls)', () => {
    for (const raw of CORPUS) {
      for (const impl of [normalizeLowBattery, normalizeLowBatterySettings]) {
        const t = impl(raw);
        expect(t.criticalV).toBeLessThanOrEqual(t.warnV);
      }
    }
  });

  it('booleans are invalid thresholds, not 1/0 volts — repair to defaults in BOTH impls', () => {
    // Parity alone would pass if both mirrors shared the same coercion bug
    // (Number(true) === 1 sits inside the [1..60] band, silently disarming
    // the banner with a 1 V warn line) — so the EXPECTED value is pinned
    // here, against each implementation independently.
    for (const impl of [normalizeLowBattery, normalizeLowBatterySettings]) {
      expect(impl({ warnV: true, criticalV: false })).toStrictEqual(DEFAULT_LOW_BATTERY);
      expect(impl({ warnV: true })).toStrictEqual(DEFAULT_LOW_BATTERY);
      expect(impl({ criticalV: true })).toStrictEqual(DEFAULT_LOW_BATTERY);
    }
  });
});

describe('low-battery thresholds — persistence through the REAL settings store', () => {
  const freshDir = () => mkdtempSync(join(tmpdir(), 'w17-lowbatt-'));

  // Deliberately off-default so a silent revert-to-default is unmistakable
  // (the audit Finding 1 failure mode this subtree must not repeat).
  const TUNED = { warnV: 7.4, criticalV: 6.9 };

  it('save({lowBattery}) RETURNS the subtree (not silently dropped by normalizeSettings)', () => {
    const store = createSettingsStore({ dir: freshDir() });
    const saved = store.save({ lowBattery: TUNED });
    expect(saved.lowBattery).toEqual(TUNED);
  });

  it('the thresholds PERSIST to disk and survive a restart (fresh store, same file)', () => {
    const dir = freshDir();
    createSettingsStore({ dir }).save({ lowBattery: TUNED });

    // A new store instance over the same dir = an app restart.
    const restarted = createSettingsStore({ dir });
    expect(restarted.load().lowBattery).toEqual(TUNED);

    // And it is genuinely on disk (not just an in-memory artifact).
    const onDisk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    expect(onDisk.lowBattery).toEqual(TUNED);
  });

  it('same-session leave+return: an unrelated save keeps the thresholds', () => {
    const dir = freshDir();
    const store = createSettingsStore({ dir });
    store.save({ lowBattery: TUNED });
    // An unrelated save funnels through normalizeSettings again — the subtree
    // must ride through untouched (the same-session-reset half of Finding 1).
    const after = store.save({ soundEnabled: true });
    expect(after.lowBattery).toEqual(TUNED);
    expect(store.load().lowBattery).toEqual(TUNED);
  });

  it('hand-corrupt thresholds on disk are repaired (not dropped) on load', () => {
    const dir = freshDir();
    createSettingsStore({ dir }).save({ lowBattery: { warnV: 999, criticalV: 'x' } });
    const loaded = createSettingsStore({ dir }).load();
    expect(loaded.lowBattery).toEqual(DEFAULT_LOW_BATTERY);
  });

  it('an inverted pair is repaired conservatively on the way to disk', () => {
    const dir = freshDir();
    createSettingsStore({ dir }).save({ lowBattery: { warnV: 6.8, criticalV: 7.6 } });
    const onDisk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    expect(onDisk.lowBattery).toEqual({ warnV: 6.8, criticalV: 6.8 });
  });

  it('a session that never touches the thresholds persists EXACTLY the 13 baseline keys', () => {
    const dir = freshDir();
    const store = createSettingsStore({ dir });
    const saved = store.save({ soundEnabled: true }); // never touches lowBattery

    // On disk: exactly the 13 baseline keys, no `lowBattery` (and no `wheel`).
    const onDisk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    expect(Object.keys(onDisk).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
    expect(Object.keys(onDisk)).toHaveLength(13);
    expect(onDisk).not.toHaveProperty('lowBattery');

    // And the returned/reloaded logical object has no lowBattery key either —
    // the renderer's DEFAULT_LOW_BATTERY fallback is what supplies the values.
    expect(saved).not.toHaveProperty('lowBattery');
    expect(store.load()).not.toHaveProperty('lowBattery');
  });

  it('normalizeSettings alone: non-object subtrees are dropped, an object is admitted', () => {
    expect(normalizeSettings({ lowBattery: null })).not.toHaveProperty('lowBattery');
    expect(normalizeSettings({ lowBattery: 'x' })).not.toHaveProperty('lowBattery');
    expect(normalizeSettings({ lowBattery: [7, 6.6] })).not.toHaveProperty('lowBattery');
    // An (even empty) object is a deliberate touch: admitted, filled with the
    // defaults, and persisted explicitly from then on.
    expect(normalizeSettings({ lowBattery: {} }).lowBattery).toEqual(DEFAULT_LOW_BATTERY);
  });

  it('wheel and lowBattery coexist — two conditional subtrees never evict each other', () => {
    const dir = freshDir();
    const store = createSettingsStore({ dir });
    store.save({ wheel: { profile: { steer: { axis: 0 } } } });
    store.save({ lowBattery: TUNED });
    const loaded = store.load();
    expect(loaded.lowBattery).toEqual(TUNED);
    expect(loaded.wheel).toBeDefined();
    expect(Object.keys(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))))
      .toHaveLength(15); // 13 baseline + wheel + lowBattery
  });
});
