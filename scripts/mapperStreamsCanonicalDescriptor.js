// Canonical descriptor extractor for the ground station's second subscriber
// mirror: the mapper's two READ-ONLY streams (owner decision OD-4 / review
// SYN-2). The sibling of scripts/headIntentCanonicalDescriptor.js, and shared
// the same way — by the hermetic test (test/protoDrift.test.js) and the
// cross-repo compare CLI (scripts/check-canonical-proto.js).
//
// It reduces a @grpc/proto-loader package definition to a SMALL, stable,
// order-independent JSON shape covering EXACTLY what this app consumes:
//   * message Empty                       (the subscribe request type)
//   * enums   PortState, SupervisorState  (the two halves of "am I transmitting")
//   * message LinkState                   (every field name/number/type/label)
//   * messages LinkStatsData, BatteryData, GPSData, FlightModeData
//   * message Telemetry — ONLY the four oneof members above, by name; see below
//   * rpcs    getLinkStream, getTelemetryStream (package-qualified path +
//     streaming direction)
//
// PARTIAL BY DESIGN, on two axes, and the comparison is built to match:
//   1. The mapper's Telemetry oneof carries fifteen payloads; the W17 car sends
//      four. Only those four are extracted, BY NAME, so the mapper adding a
//      sixteenth payload is not drift — but any change to the field NUMBER or
//      TYPE of one of our four is, which is what would silently misread a wire.
//   2. Everything else in the source proto (the mapper's mutating RPCs, its
//      other messages) is ignored here; the ban on those RPCs is a separate,
//      stronger assertion in test/noControlPath.test.js, which reads this repo's
//      mirror directly.
//
// Type names are normalized to their leaf so the SAME logical type compares
// equal whether proto-loader rendered it qualified or not.

'use strict';

const { leafType } = require('./headIntentCanonicalDescriptor.js');

const PACKAGE = 'JoystickControl';
const SERVICE = 'JoystickControl';
const METHODS = ['getLinkStream', 'getTelemetryStream'];
const ENUMS = ['PortState', 'SupervisorState'];
const MESSAGES = ['LinkState', 'LinkStatsData', 'BatteryData', 'GPSData', 'FlightModeData'];
// The oneof members this viewer decodes. See note 1 above.
const TELEMETRY_MEMBERS = ['link_stats', 'battery', 'gps', 'flight_mode'];

function normalizeFields(messageDef, only = null) {
    const fields = (messageDef && messageDef.type && messageDef.type.field) || [];
    return fields
        .filter((f) => !only || only.includes(f.name))
        .map((f) => ({
            name: f.name,
            number: f.number,
            type: f.type,
            typeName: leafType(f.typeName),
            label: f.label,
        }))
        .sort((a, b) => a.number - b.number);
}

function normalizeEnumValues(enumDef) {
    const values = (enumDef && enumDef.type && enumDef.type.value) || [];
    return values
        .map((v) => ({ name: v.name, number: v.number }))
        .sort((a, b) => a.number - b.number);
}

// Build the canonical descriptor from a proto-loader package definition. Throws
// a descriptive error when a required declaration is missing — that is itself a
// drift signal worth failing on.
function extractMapperStreamsDescriptor(packageDefinition) {
    const need = (key) => {
        const def = packageDefinition[`${PACKAGE}.${key}`];
        if (!def) throw new Error(`missing ${PACKAGE}.${key}`);
        return def;
    };

    const serviceDef = need(SERVICE);
    const methods = METHODS.map((name) => {
        const m = serviceDef[name];
        if (!m) throw new Error(`missing rpc ${PACKAGE}.${SERVICE}/${name}`);
        return {
            name,
            path: m.path,
            requestStream: m.requestStream,
            responseStream: m.responseStream,
            requestType: leafType(m.requestType && m.requestType.type && m.requestType.type.name),
            responseType: leafType(m.responseType && m.responseType.type && m.responseType.type.name),
        };
    });

    const enums = {};
    for (const name of ENUMS) enums[name] = normalizeEnumValues(need(name));

    const messages = {};
    for (const name of MESSAGES) messages[name] = normalizeFields(need(name));

    return {
        package: PACKAGE,
        empty: { name: 'Empty', fields: normalizeFields(need('Empty')) },
        enums,
        messages,
        // Only the members this viewer decodes, by name.
        telemetry: { name: 'Telemetry', fields: normalizeFields(need('Telemetry'), TELEMETRY_MEMBERS) },
        methods,
    };
}

module.exports = {
    extractMapperStreamsDescriptor,
    PACKAGE,
    SERVICE,
    METHODS,
    ENUMS,
    MESSAGES,
    TELEMETRY_MEMBERS,
};
