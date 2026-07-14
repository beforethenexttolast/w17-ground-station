// One-shot reachability probe for the GRID "IPHONE REACHABLE" check and the
// PIT WALL address validation: a single system ping. The address arrives from
// the renderer, so it is validated as a literal IPv4 before any process is
// spawned (argv array; no shell either way).
//
// It stays ICMP on purpose (audit B4). A TCP connect would prove nothing about
// the real path: the iPhone HUD receives W2 telemetry over UDP 5601, gated by
// iOS Local Network permission — there is no defensible TCP port to test, and
// the phone screen remains the meaningful final evidence. Node has no built-in
// ICMP, so this keeps the process ping but classifies its result from STABLE
// STRUCTURAL signals rather than the exit code alone.
//
// The audit's L4 finding: Windows `ping` returns exit 0 even when a router
// replies "Destination host unreachable" (an ICMP error, not an echo). Exit
// code is therefore NOT sufficient. classifyPing keys on:
//   - `TTL=<n>` in the output — a genuine echo reply. This latin token survives
//     localization (localized ping lines keep "TTL="), and it is the ONLY
//     signal that yields a green "reachable". A false red beats a false green.
//   - exit 0 with NO TTL on Windows — a reply came back but it was not an echo
//     (the router "unreachable" case) -> unreachable, never reachable.
// Everything else is a red outcome, sub-classified best-effort for the message;
// where localization prevents certainty it stays a conservative 'unknown'.

const { runCommand } = require('./runCommand.js');

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function pingArgs(platform, addr) {
    if (platform === 'win32') return ['-n', '1', '-w', '1000', addr];
    if (platform === 'darwin') return ['-c', '1', '-W', '1000', addr];
    return ['-c', '1', '-W', '1', addr]; // linux: -W is seconds
}

// A genuine echo reply carries a TTL; the token stays "TTL=" across locales.
const TTL_RE = /\bttl\s*=\s*\d+/i;
// Best-effort unreachable phrases (EN + a few localized). Corroborates the
// primary structural signal (exit 0 without TTL); never the sole basis.
const UNREACHABLE_RE = /unreachable|nicht erreichbar|inaccessible|inalcanzable|irraggiungibile|no route/i;
// Best-effort timeout phrases + a 100%-loss marker (the "%" and digits are
// stable even when the surrounding word is localized).
const TIMEOUT_RE = /timed out|timeout|time.?out|zeitüberschreitung|délai|tiempo de espera|100%/i;

// Classify a runCommand ping result into a stable status (audit B4). Pure:
// takes the { ok, code, stdout, stderr } shape + platform, returns
// { status, error? }. `reachable` is the only status that means "ok".
//   reachable | unreachable | timeout | invalid | command-unavailable |
//   command-error | unknown
function classifyPing(res = {}, platform = process.platform) {
    const stdout = String(res.stdout || '');
    const stderr = String(res.stderr || '');
    const out = `${stdout}\n${stderr}`;

    // code === null means the process never produced an exit code: our runCommand
    // wrapper timed it out, or spawn/child errored (ping missing, etc).
    if (res.code === null || res.code === undefined) {
        if (/timeout after \d+ms/i.test(stderr)) {
            return { status: 'command-error', error: 'the reachability check timed out' };
        }
        return { status: 'command-unavailable', error: 'ping is unavailable on this system' };
    }

    // An echo reply (TTL present) is the ONLY green — regardless of exit code.
    if (TTL_RE.test(out)) return { status: 'reachable' };

    // No echo reply. On Windows a "Destination host unreachable" ICMP error
    // still exits 0 (audit L4) — a reply arrived, but not an echo. Treat exit-0
    // without TTL as unreachable, and corroborate with a phrase where present.
    const win32ReplyNoEcho = platform === 'win32' && res.code === 0;
    if (win32ReplyNoEcho || UNREACHABLE_RE.test(out)) {
        return { status: 'unreachable', error: 'destination unreachable — no route to the phone' };
    }
    // A request that got no reply at all.
    if (TIMEOUT_RE.test(out)) {
        return { status: 'timeout', error: 'no reply — the phone did not answer (timed out)' };
    }
    // Ran, failed, but nothing structural to place it on — stay conservative.
    return { status: 'unknown', error: 'no reply — reachability could not be confirmed' };
}

class HostProbe {
    constructor({ run = runCommand, platform = process.platform } = {}) {
        this._run = run;
        this._platform = platform;
    }

    async probe(addr) {
        if (typeof addr !== 'string' || !IPV4_RE.test(addr)) {
            return { ok: false, status: 'invalid', error: 'not a valid IPv4 address' };
        }
        const started = Date.now();
        const res = await this._run('ping', pingArgs(this._platform, addr), { timeoutMs: 4000 });
        const c = classifyPing(res, this._platform);
        return c.status === 'reachable'
            ? { ok: true, status: 'reachable', rttMs: Date.now() - started }
            : { ok: false, status: c.status, error: c.error };
    }
}

module.exports = { HostProbe, IPV4_RE, classifyPing };
