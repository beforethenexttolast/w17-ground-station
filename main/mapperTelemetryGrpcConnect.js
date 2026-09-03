// gRPC transport factory for the read-only CAR TELEMETRY stream (owner decision
// OD-4). MAIN-process only, and deliberately the SMALLEST file in the chain: it
// binds exactly one RPC, so "this app only reads telemetry from the mapper" is
// a property you can read off the file rather than infer from a call graph.
//
// The RPC is `getTelemetryStream` — w17-mapper/pkg/proto/server.proto:575 at
// trunk w17-headtrack 21834fe, mirrored in proto/mapper_readonly_streams.proto.
// It takes Empty and returns a server stream of Telemetry; nothing flows back.
//
// test/noControlPath.test.js pins that this file names getTelemetryStream and no
// other mapper RPC.

const { clientFor } = require('./mapperStreamsProto.js');

// Build a connect() closure bound to `addr`. Each call opens a FRESH
// server-streaming call and returns it (a ClientReadableStream with .on(...) +
// .cancel()). The consumer only reads from it; it never writes.
function createMapperTelemetryConnect(addr, { log = () => {} } = {}) {
    return function connect() {
        return clientFor(addr, log).getTelemetryStream({});
    };
}

module.exports = { createMapperTelemetryConnect };
