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
  normalizeRacePrep,
} = require('../shared/settings.js');
const { createSettingsStore } = require('../main/settingsStore.js');

// The REAL validator lives in ESM (shared/racePrep.mjs — the ⚙ RACE DAY
// fields and the GARAGE race-day card need it) and cannot be require()'d
// synchronously from the CJS settings model, which is exactly why settings.js
// carries a hand-mirrored copy (normalizeRacePrep) — the lowBatteryPersist /
// wheelProfilePersist construction. This parity corpus is what makes the
// mirror safe: if the two ever drift, it fails.
const { normalizeRacePrepSettings, DEFAULT_RACE_PREP } = await import('../shared/racePrep.mjs');

// A hostile own `__proto__` data key (JSON.parse creates a genuine own key).
const protoPolluted = JSON.parse('{"__proto__": {"polluted": true}, "mapperPath": "C:/m/mapper.exe"}');

const CORPUS = [
  // --- non-object / absent raws: pins the mirrored defaults exactly ---
  undefined,
  null,
  42,
  'race',
  true,
  [],
  ['C:/m/mapper.exe', 'C:/m/w17.json'],
  {},

  // --- valid shapes ---
  { mapperPath: 'C:/m/mapper.exe', profilePath: 'C:/m/w17-ds4.json', autoBridge: true },
  { mapperPath: 'C:/m/mapper.exe', profilePath: 'C:/m/w17-ds4.json', autoBridge: false },
  { mapperPath: '', profilePath: '', autoBridge: true }, // exactly the defaults

  // --- partial ---
  { mapperPath: 'C:/m/mapper.exe' },
  { profilePath: 'C:/m/w17-ds4.json' },
  { autoBridge: false },

  // --- wrong-typed: every field wrong in every direction ---
  { mapperPath: 42, profilePath: null, autoBridge: 'yes' },
  { mapperPath: {}, profilePath: [], autoBridge: 1 },
  { mapperPath: true, profilePath: false, autoBridge: 0 },
  { mapperPath: null, profilePath: undefined, autoBridge: null },
  { mapperPath: ['C:/m'], profilePath: { path: 'x' }, autoBridge: [] },

  // --- truthy-but-not-boolean autoBridge must repair to the default ---
  { autoBridge: 'false' },
  { autoBridge: 'true' },
  { autoBridge: NaN },

  // --- hostile: prototype key, whitespace, flag-looking and huge strings ---
  protoPolluted,
  { mapperPath: '   ', profilePath: '\t' }, // whitespace IS a string — kept as-is (validated downstream)
  { mapperPath: '-headtrack-ingest', profilePath: '-config-file-path' }, // flag-shaped strings persist as strings; the ORCHESTRATOR rejects them at launch
  { mapperPath: 'x'.repeat(4096), profilePath: 'y'.repeat(4096) },
  { mapperPath: 'C:\\Program Files\\W17\\mapper.exe', profilePath: 'C:\\Users\\g\\w17 profile.json' },
];

describe('normalizeRacePrep — parity with the real ESM validator', () => {
  it.each(CORPUS.map((x, i) => [i, x]))(
    'case %#: deep-equals normalizeRacePrepSettings for corpus[%i]',
    (_i, raw) => {
      expect(normalizeRacePrep(raw)).toStrictEqual(normalizeRacePrepSettings(raw));
    },
  );

  it('the corpus is broad (defends against a one-happy-path regression)', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(25);
  });

  it('never throws on any corpus input', () => {
    for (const raw of CORPUS) {
      expect(() => normalizeRacePrep(raw)).not.toThrow();
    }
  });

  it('output is always the complete three-field shape (both impls)', () => {
    for (const raw of CORPUS) {
      for (const impl of [normalizeRacePrep, normalizeRacePrepSettings]) {
        const t = impl(raw);
        expect(Object.keys(t).sort()).toEqual(['autoBridge', 'mapperPath', 'profilePath']);
        expect(typeof t.mapperPath).toBe('string');
        expect(typeof t.profilePath).toBe('string');
        expect(typeof t.autoBridge).toBe('boolean');
      }
    }
  });

  it('the defaults agree between the two modules', () => {
    expect(normalizeRacePrep(undefined)).toStrictEqual(DEFAULT_RACE_PREP);
    expect(normalizeRacePrepSettings(undefined)).toStrictEqual(DEFAULT_RACE_PREP);
    expect(DEFAULT_RACE_PREP.autoBridge).toBe(true); // giftee-friendly default is ON
  });
});

