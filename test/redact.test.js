// shared/redact.js — the defensive secret scrubber (audit 2E). Proves "a
// password can never ride a command-error string" is a TESTED property, not an
// assumption: the managers already never put credentials into echoed command
// lines, but a localized Windows error is untrusted prose.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { redactSecrets } = require('../shared/redact.js');

describe('redactSecrets', () => {
    it('replaces every occurrence of a secret with a fixed marker', () => {
        expect(redactSecrets('netsh failed: key="lights0ut" again lights0ut', ['lights0ut']))
            .toBe('netsh failed: key="[REDACTED]" again [REDACTED]');
    });

    it('redacts the longest secret first so an overlapping shorter one cannot leave a recognizable suffix', () => {
        // 'superSecret' contains 'Secret'; longest-first prevents a leftover.
        const out = redactSecrets('value=superSecret', ['Secret', 'superSecret']);
        expect(out).toBe('value=[REDACTED]');
        expect(out).not.toContain('super');
    });

    it('skips secrets shorter than 4 chars (shredding text for no protection) and ignores empties/non-strings', () => {
        expect(redactSecrets('a cat sat', ['a', 'x'])).toBe('a cat sat');
        expect(redactSecrets('keep me', ['', null, undefined, 42])).toBe('keep me');
    });

    it('handles no secrets, and coerces a non-string subject safely', () => {
        expect(redactSecrets('plain text')).toBe('plain text');
        expect(redactSecrets(undefined, ['whatever'])).toBe('');
        expect(redactSecrets(12345, ['2345'])).toBe('1[REDACTED]');
    });

    it('a WPA2-length key is fully removed from a rambling localized error', () => {
        const key = 'GridPass2026';
        const err = `Der Vorgang ist fehlgeschlagen. Schlüssel: ${key} (0x80070005) ${key}`;
        const out = redactSecrets(err, [key]);
        expect(out).not.toContain(key);
        expect(out.match(/\[REDACTED\]/g).length).toBe(2);
    });
});
