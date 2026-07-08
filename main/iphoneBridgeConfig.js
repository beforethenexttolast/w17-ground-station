// Pure config resolution for the iPhone telemetry bridge
// (docs/windows_bridge_contract.md — iPhone contract, telemetry port 5601;
// port 5602 is reserved for the future log-only head-tracking receiver).
// Separated from main.js so it unit-tests without Electron/dgram.
//
// Returns null (bridge disabled, no socket, app unchanged) UNLESS
// W17_IPHONE_BRIDGE=1 AND W17_IPHONE_ADDR is set. Otherwise returns the resolved
// { addr, port, rateHz }. `warn` is called (once) to explain a half-configured
// bridge (enabled but no address).

const DEFAULT_PORT = 5601;
const DEFAULT_RATE_HZ = 10;

function iphoneBridgeConfigFromEnv(env = {}, warn = () => {}) {
    if (env.W17_IPHONE_BRIDGE !== '1') return null; // disabled by default
    const addr = env.W17_IPHONE_ADDR;
    if (!addr) {
        warn('[iphone] W17_IPHONE_BRIDGE=1 but W17_IPHONE_ADDR unset; bridge disabled');
        return null;
    }
    const port = Number(env.W17_IPHONE_PORT) || DEFAULT_PORT;
    const rateHz = Number(env.W17_IPHONE_RATE_HZ) || DEFAULT_RATE_HZ;
    return { addr, port, rateHz };
}

module.exports = { iphoneBridgeConfigFromEnv, DEFAULT_PORT, DEFAULT_RATE_HZ };