describe('racePrep — persistence through the REAL settings store', () => {
  const freshDir = () => mkdtempSync(join(tmpdir(), 'w17-raceprep-'));

  // Deliberately off-default so a silent revert-to-default is unmistakable
  // (the audit Finding 1 failure mode this subtree must not repeat).
  const CONFIGURED = {
    mapperPath: 'C:/W17/mapper.exe',
    profilePath: 'C:/W17/w17-ds4.json',
    autoBridge: false,
  };

  it('save({racePrep}) RETURNS the subtree (not silently dropped by normalizeSettings)', () => {
    const store = createSettingsStore({ dir: freshDir() });
    const saved = store.save({ racePrep: CONFIGURED });
    expect(saved.racePrep).toEqual(CONFIGURED);
  });

  it('the subtree PERSISTS to disk and survives a restart (fresh store, same file)', () => {
    const dir = freshDir();
    createSettingsStore({ dir }).save({ racePrep: CONFIGURED });

    // A new store instance over the same dir = an app restart.
    const restarted = createSettingsStore({ dir });
    expect(restarted.load().racePrep).toEqual(CONFIGURED);

    // And it is genuinely on disk (not just an in-memory artifact).
    const onDisk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    expect(onDisk.racePrep).toEqual(CONFIGURED);
  });

  it('same-session leave+return: an unrelated save keeps the subtree', () => {
    const dir = freshDir();
    const store = createSettingsStore({ dir });
    store.save({ racePrep: CONFIGURED });
    // An unrelated save funnels through normalizeSettings again — the subtree
    // must ride through untouched (the same-session-reset half of Finding 1).
    const after = store.save({ soundEnabled: true });
    expect(after.racePrep).toEqual(CONFIGURED);
    expect(store.load().racePrep).toEqual(CONFIGURED);
  });

  it('hand-corrupt fields on disk are repaired (not dropped) on load', () => {
    const dir = freshDir();
    createSettingsStore({ dir }).save({ racePrep: { mapperPath: 42, profilePath: [], autoBridge: 'x' } });
    const loaded = createSettingsStore({ dir }).load();
    expect(loaded.racePrep).toEqual(DEFAULT_RACE_PREP);
  });

  it('a session that never touches race day persists EXACTLY the 13 baseline keys', () => {
    const dir = freshDir();
    const store = createSettingsStore({ dir });
    const saved = store.save({ soundEnabled: true }); // never touches racePrep

    // On disk: exactly the 13 baseline keys, no `racePrep`.
    const onDisk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    expect(Object.keys(onDisk).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
    expect(Object.keys(onDisk)).toHaveLength(13);
    expect(onDisk).not.toHaveProperty('racePrep');

    // And the returned/reloaded logical object has no racePrep key either —
    // the consumers' DEFAULT_RACE_PREP fallback is what supplies the values.
    expect(saved).not.toHaveProperty('racePrep');
    expect(store.load()).not.toHaveProperty('racePrep');
  });

  it('normalizeSettings alone: non-object subtrees are dropped, an object is admitted', () => {
    expect(normalizeSettings({ racePrep: null })).not.toHaveProperty('racePrep');
    expect(normalizeSettings({ racePrep: 'x' })).not.toHaveProperty('racePrep');
    expect(normalizeSettings({ racePrep: ['a', 'b'] })).not.toHaveProperty('racePrep');
    // An (even empty) object is a deliberate touch: admitted, filled with the
    // defaults, and persisted explicitly from then on.
    expect(normalizeSettings({ racePrep: {} }).racePrep).toEqual(DEFAULT_RACE_PREP);
  });

  it('all three conditional subtrees coexist — none evicts another', () => {
    const dir = freshDir();
    const store = createSettingsStore({ dir });
    store.save({ wheel: { profile: { steer: { axis: 0 } } } });
    store.save({ lowBattery: { warnV: 7.4, criticalV: 6.9 } });
    store.save({ racePrep: CONFIGURED });
    const loaded = store.load();
    expect(loaded.racePrep).toEqual(CONFIGURED);
    expect(loaded.lowBattery).toEqual({ warnV: 7.4, criticalV: 6.9 });
    expect(loaded.wheel).toBeDefined();
    expect(Object.keys(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))))
      .toHaveLength(16); // 13 baseline + wheel + lowBattery + racePrep
  });

  it('racePrep stays OUT of settingsStore\'s nested-merge list — a partial patch resets, so callers write ALL fields', () => {
    // This pins the CONTRACT the ⚙ saver relies on (the saveWheel() rule):
    // saving {racePrep:{autoBridge:false}} alone REPLACES the whole subtree,
    // so the renderer must always send all three fields. If someone adds
    // racePrep to the store's one-level merge list, this test fails and the
    // rule (and the callers) must be reconsidered together.
    const dir = freshDir();
    const store = createSettingsStore({ dir });
    store.save({ racePrep: CONFIGURED });
    const after = store.save({ racePrep: { autoBridge: true } });
    expect(after.racePrep).toEqual({ ...DEFAULT_RACE_PREP, autoBridge: true });
  });
});
