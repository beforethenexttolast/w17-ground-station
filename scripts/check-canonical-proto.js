#!/usr/bin/env node
// Cross-repo proto-drift check for the head-intent diagnostics contract
// (CB8 slice 3C). This is the NON-hermetic half of the drift guard: it reaches
// into a local w17-mapper checkout and proves that the checked-in canonical
// snapshot (proto/canonical/head_intent_canonical.descriptor.json) still matches
// the mapper's authoritative definitions in pkg/proto/server.proto.
//
// The hermetic half lives in test/protoDrift.test.js and runs in every CI: it
// compares THIS repo's proto/head_intent_diagnostics.proto against the same
// checked-in snapshot, so the snapshot is the single point of coupling. Refresh
// the snapshot with `--write` only after this check confirms (or intentionally
// adopts) a mapper change; then re-run the hermetic suite.
//
// Usage:
//   node scripts/check-canonical-proto.js            # verify snapshot == live mapper
//   node scripts/check-canonical-proto.js --write     # regenerate snapshot from live mapper
//   W17_MAPPER_REPO=/path/to/w17-mapper node scripts/check-canonical-proto.js
//
// Exit codes: 0 = in sync (or written); 2 = drift detected; 3 = mapper checkout
// not found (skipped — hermetic test still covers this repo). Being run without a
// mapper checkout is NOT a failure; it prints a skip notice and exits 3 so a
// caller can distinguish "skipped" from "clean".

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const protoLoader = require('@grpc/proto-loader');
const { extractHeadIntentDescriptor } = require('./headIntentCanonicalDescriptor.js');
const { extractMapperStreamsDescriptor } = require('./mapperStreamsCanonicalDescriptor.js');

const LOADER_OPTIONS = Object.freeze({
    keepCase: true,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
});

const REPO_ROOT = path.join(__dirname, '..');
// Two mirrors, two snapshots, ONE live source: the mapper's server.proto. Both
// are checked in the same run so a mapper change cannot be half-adopted.
const SNAPSHOTS = [
    {
        label: 'head-intent',
        file: path.join(REPO_ROOT, 'proto', 'canonical', 'head_intent_canonical.descriptor.json'),
        extract: extractHeadIntentDescriptor,
    },
    {
        label: 'read-only streams',
        file: path.join(REPO_ROOT, 'proto', 'canonical', 'mapper_streams_canonical.descriptor.json'),
        extract: extractMapperStreamsDescriptor,
    },
];

function resolveMapperProto() {
    const repo = process.env.W17_MAPPER_REPO
        ? process.env.W17_MAPPER_REPO
        : path.join(REPO_ROOT, '..', 'w17-mapper');
    const proto = path.join(repo, 'pkg', 'proto', 'server.proto');
    return { repo, proto };
}

// Stable serialization: the extractor already sorts fields/values by number, so
// a plain 2-space JSON stringify is deterministic and diff-friendly.
function serialize(descriptor) {
    return JSON.stringify(descriptor, null, 2) + '\n';
}

function main() {
    const write = process.argv.includes('--write');
    const { repo, proto } = resolveMapperProto();

    if (!fs.existsSync(proto)) {
        console.error(`[proto-drift] SKIP: no mapper checkout at ${proto}`);
        console.error('[proto-drift] Set W17_MAPPER_REPO or place w17-mapper beside this repo.');
        console.error('[proto-drift] The hermetic test (test/protoDrift.test.js) still guards this repo.');
        process.exit(3);
    }

    let def;
    try {
        def = protoLoader.loadSync(proto, LOADER_OPTIONS);
    } catch (err) {
        console.error(`[proto-drift] FAILED to load mapper proto: ${err.message}`);
        process.exit(2);
    }

    let drifted = false;
    for (const { label, file, extract } of SNAPSHOTS) {
        let liveJson;
        try {
            liveJson = serialize(extract(def));
        } catch (err) {
            console.error(`[proto-drift] ${label}: FAILED to extract from the mapper proto: ${err.message}`);
            process.exit(2);
        }

        if (write) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, liveJson);
            console.log(`[proto-drift] ${label}: wrote snapshot from ${repo}`);
            console.log(`[proto-drift]   -> ${path.relative(REPO_ROOT, file)}`);
            continue;
        }

        if (!fs.existsSync(file)) {
            console.error(`[proto-drift] ${label}: no snapshot at ${file}; run with --write`);
            drifted = true;
            continue;
        }
        if (fs.readFileSync(file, 'utf8') === liveJson) {
            console.log(`[proto-drift] ${label}: OK — checked-in snapshot matches live mapper`);
            continue;
        }
        console.error(`[proto-drift] ${label}: DRIFT — snapshot != live mapper contract.`);
        drifted = true;
    }

    if (write) process.exit(0);
    if (drifted) {
        console.error('[proto-drift] Review the mapper change; if intended, refresh with --write and re-run the suite.');
        process.exit(2);
    }
    console.log(`[proto-drift] mapper: ${repo}`);
    process.exit(0);
}

main();
