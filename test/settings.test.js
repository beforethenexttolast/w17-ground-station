import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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
