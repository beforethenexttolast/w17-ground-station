// gRPC transport factory for the read-only RF LINK STATE stream (review SYN-2).
// MAIN-process only, one RPC, same shape and same reasoning as its telemetry
// sibling: the file names exactly one mapper method, and that method reads.
//
// The RPC is `getLinkStream` — w17-mapper/pkg/proto/server.proto:574 at trunk
// w17-headtrack 21834fe, mirrored in proto/mapper_readonly_streams.proto. It
// takes Empty and returns a server stream of LinkState; nothing flows back.
//
// This is the stream that makes the race-day card honest: the drive program can
// be running with no transmitter port open, in which case no CRSF frame ever
// leaves the PC and "running" would be a lie.
//
// test/noControlPath.test.js pins that this file names getLinkStream and no
// other mapper RPC.

const { clientFor } = require('./mapperStreamsProto.js');

function createMapperLinkConnect(addr, { log = () => {} } = {}) {
    return function connect() {
        return clientFor(addr, log).getLinkStream({});
    };
}

module.exports = { createMapperLinkConnect };
