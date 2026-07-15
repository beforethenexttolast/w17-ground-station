// Secret redaction for command output that may be surfaced in errors or logs
// (audit 2E: "secrets are sanitized from both summary and details"). The
// managers already never PUT credentials into command lines they echo, but a
// Windows error message is untrusted localized prose — this is the defensive
// backstop that makes "the password can never ride an error string" a tested
// property instead of an assumption. CommonJS, Electron-free (repo style,
// like shared/wifiParse.js).

// Replace every occurrence of every secret (longest first, so overlapping
// secrets cannot leave a recognizable suffix) with a fixed marker. Empty and
// non-string secrets are ignored; secrets shorter than 4 chars are skipped —
// replacing e.g. single letters would shred the text while providing no real
// protection (WPA2 keys are 8+ anyway).
function redactSecrets(text, secrets = []) {
    let out = String(text ?? '');
    const real = [...new Set(secrets.filter((s) => typeof s === 'string' && s.length >= 4))]
        .sort((a, b) => b.length - a.length);
    for (const secret of real) {
        out = out.split(secret).join('[REDACTED]');
    }
    return out;
}

module.exports = { redactSecrets };
