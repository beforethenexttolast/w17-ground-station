// Credential-at-rest encryption via Electron safeStorage (audit E1 / decision
// Q6). safeStorage is backed by the OS keystore — Windows DPAPI, macOS
// Keychain, Linux libsecret — so the key is owned by the OS user account, not
// this app: we invent no key and persist no key.
//
// MAIN-PROCESS ONLY. safeStorage does not exist in the sandboxed renderer, and
// this module is deliberately NEVER exposed through preload — the renderer sees
// only decrypted plaintext (for the PIT WALL pre-fill) and a non-secret status,
// never the ciphertext or any safeStorage primitive.
//
// This wrapper does three things and nothing else:
//   available()        - is OS encryption usable right now?
//   protect(plaintext) - plaintext -> a versioned, self-describing token
//   reveal(token)      - token -> plaintext, failing SAFELY (never a throw,
//                        never the secret in the return or a log) when the token
//                        is foreign, corrupt, from another OS account, or the
//                        platform backend is unavailable.
//
// Token format:  w17cred:v1:<base64(ciphertext)>
//   - the `w17cred:` prefix makes an encrypted value unmistakable from a legacy
//     plaintext password on sight (migration + tests key off it);
//   - `v1` is the format version; an unknown version reveals as a controlled
//     failure, never a crash.
//
// NEVER logs the plaintext or the raw ciphertext bytes; diagnostics carry only
// a stable, non-secret `kind`.

const PREFIX = 'w17cred:';
const VERSION = 'v1';
const TOKEN_PREFIX = `${PREFIX}${VERSION}:`;

// True for any value that CLAIMS to be one of our tokens (any version). Used to
// tell an encrypted record apart from legacy plaintext without decrypting.
function isProtected(value) {
    return typeof value === 'string' && value.startsWith(PREFIX);
}

function createCredentialStore({ safeStorage, log = () => {} } = {}) {
    void log; // reserved for future non-secret diagnostics; never logs the value

    function available() {
        try {
            return !!safeStorage && safeStorage.isEncryptionAvailable();
        } catch {
            return false;
        }
    }

    // Encrypt a non-empty plaintext into a versioned token. Callers MUST gate on
    // available() first; a throw here is an unexpected platform fault, surfaced
    // (without the plaintext) so the caller can fall back to session-only.
    function protect(plaintext) {
        if (!available()) throw new Error('credential encryption unavailable');
        const buf = safeStorage.encryptString(String(plaintext));
        return TOKEN_PREFIX + Buffer.from(buf).toString('base64');
    }

    // Decrypt a token. Returns { ok:true, value } or { ok:false, kind } where
    // kind is a stable non-secret diagnostic:
    //   'bad-format'     - not one of our tokens, or an unknown version
    //   'unavailable'    - OS encryption is not usable this session
    //   'decrypt-failed' - foreign account / moved settings / corrupt bytes
    // Never throws; never returns or logs the secret.
    function reveal(token) {
        if (!isProtected(token) || !token.startsWith(TOKEN_PREFIX)) {
            return { ok: false, kind: 'bad-format' };
        }
        if (!available()) return { ok: false, kind: 'unavailable' };
        try {
            const b64 = token.slice(TOKEN_PREFIX.length);
            const value = safeStorage.decryptString(Buffer.from(b64, 'base64'));
            if (typeof value !== 'string') return { ok: false, kind: 'decrypt-failed' };
            return { ok: true, value };
        } catch {
            return { ok: false, kind: 'decrypt-failed' };
        }
    }

    return { available, protect, reveal, isProtected };
}

// The default when no safeStorage is injected (unit tests, or a defensive
// fallback): encryption is NEVER available, so a credential is kept in memory
// for the session only and is NEVER written to disk as plaintext.
const nullCredentialStore = {
    available: () => false,
    protect() { throw new Error('credential encryption unavailable'); },
    reveal: () => ({ ok: false, kind: 'unavailable' }),
    isProtected,
};

module.exports = {
    createCredentialStore,
    nullCredentialStore,
    isProtected,
    PREFIX,
    TOKEN_PREFIX,
};
