// gRPC transport factory for the SUBSCRIBER-ONLY head-intent diagnostics
// consumer (CB8 slice 3B). MAIN-process only. This is the one module that
// touches @grpc/grpc-js; the consumer logic (HeadIntentDiagnosticsClient) takes
// the `connect` closure it returns and never sees grpc directly, so all of the
// reconnect/state logic stays unit-testable without a live mapper.
//
// Client mechanism (owner-recorded decision, CB8 slice 3B): @grpc/grpc-js +
// @grpc/proto-loader against the mapper's EXISTING gRPC service on :10000, using
// a faithful mirror of the mapper's proto (proto/head_intent_diagnostics.proto),
// kept in sync — NOT forked, and NOT the browser grpc-web path. The mirror
// declares ONLY the read-only WatchHeadIntentDiagnostics RPC, so the generated
// client has no method that could mutate the mapper: no control path exists.
//
// keepCase:true keeps the mapper's snake_case field names (total_count,
// receive_age_ms, …) so the renderer view reads exactly the proto's fields.
// enums:String yields the enum NAME (e.g. HEAD_INTENT_STATE_ACTIVE_LOG_ONLY);
// longs:Number keeps the 64-bit counters as plain JS numbers for display.

const path = require('node:path');
const protoLoader = require('@grpc/proto-loader');
const grpc = require('@grpc/grpc-js');

const PROTO_PATH = path.join(__dirname, '..', 'proto', 'head_intent_diagnostics.proto');

const LOADER_OPTIONS = Object.freeze({
    keepCase: true,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
});

// Load the mirrored package definition. Exposed so a guard test can introspect
// the service surface (prove it exposes ONLY the read-only watch RPC) without
// opening any socket.
function loadHeadIntentPackage() {
    const packageDef = protoLoader.loadSync(PROTO_PATH, LOADER_OPTIONS);
    const proto = grpc.loadPackageDefinition(packageDef);
    return { packageDef, proto };
}

// The set of RPC method names the mirrored service declares. A guard test pins
// this to exactly ['WatchHeadIntentDiagnostics'] — a subscriber has no setter.
function serviceMethodNames() {
    const packageDef = protoLoader.loadSync(PROTO_PATH, LOADER_OPTIONS);
    const svc = packageDef['JoystickControl.JoystickControl'];
    return Object.keys(svc || {});
}

// Build a connect() closure bound to `addr`. One gRPC client (channel) is reused
// across reconnects; each connect() call opens a FRESH server-streaming call for
// WatchHeadIntentDiagnostics(Empty) and returns it (a ClientReadableStream with
// .on(...) + .cancel()). The consumer only reads from it; it never writes.
//
// Loopback insecure credentials: in the production topology the mapper and the
// ground station run on the same Windows host, and :10000 is a plain (non-TLS)
// gRPC endpoint. This client only READS a diagnostics stream; it sends no
// control data of any kind.
function createHeadIntentConnect(addr, { log = () => {} } = {}) {
    const { proto } = loadHeadIntentPackage();
    const Ctor = proto.JoystickControl.JoystickControl;
    let client = null;
    const clientOf = () => {
        if (!client) {
            client = new Ctor(addr, grpc.credentials.createInsecure());
            log(`[headintent] gRPC subscriber -> ${addr} (read-only WatchHeadIntentDiagnostics)`);
        }
        return client;
    };
    return function connect() {
        // Empty request; server-streaming response. Returns the readable call.
        return clientOf().WatchHeadIntentDiagnostics({});
    };
}

module.exports = {
    createHeadIntentConnect,
    loadHeadIntentPackage,
    serviceMethodNames,
    PROTO_PATH,
    LOADER_OPTIONS,
};
