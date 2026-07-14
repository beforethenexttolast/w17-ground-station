// Pure config resolution for the LOG-ONLY head-tracking receiver
// (docs/windows_bridge_contract.md section 3; default UDP port 5602).
// Separated from main.js so it unit-tests without Electron/dgram.
//
// Returns null (receiver disabled: no socket bound, app unchanged) unless
// W17_HEADTRACK=1. Windows owns the configured stale timeout (contract "Stale
// Timeout", ~300 ms receive-time authority); the env override is clamped to
// the packet timeout_ms range 1..5000 to keep it sane.

const DEFAULT_PORT = 5602;
const DEFAULT_BIND_HOST = '0.0.0.0';
const DEFAULT_STALE_MS = 300;

function headTrackingConfigFromEnv(env = {}) {
    if (env.W17_HEADTRACK !== '1') return null; // disabled by default
    const port = Number(env.W17_HEADTRACK_PORT) || DEFAULT_PORT;
    const bindHost = env.W17_HEADTRACK_BIND || DEFAULT_BIND_HOST;
    let staleMs = Number(env.W17_HEADTRACK_STALE_MS) || DEFAULT_STALE_MS;
    staleMs = Math.min(5000, Math.max(1, Math.round(staleMs)));
    return { port, bindHost, staleMs };
}

// The W3 receiver's effective config from the RESOLVED settings+env (audit
// C3/D2): the env master var being SET wins outright (W17_HEADTRACK=0 is a
// force-off even when the persisted toggle is on); otherwise the persisted
// wish decides, still honoring env sub-key overrides (port/bind/stale) by
// feeding them through the same pure resolver with a synthetic master flag.
// Pure — main.js (the one sanctioned W3 wiring point) turns the returned
// config into a receiver; this module never constructs anything.
function w3ConfigFor(effective, env = {}) {
    if (effective.envOverridden.w3) return headTrackingConfigFromEnv(env);
    if (effective.w3Wish.enabled) {
        return headTrackingConfigFromEnv({ ...env, W17_HEADTRACK: '1' });
    }
    return null;
}

module.exports = {
    headTrackingConfigFromEnv,
    w3ConfigFor,
    DEFAULT_PORT,
    DEFAULT_BIND_HOST,
    DEFAULT_STALE_MS,
};
