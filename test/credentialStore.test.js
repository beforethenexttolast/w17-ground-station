import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

// credentialStore is CommonJS (main-process side); load via require from ESM.
const require = createRequire(import.meta.url);
const {
  createCredentialStore,
  nullCredentialStore,
  isProtected,
  TOKEN_PREFIX,
} = require('../main/credentialStore.js');

// A deterministic, dependency-injected fake safeStorage. XOR keeps every byte
// reversible, so arbitrary UTF-8 secrets (spaces, quotes, unicode, path-like
// strings) round-trip — and the ciphertext is NOT the plaintext. No OS keychain
// is ever touched (the E1 requirement: unit tests must not depend on a real
// keystore).
function xor(buf) {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ 0x5a;
  return out;
}
function fakeSafe({ available = true, decryptThrows = false } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => xor(Buffer.from(String(s), 'utf8')),
    decryptString: (encBuf) => {
      if (decryptThrows) throw new Error('foreign OS account');
      return xor(Buffer.from(encBuf)).toString('utf8');
    },
  };
}

// Secrets that exercise the "never a raw byte survives" and "resembles normal
// text / a path / even a token" cases.
const SECRETS = [
  'plain',
  'with spaces here',
  'quote"and\'apostrophe',
  'amp & ersand',
  'angle <br/> brackets',
  'café ünïçøde ☃ 日本語 password',
  '/looks/like/a/path and normal words',
  'C:\\Users\\vitaliy\\W17-GRID',
  `${TOKEN_PREFIX}notReallyEncrypted`, // plaintext that resembles a token
  'a b c & < > " \' 🙂',
];

describe('credentialStore — protect/reveal round trip (audit E1)', () => {
  it('round-trips every tricky secret and the ciphertext never leaks the plaintext', () => {
    const store = createCredentialStore({ safeStorage: fakeSafe() });
    for (const secret of SECRETS) {
      const token = store.protect(secret);
      expect(token.startsWith(TOKEN_PREFIX)).toBe(true); // versioned + distinguishable
      expect(token).not.toBe(secret);
      expect(token).not.toContain(secret); // no plaintext substring in the token
      const r = store.reveal(token);
      expect(r).toEqual({ ok: true, value: secret });
    }
  });

  it('a protected value is distinguishable from legacy plaintext on sight', () => {
    const store = createCredentialStore({ safeStorage: fakeSafe() });
    expect(isProtected(store.protect('secretpw'))).toBe(true);
    expect(isProtected('secretpw')).toBe(false);
    expect(isProtected('')).toBe(false);
    expect(isProtected(undefined)).toBe(false);
  });
});

describe('credentialStore — safe failure (audit E1)', () => {
  it('reveal of a non-token returns a stable non-secret bad-format kind, never a throw', () => {
    const store = createCredentialStore({ safeStorage: fakeSafe() });
    expect(store.reveal('just-a-plain-password')).toEqual({ ok: false, kind: 'bad-format' });
    expect(store.reveal('')).toEqual({ ok: false, kind: 'bad-format' });
  });

  it('reveal of an unknown token version fails as bad-format (no crash on future formats)', () => {
    const store = createCredentialStore({ safeStorage: fakeSafe() });
    const r = store.reveal('w17cred:v9:AAAABBBB');
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('bad-format');
    expect(r).not.toHaveProperty('value');
  });

  it('reveal when the OS backend throws (foreign account/corrupt) → decrypt-failed, never the secret', () => {
    const secret = 'crossmachine-secret & <x>';
    const good = createCredentialStore({ safeStorage: fakeSafe() });
    const token = good.protect(secret);
    const foreign = createCredentialStore({ safeStorage: fakeSafe({ decryptThrows: true }) });
    const r = foreign.reveal(token);
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('decrypt-failed');
    expect(r).not.toHaveProperty('value');
    expect(JSON.stringify(r)).not.toContain(secret);
  });

  it('available() is false when the backend reports unavailable OR throws', () => {
    expect(createCredentialStore({ safeStorage: fakeSafe({ available: false }) }).available()).toBe(false);
    expect(createCredentialStore({ safeStorage: { isEncryptionAvailable() { throw new Error('no backend'); } } }).available()).toBe(false);
    expect(createCredentialStore({}).available()).toBe(false); // no safeStorage at all
  });

  it('protect throws (never returns plaintext) when encryption is unavailable', () => {
    const store = createCredentialStore({ safeStorage: fakeSafe({ available: false }) });
    expect(() => store.protect('secretpw')).toThrow();
  });

  it('reveal reports unavailable (not decrypt-failed) when encryption is down for a real token', () => {
    const token = createCredentialStore({ safeStorage: fakeSafe() }).protect('x9y8z7w6');
    const down = createCredentialStore({ safeStorage: fakeSafe({ available: false }) });
    expect(down.reveal(token)).toEqual({ ok: false, kind: 'unavailable' });
  });

  it('never logs the plaintext or the ciphertext through the injected log', () => {
    const secret = 'super secret & spaced';
    const log = vi.fn();
    const store = createCredentialStore({ safeStorage: fakeSafe({ decryptThrows: true }), log });
    const token = createCredentialStore({ safeStorage: fakeSafe() }).protect(secret);
    store.reveal(token); // decrypt-failed path
    try { store.protect(secret); } catch { /* unavailable is fine here (available) */ }
    for (const call of log.mock.calls) {
      const line = call.map(String).join(' ');
      expect(line).not.toContain(secret);
      expect(line).not.toContain(token);
    }
  });
});

describe('nullCredentialStore — the injection-free default (audit E1)', () => {
  it('is never available, refuses to protect, and reveals as unavailable', () => {
    expect(nullCredentialStore.available()).toBe(false);
    expect(() => nullCredentialStore.protect('x')).toThrow();
    expect(nullCredentialStore.reveal('w17cred:v1:AAAA')).toEqual({ ok: false, kind: 'unavailable' });
  });
});
