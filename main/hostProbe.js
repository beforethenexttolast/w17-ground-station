// One-shot reachability probe for the GRID "IPHONE REACHABLE" check and the
// PIT WALL address validation: a single system ping with a 1 s budget.
// The address arrives from the renderer, so it is validated as a literal
// IPv4 before any process is spawned (argv array; no shell either way).

const { runCommand } = require('./runCommand.js');

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function pingArgs(platform, addr) {
    if (platform === 'win32') return ['-n', '1', '-w', '1000', addr];
    if (platform === 'darwin') return ['-c', '1', '-W', '1000', addr];
    return ['-c', '1', '-W', '1', addr]; // linux: -W is seconds
}

class HostProbe {
    constructor({ run = runCommand, platform = process.platform } = {}) {
        this._run = run;
        this._platform = platform;
    }

    async probe(addr) {
        if (typeof addr !== 'string' || !IPV4_RE.test(addr)) {
            return { ok: false, error: 'not a valid IPv4 address' };
        }
        const started = Date.now();
        const res = await this._run('ping', pingArgs(this._platform, addr), { timeoutMs: 4000 });
        return res.ok
            ? { ok: true, rttMs: Date.now() - started }
            : { ok: false, error: 'no reply' };
    }
}

module.exports = { HostProbe, IPV4_RE };
