import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// Settings model is CommonJS (main-process side); load via require from ESM.
const require = createRequire(import.meta.url);
const {
  DEFAULT_SETTINGS,
  normalizeSettings,
  normalizeVideo,
} = require('../shared/settings.js');
const { createSettingsStore } = require('../main/settingsStore.js');

// The REAL validator lives in ESM (shared/videoProfiles.mjs — the renderer
// resolves the player knobs from it, main.js dynamic-imports the mediamtx
// knobs) and cannot be require()'d synchronously from the CJS settings model,
// which is exactly why settings.js carries a hand-mirrored copy
// (normalizeVideo) — the wheelProfilePersist/lowBatteryPersist construction.
// This parity corpus is what makes the mirror safe: if the two ever drift, it
// fails.
const { normalizeVideoSettings, DEFAULT_VIDEO_SETTINGS } = await import('../shared/videoProfiles.mjs');

// A hostile own `__proto__` data key (JSON.parse creates a genuine own key).
const protoPolluted = JSON.parse('{"__proto__": {"polluted": true}, "profile": "showpiece"}');

const CORPUS = [
  // --- non-object / absent raws: pins the mirrored default exactly ---
  undefined,
  null,
  42,
  'showpiece',
  true,
  [],
  ['drive'],
  {},

  // --- valid ---
  { profile: 'drive' },
  { profile: 'showpiece' },

  // --- near-miss ids: enum is exact, no trimming/case-folding/aliases ---
  { profile: 'DRIVE' },
  { profile: 'Showpiece' },
  { profile: ' drive' },
  { profile: 'showpiece ' },
  { profile: 'show-piece' },
  { profile: 'cinema' },
  { profile: 'racing' },

  // --- wrong-typed profile values ---
  { profile: 0 },
  { profile: 1 },
  { profile: null },
  { profile: undefined },
  { profile: true },
  { profile: ['showpiece'] },
  { profile: { id: 'showpiece' } },
  { profile: NaN },

  // --- hostile shapes ---
  protoPolluted,
  { profile: 'showpiece', extra: 'ride-along' },
  { PROFILE: 'showpiece' },
  Object.assign([], { profile: 'showpiece' }), // an array with an own key is still an array
  { toString: () => 'showpiece' },
];

describe('normalizeVideo — parity with the real ESM validator', () => {
  it.each(CORPUS.map((x, i) => [i, x]))(
    'case %#: deep-equals normalizeVideoSettings for corpus[%i]',
    (_i, raw) => {
      expect(normalizeVideo(raw)).toStrictEqual(normalizeVideoSettings(raw));
    },
  );

  it('the corpus is broad (defends against a one-happy-path regression)', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(25);
  });

  it('never throws on any corpus input', () => {
    for (const raw of CORPUS) {
      expect(() => normalizeVideo(raw)).not.toThrow();
    }
  });

  it('only the two canonical ids survive; everything else lands on the DRIVE default (both impls)', () => {
    for (const raw of CORPUS) {
      for (const impl of [normalizeVideo, normalizeVideoSettings]) {
        const out = impl(raw);
        expect(Object.keys(out)).toEqual(['profile']);
        expect(['drive', 'showpiece']).toContain(out.profile);
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)
          || (raw.profile !== 'drive' && raw.profile !== 'showpiece')) {
          expect(out).toStrictEqual({ ...DEFAULT_VIDEO_SETTINGS });
        }
      }
    }
  });
});

