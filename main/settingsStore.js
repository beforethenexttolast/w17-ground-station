// Persisted setup-flow settings: a single settings.json under the directory
// main.js gives us (Electron's userData in the app; a temp dir in tests).
// Thin IO in the repo style — all shape/validation logic lives in
// shared/settings.js; this file reads, merges, atomically writes, AND owns the
// at-rest ENCRYPTION of the one persisted secret: the hotspot password
// (audit E1 / decision Q6).
//
// Robustness rules (plan "settings corruption"):
//  - Missing or unparseable file  -> normalized defaults; NEVER blocks launch.
//  - Every save writes tmp + rename (atomic on one filesystem) and keeps the
//    previous file as settings.json.bak, so one bad write can't eat the config.
//
// Credential rules (audit E1 / Q6):
//  - The hotspot password is NEVER written to disk as plaintext. On disk it
//    lives ONLY as `network.hotspot.passwordEnc` — a versioned safeStorage
//    ciphertext token (main/credentialStore.js) — and the plaintext
//    `network.hotspot.password` field is always blanked on disk (incl. .bak).
//  - In memory / over IPC the LOGICAL settings object still carries the
//    decrypted `network.hotspot.password` (the PIT WALL pre-fill needs it);
//    `passwordEnc` never leaves this module.
//  - When OS encryption is unavailable the password is kept in memory for the
//    SESSION only and never persisted — there is no plaintext fallback on disk.
//  - Legacy plaintext is migrated on first load (encrypt when possible, else
//    quarantine off disk). An undecryptable token degrades to "re-enter",
//    never a crash, with every unrelated setting intact.
//  - The credential value and raw ciphertext are NEVER logged.

const fsDefault = require('node:fs');
const path = require('node:path');
const { normalizeSettings } = require('../shared/settings.js');
const { nullCredentialStore } = require('./credentialStore.js');

// Copy of the current file for .bak, but a legacy plaintext password must never
// ride into the backup — blank it first. Once migrated the file is already
// ciphertext, so this is a no-op.
function sanitizeForBackup(text) {
    try {
        const obj = JSON.parse(text);
        if (obj && obj.network && obj.network.hotspot
            && typeof obj.network.hotspot.password === 'string'
            && obj.network.hotspot.password) {
            obj.network.hotspot.password = '';
            return `${JSON.stringify(obj, null, 2)}\n`;
        }
    } catch { /* not JSON we can rewrite — copy as-is (no structured secret) */ }
    return text;
}

