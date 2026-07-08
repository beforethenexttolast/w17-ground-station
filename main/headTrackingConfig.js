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

module.exports = {
    headTrackingConfigFromEnv,
    DEFAULT_PORT,
    DEFAULT_BIND_HOST,
    DEFAULT_STALE_MS,
};