describe('video profile — persistence through the REAL settings store', () => {
  const freshDir = () => mkdtempSync(join(tmpdir(), 'w17-videoprof-'));

  // Deliberately the NON-default profile so a silent revert-to-default is
  // unmistakable (the audit Finding 1 failure mode this subtree must not
  // repeat).
  const TUNED = { profile: 'showpiece' };

  it('save({video}) RETURNS the subtree (not silently dropped by normalizeSettings)', () => {
    const store = createSettingsStore({ dir: freshDir() });
    const saved = store.save({ video: TUNED });
    expect(saved.video).toEqual(TUNED);
  });

  it('the profile PERSISTS to disk and survives a restart (fresh store, same file)', () => {
    const dir = freshDir();
    createSettingsStore({ dir }).save({ video: TUNED });

    // A new store instance over the same dir = an app restart.
    const restarted = createSettingsStore({ dir });
    expect(restarted.load().video).toEqual(TUNED);

    // And it is genuinely on disk (not just an in-memory artifact).
    const onDisk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    expect(onDisk.video).toEqual(TUNED);
  });

  it('same-session leave+return: an unrelated save keeps the profile', () => {
    const dir = freshDir();
    const store = createSettingsStore({ dir });
    store.save({ video: TUNED });
    // An unrelated save funnels through normalizeSettings again — the subtree
    // must ride through untouched (the same-session-reset half of Finding 1).
    const after = store.save({ soundEnabled: true });
    expect(after.video).toEqual(TUNED);
    expect(store.load().video).toEqual(TUNED);
  });

  it('a garbage profile id is repaired to DRIVE on the way to disk, never persisted raw', () => {
    const dir = freshDir();
    createSettingsStore({ dir }).save({ video: { profile: 'imax-8k' } });
    const onDisk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    expect(onDisk.video).toEqual({ profile: 'drive' });
  });

  it('hand-corrupt profile on disk is repaired (not dropped) on load', () => {
    const dir = freshDir();
    const store = createSettingsStore({ dir });
    store.save({ video: TUNED });
    const file = join(dir, 'settings.json');
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    raw.video = { profile: 42, evil: true };
    writeFileSync(file, JSON.stringify(raw), 'utf8');
    expect(createSettingsStore({ dir }).load().video).toEqual({ profile: 'drive' });
  });

  it('a session that never touches the profile persists EXACTLY the 13 baseline keys', () => {
    const dir = freshDir();
    const store = createSettingsStore({ dir });
    const saved = store.save({ soundEnabled: true }); // never touches video

    // On disk: exactly the 13 baseline keys, no `video` (and no wheel/lowBattery).
    const onDisk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    expect(Object.keys(onDisk).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
    expect(Object.keys(onDisk)).toHaveLength(13);
    expect(onDisk).not.toHaveProperty('video');

    // And the returned/reloaded logical object has no video key either — the
    // consumers' DRIVE fallback is what supplies the value.
    expect(saved).not.toHaveProperty('video');
    expect(store.load()).not.toHaveProperty('video');
  });

  it('normalizeSettings alone: non-object subtrees are dropped, an object is admitted', () => {
    expect(normalizeSettings({ video: null })).not.toHaveProperty('video');
    expect(normalizeSettings({ video: 'showpiece' })).not.toHaveProperty('video');
    expect(normalizeSettings({ video: ['showpiece'] })).not.toHaveProperty('video');
    // An (even empty) object is a deliberate touch: admitted, filled with the
    // default, and persisted explicitly from then on.
    expect(normalizeSettings({ video: {} }).video).toEqual({ profile: 'drive' });
  });

  it('the subtree is SELF-CONTAINED: only `profile` survives normalization (sibling-wave isolation)', () => {
    // A sibling wave adds its own top-level subtree (racePrep); nothing that
    // wave writes can ride inside `video`, and nothing inside `video` leaks
    // out: unknown nested keys are dropped, unknown top-level keys stay the
    // normalizer's business (dropped today, admitted by THEIR wave when it
    // lands its own conditional spread).
    const s = normalizeSettings({ video: { profile: 'showpiece', racePrep: { armed: true } } });
    expect(s.video).toStrictEqual({ profile: 'showpiece' });
    expect(normalizeSettings({ video: TUNED, racePrep: { armed: true } }).video)
      .toStrictEqual(TUNED);
  });

  it('video, wheel and lowBattery coexist — conditional subtrees never evict each other', () => {
    const dir = freshDir();
    const store = createSettingsStore({ dir });
    store.save({ wheel: { profile: { steer: { axis: 0 } } } });
    store.save({ lowBattery: { warnV: 7.4, criticalV: 6.9 } });
    store.save({ video: TUNED });
    const loaded = store.load();
    expect(loaded.video).toEqual(TUNED);
    expect(loaded.wheel).toBeDefined();
    expect(loaded.lowBattery).toEqual({ warnV: 7.4, criticalV: 6.9 });
    expect(Object.keys(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))))
      .toHaveLength(16); // 13 baseline + wheel + lowBattery + video
  });
});