function createSettingsStore({ dir, log = () => {}, credentialStore = nullCredentialStore, fs = fsDefault } = {}) {
    if (!dir) throw new Error('settings store requires a directory');
    const file = path.join(dir, 'settings.json');
    const bak = `${file}.bak`;
    const tmp = `${file}.tmp`;

    // The plaintext hotspot password held ONLY in memory for this session when
    // it cannot be persisted (OS encryption unavailable). Never written to disk.
    let sessionPassword = null;
    // Renderer-visible, non-secret credential status from the last load/save.
    let credStatus = { state: 'none', encryptionAvailable: credentialStore.available(), hasPassword: false };

    function readRaw() {
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (err) {
            if (err.code !== 'ENOENT') {
                log(`[settings] unreadable ${file} (${err.message}); using defaults`);
            }
            return null;
        }
    }

    // Decide the effective plaintext + status from what's on disk, the in-memory
    // session value, and whether encryption is available. No IO. Returns
    // { plaintext, state, needsMigration }.
    function resolveCredential(rawHotspot, available) {
        const enc = typeof rawHotspot.passwordEnc === 'string' && rawHotspot.passwordEnc
            ? rawHotspot.passwordEnc : null;
        const legacy = typeof rawHotspot.password === 'string' && rawHotspot.password
            ? rawHotspot.password : null;

        // Any plaintext on disk MUST be removed (encrypted or quarantined).
        const needsMigration = !!legacy;

        if (enc) {
            if (available) {
                const r = credentialStore.reveal(enc);
                if (r.ok) return { plaintext: r.value, state: 'persisted', needsMigration };
                // Token unreadable but a readable legacy plaintext sits beside it:
                // recover from the plaintext and re-secure it.
                if (legacy) return { plaintext: legacy, state: 'persisted', needsMigration: true };
                return { plaintext: '', state: 'undecryptable', needsMigration };
            }
            // An encrypted record we cannot read this session (no safeStorage).
            if (legacy) return { plaintext: legacy, state: 'session-only', needsMigration: true };
            if (sessionPassword) return { plaintext: sessionPassword, state: 'session-only', needsMigration };
            return { plaintext: '', state: 'undecryptable', needsMigration };
        }
        if (legacy) {
            return { plaintext: legacy, state: available ? 'persisted' : 'session-only', needsMigration: true };
        }
        if (sessionPassword) return { plaintext: sessionPassword, state: 'session-only', needsMigration: false };
        return { plaintext: '', state: available ? 'none' : 'unavailable', needsMigration: false };
    }

    // Build the ON-DISK object (plaintext blanked; ciphertext token only when we
    // can and should persist) plus the resulting credential status. Updates the
    // in-memory session value.
    function serialize(logical, available) {
        const plaintext = logical.network.hotspot.password;
        const onDisk = JSON.parse(JSON.stringify(logical));
        onDisk.network.hotspot.password = ''; // never plaintext on disk

        if (plaintext) {
            if (available) {
                try {
                    onDisk.network.hotspot.passwordEnc = credentialStore.protect(plaintext);
                    sessionPassword = null;
                    return { onDisk, status: { state: 'persisted', encryptionAvailable: true, hasPassword: true } };
                } catch {
                    // available() said yes but encrypt threw: keep for the session,
                    // never persist plaintext.
                    sessionPassword = plaintext;
                    return { onDisk, status: { state: 'session-only', encryptionAvailable: available, hasPassword: true } };
                }
            }
            sessionPassword = plaintext;
            return { onDisk, status: { state: 'session-only', encryptionAvailable: false, hasPassword: true } };
        }
        sessionPassword = null;
        return {
            onDisk,
            status: { state: available ? 'none' : 'unavailable', encryptionAvailable: available, hasPassword: false },
        };
    }

    function backupCurrent() {
        let cur;
        try { cur = fs.readFileSync(file, 'utf8'); } catch { return; } // nothing to back up
        fs.writeFileSync(bak, sanitizeForBackup(cur), 'utf8');
    }

    function writeAtomic(onDisk) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(tmp, `${JSON.stringify(onDisk, null, 2)}\n`, 'utf8');
        backupCurrent();
        fs.renameSync(tmp, file);
    }

    // One-time rewrite that removes plaintext from disk. Best-effort: on write
    // failure the value is retained in memory and a controlled 'migration-failed'
    // status is returned — the only recoverable value is never destroyed, and
    // the credential is never logged.
    function migrate(logical, available) {
        try {
            const { onDisk, status } = serialize(logical, available);
            writeAtomic(onDisk);
            log(available
                ? '[settings] migrated hotspot credential to encrypted storage'
                : '[settings] secure storage unavailable — hotspot password kept for this session only');
            return status;
        } catch (err) {
            log(`[settings] could not secure hotspot credential (${(err && err.code) || 'write-failed'}); kept in memory this session`);
            if (logical.network.hotspot.password) sessionPassword = logical.network.hotspot.password;
            return { state: 'migration-failed', encryptionAvailable: available, hasPassword: !!logical.network.hotspot.password };
        }
    }

    function load() {
        const raw = readRaw();
        const rawHotspot = raw && raw.network && typeof raw.network === 'object'
            && raw.network.hotspot && typeof raw.network.hotspot === 'object'
            ? raw.network.hotspot : {};
        const available = credentialStore.available();
        const resolved = resolveCredential(rawHotspot, available);

        // normalizeSettings drops `passwordEnc` and reads the (blanked) on-disk
        // plaintext; overlay the resolved effective plaintext for in-memory use.
        const logical = normalizeSettings(raw);
        logical.network.hotspot.password = resolved.plaintext;

        if (resolved.state === 'session-only' && resolved.plaintext) sessionPassword = resolved.plaintext;

        credStatus = resolved.needsMigration
            ? migrate(logical, available)
            : { state: resolved.state, encryptionAvailable: available, hasPassword: !!resolved.plaintext };
        return logical;
    }

    // Shallow patch at the top level, with one-level merge for the nested
    // objects (network/controller/telemetry) so a UI step can update just its
    // own fields. Everything funnels through normalizeSettings before the
    // credential is (re)secured and the object hits disk.
    function save(patch = {}) {
        const current = load();
        const merged = { ...current, ...patch };
        for (const key of ['network', 'controller', 'telemetry']) {
            if (patch[key] && typeof patch[key] === 'object') {
                merged[key] = { ...current[key], ...patch[key] };
                if (key === 'network' && patch.network.hotspot) {
                    merged.network.hotspot = {
                        ...current.network.hotspot,
                        ...patch.network.hotspot,
                    };
                }
            }
        }
        const normalized = normalizeSettings(merged);
        const available = credentialStore.available();
        const { onDisk, status } = serialize(normalized, available);
        writeAtomic(onDisk);
        credStatus = status;
        return normalized; // logical: decrypted plaintext, no passwordEnc
    }

    // Non-secret credential status for the renderer (audit E1). Never carries
    // the value or ciphertext — only the state enum + whether encryption is
    // available + whether a password is set this session.
    function credentialStatus() {
        return { ...credStatus };
    }

    return { load, save, credentialStatus, file };
}

module.exports = { createSettingsStore };
