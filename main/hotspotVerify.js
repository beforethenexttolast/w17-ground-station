// Local hotspot readiness verification (Windows observation #4: a hotspot
// "started" — command exit 0 / START_OK — but a Pixel stalled at "Obtaining IP
// address" and never joined). A successful start command proves the radio-side
// request was accepted; it proves NOTHING about whether a client can obtain a
// DHCP lease. This module checks everything that CAN be verified locally on
// the Windows host and classifies the result honestly:
//
//   verified — every locally-checkable readiness signal is good. Still not a
//              client-connection proof (only a joining device proves DHCP
//              end-to-end); it is "nothing locally wrong".
//   degraded — the hotspot may be broadcasting, but a readiness signal is bad
//              or could not be established: no ICS gateway address, sharing /
//              tethering service not running, tethering state not On, or the
//              checks themselves failed. Clients are NOT expected to connect.
//
// Locally checkable facts:
//  - WinRT tethering state (mobile backend), via the same fail-closed PS probe
//    hotspot.js already uses (PROBE_STATE_<state> token, locale-neutral);
//  - the ICS/tethering gateway address: both Windows backends land clients on
//    the ICS subnet 192.168.137.0/24 with the host as .1 — if NO local
//    interface holds a 192.168.137.x address, there is no gateway and DHCP
//    (which ICS serves from that same address) cannot answer; this is the
//    classic silent cause of "Obtaining IP address" hangs. The interface
//    carrying that address is recorded as the virtual hotspot interface.
//  - service state for SharedAccess (Internet Connection Sharing — serves
//    DHCP/NAT for both backends) and icssvc (Windows Mobile Hotspot Service),
//    via PowerShell Get-Service printing fixed SVC_<name>_<Status> tokens —
//    .NET ServiceControllerStatus enum names, locale-neutral (audit B2 rule:
//    never classify on localized prose).
//
// SECURITY: no credential is available to or used by anything here; command
// output is sanitized (whitespace-collapsed, capped) before it can reach a
// reason string, and the caller additionally redacts known secrets
// (shared/redact.js) before anything is logged or displayed.

const os = require('node:os');
const { runCommand } = require('./runCommand.js');
const { PS_SCRIPTS } = require('./hotspot.js');

// Single-quote-only (same argv-safety rule as the hotspot.js scripts). Fixed
// tokens; Status is the .NET enum name (Running/Stopped/...), not localized.
const PS_SVC = `$ErrorActionPreference = 'Stop'
foreach ($name in @('SharedAccess','icssvc')) {
    try {
        $s = Get-Service -Name $name
        Write-Output ('SVC_' + $name + '_' + $s.Status)
    } catch {
        Write-Output ('SVC_' + $name + '_QUERYFAILED')
    }
}
Write-Output 'SVC_DONE'
`;

const psArgs = (script) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];

const sanitize = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);

// SVC_<name>_<Status> tokens -> { SharedAccess: 'Running'|'Stopped'|...|null }
function parseServiceTokens(stdout) {
    const out = { SharedAccess: null, icssvc: null };
    for (const name of Object.keys(out)) {
        const m = String(stdout || '').match(new RegExp(`SVC_${name}_(\\w+)`));
        if (m && m[1] !== 'QUERYFAILED') out[name] = m[1];
    }
    return out;
}

// The ICS/tethering gateway: the first non-internal IPv4 on 192.168.137.0/24,
// plus the (virtual) interface that carries it. Locale-independent — an
// address is an address regardless of what Windows names the adapter.
function icsGateway(networkInterfaces = os.networkInterfaces) {
    for (const [name, addrs] of Object.entries(networkInterfaces() || {})) {
        for (const a of addrs || []) {
            if (a.family === 'IPv4' && !a.internal && a.address.startsWith('192.168.137.')) {
                return { hostIp: a.address, iface: name };
            }
        }
    }
    return { hostIp: null, iface: null };
}

