// Pure config resolution for the SUBSCRIBER-ONLY mapper head-intent diagnostics
// consumer (CB8 slice 3B). Electron subscribes to the mapper's read-only gRPC
// stream (WatchHeadIntentDiagnostics on the existing :10000 service) and only
// RENDERS the mapper's authoritative state. It opens NO UDP socket, binds
// nothing, and sends nothing to the mapper.
//
// Separated from main.js so it unit-tests without Electron/grpc. This module is
// deliberately W3-UNAWARE: it never imports the W3 receiver's modules (that
// would trip the no-control-path head-tracking module-graph guard, and would
// couple two independent concerns). The W3 receiver stays wired only in main.js.
//
// TOPOLOGY (a) — MUTUAL EXCLUSIVITY (owner decision #1, 2026-07-15):
//   UDP 5602 head-intent ingest has exactly ONE owner at a time.
//     * Mapper-owns-5602 mode: the mapper runs `-headtrack-ingest`, binds 5602,
//       and republishes diagnostics over gRPC. Electron runs THIS consumer and
//       its own W3 receiver MUST be OFF (a second bind on 5602 would fail the
//       exclusive bind). Enabled with W17_MAPPER_HEADINTENT=1.
//     * Electron-owns-5602 mode: Electron's W3 receiver binds 5602 (log-only)
//       and this consumer is OFF (default).
//   resolveHeadIntentModes() encodes that switch: when the consumer is enabled,
//   the W3 receiver config is forced to null regardless of the W3 wish/env.

const DEFAULT_GRPC_ADDR = '127.0.0.1:10000';

// Resolve the consumer config from env alone. Returns null (consumer disabled;
// no gRPC client, app unchanged) unless W17_MAPPER_HEADINTENT=1. The address is
// the mapper's existing gRPC endpoint; loopback by default because the mapper
// and the ground station run on the same Windows host in the production topology.
function mapperHeadIntentConfigFromEnv(env = {}) {
    if (env.W17_MAPPER_HEADINTENT !== '1') return null; // disabled by default
    const addr = (typeof env.W17_MAPPER_GRPC_ADDR === 'string' && env.W17_MAPPER_GRPC_ADDR.trim())
        ? env.W17_MAPPER_GRPC_ADDR.trim()
        : DEFAULT_GRPC_ADDR;
    return { addr };
}

// The exclusivity gate. Given the CONSUMER config (from this module) and the W3
// receiver config (computed elsewhere — passed in opaquely so this module never
// imports a W3 module), return which of the two mutually-exclusive modes runs:
//   * consumer enabled  -> { consumer, w3: null }   (mapper owns 5602)
//   * consumer disabled -> { consumer: null, w3 }    (W3 wish decides 5602)
// Pure and side-effect free; main.js turns the result into instances.
function resolveHeadIntentModes({ consumerCfg = null, w3Cfg = null } = {}) {
    if (consumerCfg) return { consumer: consumerCfg, w3: null };
    return { consumer: null, w3: w3Cfg };
}

module.exports = {
    mapperHeadIntentConfigFromEnv,
    resolveHeadIntentModes,
    DEFAULT_GRPC_ADDR,
};
