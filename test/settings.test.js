import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import * as fsReal from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// Settings modules are CommonJS (main-process side); load via require from ESM.
const require = createRequire(import.meta.url);
const {
  DEFAULT_SETTINGS,
  normalizeSettings,
  resolveEffective,
} = require('../shared/settings.js');
const { createSettingsStore } = require('../main/settingsStore.js');
const { createCredentialStore } = require('../main/credentialStore.js');

// Deterministic, dependency-injected fake safeStorage (XOR — reversible, so any
// UTF-8 secret round-trips, and any instance decrypts what another wrote). No
// real OS keychain is touched.
function xorBuf(buf) {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ 0x5a;
  return out;
}
function fakeSafe({ available = true, decryptThrows = false } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => xorBuf(Buffer.from(String(s), 'utf8')),
    decryptString: (encBuf) => {
      if (decryptThrows) throw new Error('foreign OS account');
      return xorBuf(Buffer.from(encBuf)).toString('utf8');
    },
  };
}
const availStore = (opts) => createCredentialStore({ safeStorage: fakeSafe(opts) });

describe('normalizeSettings — garbage-safe, field-by-field', () => {
  it('null/garbage input returns full defaults (radio sounds off, W3 off, solo)', () => {
    for (const raw of [null, undefined, 42, 'x', []]) {
      const s = normalizeSettings(raw);
      expect(s).toEqual(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
      expect(s.soundEnabled).toBe(false);
      expect(s.w3DiagnosticEnabled).toBe(false);
      expect(s.fpvMode).toBe('solo');
    }
  });

  it('one corrupt field falls back alone — the rest survive', () => {
    const s = normalizeSettings({
      fpvMode: 'warp-drive', // invalid enum
      iphoneAddr: '192.168.4.2',
      controller: { id: 'DualSense (Vendor: 054c)', preset: 'nope' },
      network: { kind: 'hotspot', hotspot: { ssid: '', password: 'secret' } },
      iphonePort: 99999999, // out of range
    });
    expect(s.fpvMode).toBe('solo');
    expect(s.iphoneAddr).toBe('192.168.4.2');
    expect(s.controller.id).toBe('DualSense (Vendor: 054c)');
    expect(s.controller.preset).toBe('dualshock');
    expect(s.network.kind).toBe('hotspot');
    expect(s.network.hotspot.ssid).toBe('W17-GRID'); // empty SSID -> themed default
    expect(s.network.hotspot.password).toBe('secret');
    expect(s.iphonePort).toBe(5601);
  });

  it('unknown keys are dropped', () => {
    expect(normalizeSettings({ evilExtra: true })).not.toHaveProperty('evilExtra');
  });

  it('start lights default OFF; only a boolean true enables them', () => {
    expect(normalizeSettings(null).startLightsEnabled).toBe(false);
    expect(normalizeSettings({ startLightsEnabled: true }).startLightsEnabled).toBe(true);
    expect(normalizeSettings({ startLightsEnabled: 'yes' }).startLightsEnabled).toBe(false);
  });

  it('drivingMode defaults to normal; a known mode persists, anything else coerces back', () => {
    expect(normalizeSettings(null).drivingMode).toBe('normal');
    expect(normalizeSettings({ drivingMode: 'sim' }).drivingMode).toBe('sim');
    expect(normalizeSettings({ drivingMode: 'full-sim' }).drivingMode).toBe('full-sim');
    expect(normalizeSettings({ drivingMode: 'turbo' }).drivingMode).toBe('normal');
    expect(normalizeSettings({ drivingMode: 42 }).drivingMode).toBe('normal');
  });

  it('network.adapter is a plain string, defaulting to "" (system default)', () => {
    expect(normalizeSettings(null).network.adapter).toBe('');
    expect(normalizeSettings({ network: { adapter: 'Wi-Fi 2' } }).network.adapter).toBe('Wi-Fi 2');
    expect(normalizeSettings({ network: { adapter: 42 } }).network.adapter).toBe('');
  });
});

describe('resolveEffective — env always beats settings, unset falls through', () => {
  const iphoneSettings = {
    fpvMode: 'iphone-hud',
    iphoneAddr: '192.168.4.2',
    iphonePort: 5601,
    telemetry: { source: 'replay', port: '' },
    w3DiagnosticEnabled: true,
  };

  it('no env + defaults: nothing enabled (bit-identical to the pre-settings app)', () => {
    const e = resolveEffective(null, {});
    expect(e.telemetry).toEqual({ source: 'none', port: '' });
    expect(e.iphoneBridge).toBeNull();
    expect(e.w3Wish).toEqual({ fromEnv: false, enabled: false });
    expect(e.envOverridden).toEqual({
      telemetrySource: false, telemetryPort: false, iphoneBridge: false, w3: false,
    });
  });

  it('settings alone can enable everything (iphone-hud mode)', () => {
    const e = resolveEffective(iphoneSettings, {});
    expect(e.telemetry.source).toBe('replay');
    expect(e.iphoneBridge).toEqual({ addr: '192.168.4.2', port: 5601, rateHz: 10 });
    expect(e.w3Wish).toEqual({ fromEnv: false, enabled: true });
  });

  it('iphone-hud without an address keeps the bridge off (no half-config)', () => {
    const e = resolveEffective({ ...iphoneSettings, iphoneAddr: '' }, {});
    expect(e.iphoneBridge).toBeNull();
  });

  it('solo mode never enables the bridge even with an address saved', () => {
    const e = resolveEffective({ ...iphoneSettings, fpvMode: 'solo' }, {});
    expect(e.iphoneBridge).toBeNull();
  });

  it('W17_IPHONE_BRIDGE set to 0 force-disables a settings-enabled bridge', () => {
    const e = resolveEffective(iphoneSettings, { W17_IPHONE_BRIDGE: '0' });
    expect(e.iphoneBridge).toBeNull();
    expect(e.envOverridden.iphoneBridge).toBe(true);
  });

  it('env bridge config wins wholesale over settings', () => {
    const e = resolveEffective(iphoneSettings, {
      W17_IPHONE_BRIDGE: '1', W17_IPHONE_ADDR: '10.0.0.9', W17_IPHONE_PORT: '50000',
    });
    expect(e.iphoneBridge).toEqual({ addr: '10.0.0.9', port: 50000, rateHz: 10 });
  });

  it('sub-key env vars override a settings-enabled bridge (port/rate)', () => {
    const e = resolveEffective(iphoneSettings, { W17_IPHONE_RATE_HZ: '20' });
    expect(e.iphoneBridge).toEqual({ addr: '192.168.4.2', port: 5601, rateHz: 20 });
  });

  it('telemetry source/port: env set wins, unset falls through', () => {
    const env = { W17_TELEMETRY_SOURCE: 'crsf-serial', W17_TELEMETRY_PORT: 'COM7' };
    expect(resolveEffective(iphoneSettings, env).telemetry)
      .toEqual({ source: 'crsf-serial', port: 'COM7' });
    expect(resolveEffective(iphoneSettings, {}).telemetry.source).toBe('replay');
    expect(resolveEffective(iphoneSettings, env).envOverridden.telemetrySource).toBe(true);
  });

  it('W17_HEADTRACK presence flags env override of the W3 wish (even =0)', () => {
    expect(resolveEffective(iphoneSettings, { W17_HEADTRACK: '0' }).envOverridden.w3).toBe(true);
    expect(resolveEffective(iphoneSettings, { W17_HEADTRACK: '0' }).w3Wish.fromEnv).toBe(true);
    expect(resolveEffective(iphoneSettings, {}).w3Wish).toEqual({ fromEnv: false, enabled: true });
  });

  it('half-configured env bridge warns (delegates to the existing resolver)', () => {
    const warn = vi.fn();
    resolveEffective(null, { W17_IPHONE_BRIDGE: '1' }, warn);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('settingsStore — atomic, corruption-proof persistence', () => {
  const freshDir = () => mkdtempSync(join(tmpdir(), 'w17-settings-'));

  it('load() on a missing file returns defaults without creating anything', () => {
    const dir = freshDir();
    const store = createSettingsStore({ dir });
    expect(store.load()).toEqual(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
    expect(existsSync(store.file)).toBe(false);
  });

  it('save() round-trips through normalize and load() reads it back', () => {
    const store = createSettingsStore({ dir: freshDir() });
    const saved = store.save({ fpvMode: 'iphone-hud', iphoneAddr: '192.168.4.2' });
    expect(saved.fpvMode).toBe('iphone-hud');
    expect(store.load().iphoneAddr).toBe('192.168.4.2');
  });

  it('save() patches nested objects one level deep without clobbering siblings', () => {
    const store = createSettingsStore({ dir: freshDir() });
    store.save({ network: { kind: 'hotspot', hotspot: { password: 'pw123' } } });
    store.save({ network: { ssid: 'PaddockNet' } });
    const s = store.load();
    expect(s.network.kind).toBe('hotspot');
    expect(s.network.ssid).toBe('PaddockNet');
    expect(s.network.hotspot).toEqual({ ssid: 'W17-GRID', password: 'pw123' });
  });

  it('corrupt JSON on disk degrades to defaults and logs, never throws', () => {
    const dir = freshDir();
    const log = vi.fn();
    const store = createSettingsStore({ dir, log });
    writeFileSync(store.file, '{ not json', 'utf8');
    expect(store.load()).toEqual(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
    expect(log).toHaveBeenCalledOnce();
  });

  it('every rewrite keeps the previous file as .bak', () => {
    const store = createSettingsStore({ dir: freshDir() });
    store.save({ fpvMode: 'iphone-hud' });
    store.save({ fpvMode: 'solo' });
    const bak = JSON.parse(readFileSync(`${store.file}.bak`, 'utf8'));
    expect(bak.fpvMode).toBe('iphone-hud');
    expect(store.load().fpvMode).toBe('solo');
  });
});

// --- review correctness-2 (gift-blocking) ------------------------------------
// readRaw() used to flatten "unreadable" into "absent", so a corrupt file
// silently became defaults — and the next save's backupCurrent() then copied
// the corrupt bytes over the settings.json.bak that nothing ever read. One bad
// write took the gift configuration AND the RACE DAY button (it lives in the
// returning-user card, which only renders when setupCompleted survives).

describe('settingsStore — corruption recovery (review correctness-2)', () => {
  const freshDir = () => mkdtempSync(join(tmpdir(), 'w17-corrupt-'));
  const corrupt = (store) => writeFileSync(store.file, '{ "fpvMode": "iphone-h', 'utf8');
  const bakOf = (store) => `${store.file}.bak`;
  const quarantined = (dir) => readdirSync(dir).filter((f) => f.includes('.corrupt-'));

  // A store with one save of history: settings.json holds CONFIGURED, .bak
  // holds the state before it — the shape a returning user actually has.
  function configured(dir, log = () => {}) {
    const store = createSettingsStore({ dir, log });
    store.save({ fpvMode: 'iphone-hud', iphoneAddr: '192.168.4.2', setupCompleted: true });
    store.save({ elrsPath: 'C:/elrs/elrs-joystick-control.exe' });
    return store;
  }

  it('an ABSENT file is still just defaults — the tri-state must not cry wolf', () => {
    const dir = freshDir();
    const store = createSettingsStore({ dir });
    expect(store.load()).toEqual(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
    expect(store.recoveryStatus()).toMatchObject({ state: 'ok', quarantinedAs: null });
    expect(quarantined(dir)).toEqual([]);
    expect(existsSync(store.file)).toBe(false);
  });

  it('an UNREADABLE file is restored from .bak — the prior configuration survives', () => {
    const dir = freshDir();
    const store = configured(dir);
    corrupt(store);

    const loaded = store.load();
    expect(loaded.fpvMode).toBe('iphone-hud');      // NOT the default 'solo'
    expect(loaded.iphoneAddr).toBe('192.168.4.2');
    expect(loaded.setupCompleted).toBe(true);        // the RACE DAY card still renders

    expect(store.recoveryStatus()).toMatchObject({
      state: 'restored-from-backup',
      restoredFrom: 'settings.json.bak',
    });
    expect(store.recoveryStatus().quarantinedAs).toMatch(/^settings\.json\.corrupt-/);
  });

  it('the corrupt file is QUARANTINED, not deleted, and settings.json is healthy again', () => {
    const dir = freshDir();
    const store = configured(dir);
    corrupt(store);
    store.load();

    expect(quarantined(dir)).toHaveLength(1);
    // The bad bytes are kept for a bench session, not thrown away.
    expect(readFileSync(join(dir, quarantined(dir)[0]), 'utf8')).toContain('iphone-h');
    // …and the recovery is DURABLE: a second load (settings:get runs load() on
    // every call) must not fall back to defaults because the file went missing.
    expect(JSON.parse(readFileSync(store.file, 'utf8')).fpvMode).toBe('iphone-hud');
    expect(store.load().fpvMode).toBe('iphone-hud');
  });

  it('corrupt-then-save restores from .bak and NEVER overwrites a good .bak', () => {
    const dir = freshDir();
    const store = configured(dir);
    const goodBak = readFileSync(bakOf(store), 'utf8');
    expect(JSON.parse(goodBak).fpvMode).toBe('iphone-hud');

    corrupt(store);
    const saved = store.save({ soundEnabled: true });

    // The save merged onto the RESTORED configuration, not onto defaults.
    expect(saved.fpvMode).toBe('iphone-hud');
    expect(saved.setupCompleted).toBe(true);
    expect(saved.soundEnabled).toBe(true);
    // The backup is still parseable and still the prior good configuration —
    // the exact byte-for-byte destruction the finding described.
    const bakNow = readFileSync(bakOf(store), 'utf8');
    expect(() => JSON.parse(bakNow)).not.toThrow();
    expect(JSON.parse(bakNow).fpvMode).toBe('iphone-hud');
    expect(bakNow).not.toContain('iphone-h"'); // no truncated garbage rode in
  });

  it('even with the quarantine rename BLOCKED, a good .bak survives the next save', () => {
    // Second belt: backupCurrent() refuses to copy unparseable content. This is
    // what covers a locked/permission-denied rename on Windows.
    const dir = freshDir();
    const store = configured(dir);
    const goodBak = readFileSync(bakOf(store), 'utf8');
    corrupt(store);

    const blocked = createSettingsStore({
      dir,
      fs: { ...fsReal, renameSync: (from, to) => {
        if (String(to).includes('.corrupt-')) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
        return fsReal.renameSync(from, to);
      } },
    });
    blocked.load();
    expect(blocked.recoveryStatus()).toMatchObject({ state: 'restored-from-backup', quarantinedAs: null });
    blocked.save({ soundEnabled: true });
    expect(readFileSync(bakOf(store), 'utf8')).toBe(goodBak);
  });

  it('an unusable .bak degrades to defaults, still quarantines, and says so', () => {
    const dir = freshDir();
    const log = vi.fn();
    const store = createSettingsStore({ dir, log });
    store.save({ fpvMode: 'iphone-hud', setupCompleted: true });
    writeFileSync(bakOf(store), 'also not json', 'utf8');
    corrupt(store);

    expect(store.load()).toEqual(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
    expect(store.recoveryStatus()).toMatchObject({ state: 'reset-to-defaults', restoredFrom: null });
    expect(quarantined(dir)).toHaveLength(1);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toMatch(/no usable backup/);
  });

  it('the recovery status is STICKY for the run and never carries settings content', () => {
    const dir = freshDir();
    const store = configured(dir);
    corrupt(store);
    store.load();
    store.load(); // a healthy read now — the evidence must not be erased
    const st = store.recoveryStatus();
    expect(st.state).toBe('restored-from-backup');
    expect(typeof st.at).toBe('string');
    // File NAMES only: no directory path, no settings values, no credential.
    expect(Object.keys(st).sort()).toEqual(['at', 'quarantinedAs', 'restoredFrom', 'state']);
    expect(JSON.stringify(st)).not.toContain('192.168.4.2');
    expect(JSON.stringify(st)).not.toContain(dir);
  });

  it('recoveryStatus() is a copy — a caller cannot mutate the store\u2019s state', () => {
    const store = createSettingsStore({ dir: freshDir() });
    const st = store.recoveryStatus();
    st.state = 'tampered';
    expect(store.recoveryStatus().state).toBe('ok');
  });
});

// review adffe40ca3aaab56c.md item 2: readRaw() used to accept ANY parseable
// JSON — including a non-object — as 'ok'. settings.json = `null` / `0` / `[]`
// / `"corrupted"` all parse cleanly, so the tri-state guard above never fired:
// load() silently returned defaults with recoveryStatus() still 'ok' (no
// GARAGE line, no log), and the next save's backupCurrent() (its own
// `JSON.parse(cur)` "second belt") copied those bytes straight over a good
// .bak. This is the contrived tail the finding names — realistic corruption
// (truncation, NUL-fill) never parses at all and was already covered above.
describe('settingsStore — valid-JSON-non-object is still corruption (review correctness-2 tail)', () => {
  const freshDir = () => mkdtempSync(join(tmpdir(), 'w17-nonobj-'));
  const bakOf = (store) => `${store.file}.bak`;
  const quarantined = (dir) => readdirSync(dir).filter((f) => f.includes('.corrupt-'));

  function configured(dir) {
    const store = createSettingsStore({ dir });
    store.save({ fpvMode: 'iphone-hud', iphoneAddr: '192.168.4.2', setupCompleted: true });
    store.save({ elrsPath: 'C:/elrs/elrs-joystick-control.exe' }); // second save creates .bak
    return store;
  }

  it.each([
    ['null', 'null'],
    ['the number 0', '0'],
    ['an empty array', '[]'],
    ['a bare string', '"corrupted"'],
  ])('%s on disk is recovered from .bak, not silently defaulted', (_label, json) => {
    const dir = freshDir();
    const store = configured(dir);
    const goodBak = readFileSync(bakOf(store), 'utf8');
    writeFileSync(store.file, json, 'utf8');

    const loaded = store.load();
    // Recovered from .bak, never a silent reset to defaults.
    expect(loaded.fpvMode).toBe('iphone-hud');
    expect(loaded.setupCompleted).toBe(true);
    expect(store.recoveryStatus()).toMatchObject({ state: 'restored-from-backup' });
    expect(store.recoveryStatus().quarantinedAs).toMatch(/^settings\.json\.corrupt-/);
    expect(quarantined(dir)).toHaveLength(1);
    // The offending bytes are preserved for a bench session, not discarded.
    expect(readFileSync(join(dir, quarantined(dir)[0]), 'utf8')).toBe(json);
    // The GOOD .bak is untouched by this load (only a save rewrites .bak).
    expect(readFileSync(bakOf(store), 'utf8')).toBe(goodBak);
  });

  it('a non-object save-then-corrupt never overwrites a good .bak (the destruction path, closed)', () => {
    const dir = freshDir();
    const store = configured(dir);
    const goodBak = readFileSync(bakOf(store), 'utf8');
    expect(JSON.parse(goodBak).fpvMode).toBe('iphone-hud');

    writeFileSync(store.file, '[]', 'utf8');
    const saved = store.save({ soundEnabled: true });

    // save() merges onto the RESTORED configuration, not onto defaults.
    expect(saved.fpvMode).toBe('iphone-hud');
    expect(saved.setupCompleted).toBe(true);
    expect(saved.soundEnabled).toBe(true);
    // backupCurrent()'s second belt: the array never rode into .bak.
    const bakNow = readFileSync(bakOf(store), 'utf8');
    expect(JSON.parse(bakNow).fpvMode).toBe('iphone-hud');
  });

  it('a non-object .bak is not "usable" either — degrades to defaults, still quarantines', () => {
    const dir = freshDir();
    const log = vi.fn();
    const store = createSettingsStore({ dir, log });
    store.save({ fpvMode: 'iphone-hud', setupCompleted: true });
    writeFileSync(bakOf(store), 'null', 'utf8');
    writeFileSync(store.file, '"corrupted"', 'utf8');

    expect(store.load()).toEqual(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
    expect(store.recoveryStatus()).toMatchObject({ state: 'reset-to-defaults', restoredFrom: null });
    expect(quarantined(dir)).toHaveLength(1);
    expect(log.mock.calls[0][0]).toMatch(/no usable backup/);
  });
});

describe('settingsStore — hotspot credential encryption (audit E1 / Q6)', () => {
  const freshDir = () => mkdtempSync(join(tmpdir(), 'w17-cred-'));
  const HS = { network: { kind: 'hotspot', hotspot: { password: 'grid p@ss & <ok> ünï' } } };

  it('encrypts on save: no plaintext on disk, versioned ciphertext, plaintext blanked', () => {
    const dir = freshDir();
    const store = createSettingsStore({ dir, credentialStore: availStore() });
    store.save(HS);
    const raw = readFileSync(store.file, 'utf8');
    expect(raw).not.toContain('grid p@ss'); // no plaintext on disk
    expect(raw).toContain('w17cred:v1:');   // versioned ciphertext token
    const onDisk = JSON.parse(raw);
    expect(onDisk.network.hotspot.password).toBe(''); // plaintext field blanked
    expect(typeof onDisk.network.hotspot.passwordEnc).toBe('string');
    expect(store.credentialStatus()).toEqual({ state: 'persisted', encryptionAvailable: true, hasPassword: true });
  });

  it('decrypts on load — including a fresh store instance (restart) over the same dir', () => {
    const dir = freshDir();
    createSettingsStore({ dir, credentialStore: availStore() }).save({ network: { hotspot: { password: 'sekret9x' } } });
    // A new store instance = an app restart; the OS-backed key still decrypts.
    const restarted = createSettingsStore({ dir, credentialStore: availStore() });
    expect(restarted.load().network.hotspot.password).toBe('sekret9x');
    expect(restarted.credentialStatus().state).toBe('persisted');
    // The logical (in-memory/IPC) object never carries the ciphertext.
    expect(restarted.load().network.hotspot).not.toHaveProperty('passwordEnc');
  });

  it('the .bak never carries plaintext either', () => {
    const dir = freshDir();
    const store = createSettingsStore({ dir, credentialStore: availStore() });
    store.save({ network: { hotspot: { password: 'baksecret1' } } });
    store.save({ soundEnabled: true }); // an unrelated save rewrites .bak
    const bak = readFileSync(`${store.file}.bak`, 'utf8');
    expect(bak).not.toContain('baksecret1');
  });

  it('clearing the credential removes the ciphertext entirely', () => {
    const dir = freshDir();
    const store = createSettingsStore({ dir, credentialStore: availStore() });
    store.save({ network: { hotspot: { password: 'x1y2z3w4' } } });
    store.save({ network: { hotspot: { password: '' } } });
    const onDisk = JSON.parse(readFileSync(store.file, 'utf8'));
    expect(onDisk.network.hotspot.passwordEnc).toBeUndefined();
    expect(onDisk.network.hotspot.password).toBe('');
    expect(store.credentialStatus()).toMatchObject({ state: 'none', hasPassword: false });
    expect(store.load().network.hotspot.password).toBe('');
  });

  it('replacing the credential rewrites the ciphertext (old value gone)', () => {
    const dir = freshDir();
    const store = createSettingsStore({ dir, credentialStore: availStore() });
    store.save({ network: { hotspot: { password: 'firstpw12' } } });
    const enc1 = JSON.parse(readFileSync(store.file, 'utf8')).network.hotspot.passwordEnc;
    store.save({ network: { hotspot: { password: 'secondpw34' } } });
    const raw2 = readFileSync(store.file, 'utf8');
    expect(raw2).not.toContain('firstpw12');
    expect(JSON.parse(raw2).network.hotspot.passwordEnc).not.toBe(enc1);
    expect(store.load().network.hotspot.password).toBe('secondpw34');
  });

  it('migrates legacy plaintext to ciphertext on first load, value preserved, plaintext gone', () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({
      fpvMode: 'iphone-hud', network: { kind: 'hotspot', hotspot: { ssid: 'W17-GRID', password: 'legacyPW1' } },
    }), 'utf8');
    const store = createSettingsStore({ dir, credentialStore: availStore() });
    expect(store.load().network.hotspot.password).toBe('legacyPW1'); // effective value preserved
    const raw = readFileSync(store.file, 'utf8');
    expect(raw).not.toContain('legacyPW1'); // plaintext removed from disk
    expect(raw).toContain('w17cred:v1:');
    expect(store.credentialStatus().state).toBe('persisted');
  });

  it('migration write failure keeps the value in memory, reports a controlled status, never logs the secret', () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({
      network: { kind: 'hotspot', hotspot: { password: 'legacyPW2' } },
    }), 'utf8');
    const realFs = require('node:fs');
    const failingFs = { ...realFs, writeFileSync: () => { const e = new Error('disk full'); e.code = 'ENOSPC'; throw e; } };
    const log = vi.fn();
    const store = createSettingsStore({ dir, credentialStore: availStore(), fs: failingFs, log });
    const loaded = store.load(); // must NOT throw
    expect(loaded.network.hotspot.password).toBe('legacyPW2'); // recoverable value not destroyed
    expect(store.credentialStatus().state).toBe('migration-failed');
    expect(log).toHaveBeenCalled();
    for (const call of log.mock.calls) expect(String(call[0])).not.toContain('legacyPW2');
  });

  it('safeStorage unavailable → session-only: never persisted, no plaintext, lost on restart', () => {
    const dir = freshDir();
    const store = createSettingsStore({ dir, credentialStore: availStore({ available: false }) });
    store.save({ network: { hotspot: { password: 'sess3cret' } } });
    const raw = readFileSync(store.file, 'utf8');
    expect(raw).not.toContain('sess3cret'); // never plaintext
    expect(raw).not.toContain('w17cred:'); // can't encrypt → no token written
    expect(JSON.parse(raw).network.hotspot.passwordEnc).toBeUndefined();
    expect(store.credentialStatus()).toMatchObject({ state: 'session-only', encryptionAvailable: false, hasPassword: true });
    expect(store.load().network.hotspot.password).toBe('sess3cret'); // held for the session
    // A restart (fresh instance) cannot recover a value that was never persisted.
    const restart = createSettingsStore({ dir, credentialStore: availStore({ available: false }) });
    expect(restart.load().network.hotspot.password).toBe('');
    expect(restart.credentialStatus().state).toBe('unavailable');
  });

  it('safeStorage becoming available on a later launch persists a re-entered credential', () => {
    const dir = freshDir();
    createSettingsStore({ dir, credentialStore: availStore({ available: false }) })
      .save({ network: { hotspot: { password: 'willpersist9' } } });
    // Next launch, encryption now available: the session-only value did not persist.
    const second = createSettingsStore({ dir, credentialStore: availStore() });
    expect(second.load().network.hotspot.password).toBe('');
    expect(second.credentialStatus().state).toBe('none');
    // The user re-enters it; now it is encrypted at rest and survives a restart.
    second.save({ network: { hotspot: { password: 'willpersist9' } } });
    expect(readFileSync(second.file, 'utf8')).toContain('w17cred:v1:');
    const third = createSettingsStore({ dir, credentialStore: availStore() });
    expect(third.load().network.hotspot.password).toBe('willpersist9');
  });

  it('undecryptable ciphertext: no crash, no ciphertext shown, unrelated settings intact, record kept', () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({
      fpvMode: 'iphone-hud', iphoneAddr: '192.168.4.2',
      network: { kind: 'hotspot', hotspot: { ssid: 'W17-GRID', password: '', passwordEnc: 'w17cred:v1:AAAABBBBCCCC' } },
    }), 'utf8');
    const store = createSettingsStore({ dir, credentialStore: availStore({ decryptThrows: true }) });
    const loaded = store.load(); // must not throw
    expect(loaded.network.hotspot.password).toBe(''); // never the ciphertext as a password
    expect(store.credentialStatus().state).toBe('undecryptable');
    expect(loaded.fpvMode).toBe('iphone-hud'); // unrelated settings survive
    expect(loaded.iphoneAddr).toBe('192.168.4.2');
    // The broken record is not destroyed at load (read-only); it can be replaced.
    expect(readFileSync(store.file, 'utf8')).toContain('w17cred:v1:AAAABBBBCCCC');
  });

  it('a corrupt (non-token) ciphertext field degrades the same controlled way', () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({
      network: { kind: 'hotspot', hotspot: { password: '', passwordEnc: 'not-a-real-token' } },
    }), 'utf8');
    const store = createSettingsStore({ dir, credentialStore: availStore() });
    expect(store.load().network.hotspot.password).toBe('');
    expect(store.credentialStatus().state).toBe('undecryptable');
  });

  it('replacing a broken record with a freshly entered password secures it', () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({
      network: { kind: 'hotspot', hotspot: { password: '', passwordEnc: 'w17cred:v1:BROKEN' } },
    }), 'utf8');
    // A machine-scoped fake: tokens NOT produced here (the seeded foreign one)
    // throw on decrypt, but a value re-encrypted on THIS machine reads back.
    const MARKER = 'MACHINE-A::';
    const machineSafe = {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.concat([Buffer.from(MARKER), xorBuf(Buffer.from(String(s), 'utf8'))]),
      decryptString: (encBuf) => {
        const b = Buffer.from(encBuf);
        if (b.slice(0, MARKER.length).toString() !== MARKER) throw new Error('foreign key');
        return xorBuf(b.slice(MARKER.length)).toString('utf8');
      },
    };
    const store = createSettingsStore({ dir, credentialStore: createCredentialStore({ safeStorage: machineSafe }) });
    expect(store.load().network.hotspot.password).toBe(''); // foreign token unreadable
    expect(store.credentialStatus().state).toBe('undecryptable');
    store.save({ network: { hotspot: { password: 'fresh9pw!' } } });
    const raw = readFileSync(store.file, 'utf8');
    expect(raw).not.toContain('w17cred:v1:BROKEN');
    expect(store.load().network.hotspot.password).toBe('fresh9pw!');
    expect(store.credentialStatus().state).toBe('persisted');
  });

  it('an env-provided hotspot credential is never copied into persisted settings', () => {
    // hotspot.js hands the password to the child process via W17_HOTSPOT_PASS,
    // but the store reads ONLY disk + the injected safeStorage — never the env.
    const dir = freshDir();
    const prev = process.env.W17_HOTSPOT_PASS;
    process.env.W17_HOTSPOT_PASS = 'envleak-should-not-persist';
    try {
      const store = createSettingsStore({ dir, credentialStore: availStore() });
      store.save({ soundEnabled: true }); // a save that never sets a password
      expect(readFileSync(store.file, 'utf8')).not.toContain('envleak-should-not-persist');
      expect(store.credentialStatus().hasPassword).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.W17_HOTSPOT_PASS;
      else process.env.W17_HOTSPOT_PASS = prev;
    }
  });
});