// Pure classification over collected facts. `backend` is which backend the
// lifecycle believes is live ('mobile' | 'hosted').
function classifyHotspotReadiness(backend, facts = {}) {
    const reasons = [];
    const gw = facts.gateway || { hostIp: null, iface: null };
    const services = facts.services || { SharedAccess: null, icssvc: null };

    if (backend === 'mobile') {
        if (facts.tetherState == null) {
            reasons.push('tethering state could not be read (probe failed)');
        } else if (facts.tetherState !== 'On') {
            reasons.push(`tethering reports "${facts.tetherState}" while the app believes the hotspot is live`);
        }
        if (services.icssvc != null && services.icssvc !== 'Running') {
            reasons.push(`Mobile Hotspot service (icssvc) is ${services.icssvc}`);
        }
    } else if (services.SharedAccess !== 'Running') {
        // hosted: netsh hostednetwork has NO DHCP of its own — clients only
        // get leases when ICS shares onto the hosted adapter.
        reasons.push(services.SharedAccess == null
            ? 'Internet Connection Sharing service (SharedAccess) state could not be read'
            : `Internet Connection Sharing service (SharedAccess) is ${services.SharedAccess} — hostednetwork has no DHCP without ICS`);
    }

    if (!gw.hostIp) {
        reasons.push('no local IPv4 on the hotspot subnet (192.168.137.x) — no gateway means clients stall at "Obtaining IP address"');
    }
    for (const e of facts.errors || []) {
        reasons.push(`${e.step} check failed (exit ${e.code === null ? 'none' : e.code}): ${e.detail}`);
    }

    return reasons.length === 0
        ? { status: 'verified', reasons: [] }
        : { status: 'degraded', reasons };
}

// IO collector + classifier behind one injectable seam. Returns the readiness
// object the lifecycle stores in its snapshots:
//   { status, reasons, facts: { tetherState, gateway, services } }
// Facts are redacted-by-construction (tokens, addresses, service names — no
// command lines, no credentials).
function createHotspotVerifier({ run = runCommand, platform = process.platform, networkInterfaces = os.networkInterfaces, log = () => {} } = {}) {
    return async function verify({ backend } = {}) {
        if (platform !== 'win32') {
            return {
                status: 'degraded',
                reasons: ['local readiness checks are Windows-only'],
                facts: { tetherState: null, gateway: { hostIp: null, iface: null }, services: { SharedAccess: null, icssvc: null } },
            };
        }
        const errors = [];
        const [probeRes, svcRes] = await Promise.all([
            run('powershell', psArgs(PS_SCRIPTS.probe), { timeoutMs: 20000 }),
            run('powershell', psArgs(PS_SVC), { timeoutMs: 15000 }),
        ]);
        const stateMatch = (probeRes.stdout || '').match(/PROBE_STATE_(\w+)/);
        if (!stateMatch && !probeRes.ok) {
            errors.push({ step: 'tethering-probe', code: probeRes.code ?? null, detail: sanitize(probeRes.stderr || probeRes.stdout) || 'no output' });
        }
        const services = parseServiceTokens(svcRes.stdout);
        if (!(svcRes.stdout || '').includes('SVC_DONE')) {
            errors.push({ step: 'service-query', code: svcRes.code ?? null, detail: sanitize(svcRes.stderr || svcRes.stdout) || 'no output' });
        }
        const facts = {
            tetherState: stateMatch ? stateMatch[1] : null,
            gateway: icsGateway(networkInterfaces),
            services,
            errors,
        };
        const { status, reasons } = classifyHotspotReadiness(backend, facts);
        log(`[hotspot] verify: backend=${backend} tether=${facts.tetherState ?? 'unknown'} gw=${facts.gateway.hostIp ?? 'none'}${facts.gateway.iface ? ` (${facts.gateway.iface})` : ''} SharedAccess=${services.SharedAccess ?? 'unknown'} icssvc=${services.icssvc ?? 'unknown'} -> ${status}${reasons.length ? ` [${reasons.join(' | ')}]` : ''}`);
        return { status, reasons, facts: { tetherState: facts.tetherState, gateway: facts.gateway, services } };
    };
}

module.exports = { createHotspotVerifier, classifyHotspotReadiness, parseServiceTokens, icsGateway, PS_SVC };
