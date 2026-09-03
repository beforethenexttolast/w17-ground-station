// Proto-drift guard (CB8 slice 3C). HERMETIC: proves this repo's subscriber
// proto (proto/head_intent_diagnostics.proto) is byte-faithful to the mapper's
// canonical head-intent contract, using a checked-in snapshot
// (proto/canonical/head_intent_canonical.descriptor.json) as the single point of
// coupling — no w17-mapper checkout, no socket, no codegen. The snapshot is
// generated from and re-verified against the LIVE mapper by
// scripts/check-canonical-proto.js (the non-hermetic cross-repo half).
//
// What "byte-faithful" means here: same package, same enum value name->number
// pairs, same message field name/number/type/label tuples, same Empty request
// shape, and the same package-qualified WatchHeadIntentDiagnostics method path +
// streaming direction. Formatting/comments/field order are irrelevant; the wire
// contract is not.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const protoLoader = require('@grpc/proto-loader');
const {
    extractHeadIntentDescriptor,
} = require('../scripts/headIntentCanonicalDescriptor.js');
const {
    extractMapperStreamsDescriptor,
} = require('../scripts/mapperStreamsCanonicalDescriptor.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const GS_PROTO = path.join(REPO, 'proto', 'head_intent_diagnostics.proto');
const SNAPSHOT = path.join(REPO, 'proto', 'canonical', 'head_intent_canonical.descriptor.json');
const GS_STREAMS_PROTO = path.join(REPO, 'proto', 'mapper_readonly_streams.proto');
const STREAMS_SNAPSHOT = path.join(REPO, 'proto', 'canonical', 'mapper_streams_canonical.descriptor.json');

const LOADER_OPTIONS = Object.freeze({
    keepCase: true,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
});

const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
const gsDescriptor = extractHeadIntentDescriptor(protoLoader.loadSync(GS_PROTO, LOADER_OPTIONS));

describe('proto-drift guard — GS subscriber proto vs canonical mapper snapshot', () => {
    it('the GS proto descriptor is byte-identical to the canonical snapshot', () => {
        // The whole-descriptor deep-equal is the actual guard; the assertions
        // below pin the specific facets the mapper contract cares about so a
        // failure names WHAT drifted, not just "objects differ".
        expect(gsDescriptor).toEqual(snapshot);
    });

    it('package is JoystickControl on both sides', () => {
        expect(gsDescriptor.package).toBe('JoystickControl');
        expect(snapshot.package).toBe('JoystickControl');
    });

    it('Empty is a zero-field message (request serializes to zero bytes)', () => {
        expect(gsDescriptor.empty.name).toBe('Empty');
        expect(gsDescriptor.empty.fields).toEqual([]);
    });

    it('HeadIntentState enum values (name->number) match exactly, including UNSPECIFIED=0', () => {
        expect(gsDescriptor.enum.values).toEqual(snapshot.enum.values);
        // Explicit safety-relevant pins: 0 is the never-sent guard, and there is
        // no value above ACTIVE_LOG_ONLY (=8) — no "active control" state exists.
        const byName = Object.fromEntries(gsDescriptor.enum.values.map((v) => [v.name, v.number]));
        expect(byName.HEAD_INTENT_STATE_UNSPECIFIED).toBe(0);
        expect(byName.HEAD_INTENT_STATE_ACTIVE_LOG_ONLY).toBe(8);
        expect(Math.max(...gsDescriptor.enum.values.map((v) => v.number))).toBe(8);
    });

    it('HeadIntentDiagnostics field numbers + types match exactly', () => {
        expect(gsDescriptor.message.fields).toEqual(snapshot.message.fields);
        // Guard against a vacuous snapshot: the contract has 22 fields.
        expect(gsDescriptor.message.fields).toHaveLength(22);
        // state=1 is the enum field; receive_age_ms=10 is the server-computed
        // freshness — pin both so a renumber can't slip through.
        const state = gsDescriptor.message.fields.find((f) => f.name === 'state');
        expect(state).toMatchObject({ number: 1, type: 'TYPE_ENUM', typeName: 'HeadIntentState' });
        const age = gsDescriptor.message.fields.find((f) => f.name === 'receive_age_ms');
        expect(age).toMatchObject({ number: 10, type: 'TYPE_INT64' });
    });

    it('WatchHeadIntentDiagnostics method path + streaming direction match', () => {
        expect(gsDescriptor.method).toEqual(snapshot.method);
        expect(gsDescriptor.method.path).toBe('/JoystickControl.JoystickControl/WatchHeadIntentDiagnostics');
        expect(gsDescriptor.method.requestStream).toBe(false); // subscriber never streams up
        expect(gsDescriptor.method.responseStream).toBe(true);
        expect(gsDescriptor.method.requestType).toBe('Empty');
        expect(gsDescriptor.method.responseType).toBe('HeadIntentDiagnostics');
    });

    it('the snapshot itself is non-vacuous (guards against a garbage/empty snapshot)', () => {
        expect(snapshot.enum.values.length).toBe(9);
        expect(snapshot.message.fields.length).toBe(22);
        expect(snapshot.method.path).toContain('WatchHeadIntentDiagnostics');
    });
});

// The SECOND subscriber mirror (owner decision OD-4 / review SYN-2): the two
// read-only streams race day depends on. Same hermetic shape as the head-intent
// guard above — this repo's mirror vs a checked-in snapshot of the mapper's
// contract, no mapper checkout, no socket. What is compared is deliberately
// narrow (see scripts/mapperStreamsCanonicalDescriptor.js): the mapper adding a
// sixteenth Telemetry payload is not drift; renumbering or retyping one of the
// four this viewer decodes is.
const streamsSnapshot = JSON.parse(readFileSync(STREAMS_SNAPSHOT, 'utf8'));
const streamsDescriptor = extractMapperStreamsDescriptor(
    protoLoader.loadSync(GS_STREAMS_PROTO, LOADER_OPTIONS),
);

describe('proto-drift guard — GS read-only stream mirror vs canonical mapper snapshot', () => {
    it('the GS mirror is byte-identical to the canonical snapshot', () => {
        expect(streamsDescriptor).toEqual(streamsSnapshot);
    });

    it('both RPC paths + streaming directions match, and neither streams UP', () => {
        expect(streamsDescriptor.methods).toEqual(streamsSnapshot.methods);
        const byName = Object.fromEntries(streamsDescriptor.methods.map((m) => [m.name, m]));
        expect(byName.getTelemetryStream).toMatchObject({
            path: '/JoystickControl.JoystickControl/getTelemetryStream',
            requestStream: false,
            responseStream: true,
            requestType: 'Empty',
            responseType: 'Telemetry',
        });
        expect(byName.getLinkStream).toMatchObject({
            path: '/JoystickControl.JoystickControl/getLinkStream',
            requestStream: false,
            responseStream: true,
            requestType: 'Empty',
            responseType: 'LinkState',
        });
    });

    it('the two enums that decide "am I transmitting" match value-for-value', () => {
        expect(streamsDescriptor.enums.PortState)
            .toEqual([
                { name: 'PortUnknown', number: 0 },
                { name: 'PortDisconnected', number: 1 },
                { name: 'PortConnected', number: 2 },
            ]);
        expect(streamsDescriptor.enums.SupervisorState)
            .toEqual([
                { name: 'SupervisorUnknown', number: 0 },
                { name: 'SupervisorInactive', number: 1 },
                { name: 'SupervisorActive', number: 2 },
            ]);
    });

    it('the four Telemetry payloads this viewer decodes keep their field numbers and types', () => {
        const t = Object.fromEntries(streamsDescriptor.telemetry.fields.map((f) => [f.name, f]));
        expect(Object.keys(t).sort()).toEqual(['battery', 'flight_mode', 'gps', 'link_stats']);
        expect(t.link_stats).toMatchObject({ number: 1, typeName: 'LinkStatsData' });
        expect(t.battery).toMatchObject({ number: 3, typeName: 'BatteryData' });
        expect(t.gps).toMatchObject({ number: 4, typeName: 'GPSData' });
        expect(t.flight_mode).toMatchObject({ number: 5, typeName: 'FlightModeData' });
    });

    it('the fields the HUD actually reads keep their numbers (a renumber misreads the wire silently)', () => {
        const field = (msg, name) => streamsDescriptor.messages[msg].find((f) => f.name === name);
        expect(field('BatteryData', 'voltage')).toMatchObject({ number: 1, type: 'TYPE_FLOAT' });
        expect(field('GPSData', 'ground_speed')).toMatchObject({ number: 3, type: 'TYPE_FLOAT' });
        expect(field('FlightModeData', 'mode')).toMatchObject({ number: 1, type: 'TYPE_STRING' });
        expect(field('LinkStatsData', 'uplink_link_quality')).toMatchObject({ number: 3, type: 'TYPE_UINT32' });
        expect(field('LinkState', 'supervisor_state'))
            .toMatchObject({ number: 1, type: 'TYPE_ENUM', typeName: 'SupervisorState' });
        expect(field('LinkState', 'port_state'))
            .toMatchObject({ number: 2, type: 'TYPE_ENUM', typeName: 'PortState' });
    });

    it('the snapshot itself is non-vacuous', () => {
        expect(streamsSnapshot.methods).toHaveLength(2);
        expect(streamsSnapshot.telemetry.fields).toHaveLength(4);
        expect(streamsSnapshot.messages.LinkState).toHaveLength(5);
        expect(streamsSnapshot.empty.fields).toEqual([]);
    });
});
