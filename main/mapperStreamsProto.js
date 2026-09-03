// Loader for the ground station's SUBSCRIBER-ONLY mirror of the mapper's two
// read-only streams (proto/mapper_readonly_streams.proto). MAIN-process only.
//
// This is the one place that turns that .proto into a grpc-js client
// constructor; the two transport factories beside it each bind ONE stream, and
// the consumers they feed never see grpc at all. Splitting it this way is what
// lets test/noControlPath.test.js assert, per file, that the telemetry factory
// invokes only getTelemetryStream and the link factory only getLinkStream —
// there is no file in which both names appear next to a client.
//
// Loader options match main/headIntentGrpcConnect.js exactly, so both mirrors
// present their fields the same way: keepCase keeps the proto's snake_case names
// (ground_speed, uplink_link_quality, …), enums:String yields the enum NAME
// (PortConnected, SupervisorActive), longs:Number keeps the 64-bit counters as
// plain JS numbers for display.

const path = require('node:path');
const protoLoader = require('@grpc/proto-loader');
const grpc = require('@grpc/grpc-js');

const PROTO_PATH = path.join(__dirname, '..', 'proto', 'mapper_readonly_streams.proto');

const LOADER_OPTIONS = Object.freeze({
    keepCase: true,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
});

function loadStreamsPackage() {
    const packageDef = protoLoader.loadSync(PROTO_PATH, LOADER_OPTIONS);
    const proto = grpc.loadPackageDefinition(packageDef);
    return { packageDef, proto };
}

// The RPC method names the mirrored service declares. A guard test pins this to
// exactly the two read-only streams — a subscriber has no setter, and the
// generated client cannot grow one without this failing first.
function streamServiceMethodNames() {
    const packageDef = protoLoader.loadSync(PROTO_PATH, LOADER_OPTIONS);
    const svc = packageDef['JoystickControl.JoystickControl'];
    return Object.keys(svc || {}).sort();
}

// One channel per address, shared by both factories in a process: reconnects
// reuse it, exactly as the head-intent client does.
//
// Loopback insecure credentials: the mapper and the ground station run on the
// same Windows host and :10000 is a plain (non-TLS) gRPC endpoint. Mapper branch
// A makes 127.0.0.1 the default bind, so this keeps working.
const clients = new Map();
function clientFor(addr, log) {
    let client = clients.get(addr);
    if (!client) {
        const { proto } = loadStreamsPackage();
        client = new proto.JoystickControl.JoystickControl(addr, grpc.credentials.createInsecure());
        clients.set(addr, client);
        log(`[mapper-streams] gRPC subscriber -> ${addr} (read-only streams only)`);
    }
    return client;
}

module.exports = {
    loadStreamsPackage,
    streamServiceMethodNames,
    clientFor,
    PROTO_PATH,
    LOADER_OPTIONS,
};