// The reviewer's probe (scratchpad/rev_gsB_probe4.js), at the seam it belongs
// to: race day's one automatic write must not be able to destroy the stored
// hotspot credential even if every caller-side guard were wrong. save() COULD:
// its load -> normalizeSettings -> serialize round trip drops passwordEnc and
// re-writes it only from a plaintext it managed to decrypt.
describe('settingsStore.patchTelemetrySource — the one narrow write (OD-19)', () => {
  const freshDir = () => mkdtempSync(join(tmpdir(), 'w17-patch-'));
  // A NON-deterministic seal, so a re-encryption round trip is visible as a
  // changed token rather than hiding behind a stable fake.
  let seals = 0;
  const sealSafe = ({ decryptable = true } = {}) => ({
    isEncryptionAvailable: () => true,
    encryptString: (s) => { seals += 1; return Buffer.from(`seal${seals}:${String(s)}`, 'utf8'); },
    decryptString: (b) => {
      if (!decryptable) throw new Error('written by another machine');
      const t = Buffer.from(b).toString('utf8');
      return t.slice(t.indexOf(':') + 1);
    },
  });
  const seed = (raw) => {
    const dir = freshDir();
    writeFileSync(join(dir, 'settings.json'), `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    return dir;
  };
  const WITH_TOKEN = {
    fpvMode: 'iphone-hud',
    iphoneAddr: '10.0.0.9',
    network: { kind: 'hotspot', hotspot: { ssid: 'W17-CAR', password: '', passwordEnc: 'w17cred:v1:AAAA' } },
    telemetry: { source: 'none', port: 'COM4' },
  };

  it('an UNREADABLE token is copied through verbatim — save() deletes it, this does not', () => {
    const dir = seed(WITH_TOKEN);
    const store = createSettingsStore({
      dir, credentialStore: createCredentialStore({ safeStorage: sealSafe({ decryptable: false }) }),
    });
    store.load();
    expect(store.credentialStatus().state).toBe('undecryptable');

    const res = store.patchTelemetrySource('mapper-grpc');
    expect(res).toEqual({ ok: true, changed: true });
    const after = JSON.parse(readFileSync(store.file, 'utf8'));
    expect(after.network.hotspot.passwordEnc).toBe('w17cred:v1:AAAA'); // the whole point
    expect(after.telemetry.source).toBe('mapper-grpc');
    expect(after.telemetry.port).toBe('COM4');   // sibling keys untouched
    expect(after.fpvMode).toBe('iphone-hud');    // and every unrelated setting
    expect(after.iphoneAddr).toBe('10.0.0.9');

    // The contrast that makes this method exist: the full round trip on the
    // SAME file loses the token.
    store.save({ telemetry: { source: 'none' } });
    expect(JSON.parse(readFileSync(store.file, 'utf8')).network.hotspot.passwordEnc).toBeUndefined();
  });

  it('a READABLE token is not re-encrypted: the ciphertext bytes are the same bytes', () => {
    const dir = seed({
      network: { kind: 'hotspot', hotspot: { ssid: 'W17-CAR', password: '', passwordEnc: 'w17cred:v1:c2VhbDA6cHc=' } },
      telemetry: { source: 'none', port: '' },
    });
    const store = createSettingsStore({
      dir, credentialStore: createCredentialStore({ safeStorage: sealSafe() }),
    });
    const before = JSON.parse(readFileSync(store.file, 'utf8')).network.hotspot.passwordEnc;
    store.patchTelemetrySource('mapper-grpc');
    const after = JSON.parse(readFileSync(store.file, 'utf8'));
    expect(after.network.hotspot.passwordEnc).toBe(before);
    expect(after.telemetry.source).toBe('mapper-grpc');
  });

  it('refuses what it must: an unknown source, no settings file, an unreadable one, and un-secured plaintext', () => {
    const dir = seed(WITH_TOKEN);
    const store = createSettingsStore({ dir, credentialStore: availStore() });
    expect(store.patchTelemetrySource('http-post')).toEqual({ ok: false, kind: 'bad-source' });
    expect(store.patchTelemetrySource('')).toEqual({ ok: false, kind: 'bad-source' });

    // Nothing on disk yet: a fresh install goes through the normal setup save.
    const empty = createSettingsStore({ dir: freshDir() });
    expect(empty.patchTelemetrySource('mapper-grpc')).toEqual({ ok: false, kind: 'no-settings' });

    // Unreadable belongs to the recovery path, not to this method.
    const badDir = freshDir();
    writeFileSync(join(badDir, 'settings.json'), '{not json', 'utf8');
    const bad = createSettingsStore({ dir: badDir });
    expect(bad.patchTelemetrySource('mapper-grpc')).toEqual({ ok: false, kind: 'unreadable' });
    // and it did NOT overwrite the file it refused
    expect(readFileSync(join(badDir, 'settings.json'), 'utf8')).toBe('{not json');

    // A legacy plaintext still on disk: rewriting would re-persist it.
    const legacyDir = seed({
      network: { kind: 'hotspot', hotspot: { ssid: 'W17-CAR', password: 'still-plain' } },
      telemetry: { source: 'none', port: '' },
    });
    const legacy = createSettingsStore({ dir: legacyDir });
    expect(legacy.patchTelemetrySource('mapper-grpc')).toEqual({ ok: false, kind: 'plaintext-credential' });
    expect(JSON.parse(readFileSync(join(legacyDir, 'settings.json'), 'utf8')).telemetry.source).toBe('none');
  });

  it('a no-op patch writes nothing at all', () => {
    const dir = seed({ ...WITH_TOKEN, telemetry: { source: 'mapper-grpc', port: '' } });
    const store = createSettingsStore({ dir, credentialStore: availStore() });
    const before = readFileSync(store.file, 'utf8');
    expect(store.patchTelemetrySource('mapper-grpc')).toEqual({ ok: true, changed: false });
    expect(readFileSync(store.file, 'utf8')).toBe(before);
    expect(existsSync(`${store.file}.bak`)).toBe(false); // no backup churn either
  });

  it('never logs the credential or the ciphertext', () => {
    const dir = seed(WITH_TOKEN);
    const lines = [];
    const store = createSettingsStore({ dir, credentialStore: availStore(), log: (m) => lines.push(m) });
    store.patchTelemetrySource('mapper-grpc');
    for (const line of lines) {
      expect(line).not.toContain('w17cred:v1:AAAA');
      expect(line).not.toContain('passwordEnc');
    }
  });
});
