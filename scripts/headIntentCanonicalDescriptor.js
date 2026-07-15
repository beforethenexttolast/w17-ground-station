// Canonical descriptor extractor for the head-intent diagnostics proto (CB8
// slice 3C proto-drift guard). Shared by the hermetic test
// (test/protoDrift.test.js) and the cross-repo compare CLI
// (scripts/check-canonical-proto.js).
//
// It reduces a @grpc/proto-loader package definition to a SMALL, stable,
// order-independent JSON shape covering EXACTLY the three canonical head-intent
// declarations the mapper owns:
//   * message Empty                (the subscribe request type)
//   * enum    HeadIntentState      (all value name->number pairs)
//   * message HeadIntentDiagnostics(every field name/number/type/label)
//   * rpc     WatchHeadIntentDiagnostics (package-qualified path + streaming)
//
// Anything else in the source proto (the mapper's full JoystickControl service,
// or the ground station's subscriber-only subset) is deliberately ignored, so
// the comparison is byte-faithful on the head-intent contract without being
// coupled to the rest of either file. Type names are normalized to their leaf
// (package/leading-dot stripped) so the SAME logical type compares equal whether
// proto-loader rendered it qualified or not.

'use strict';

const PACKAGE = 'JoystickControl';
const SERVICE = 'JoystickControl';
const METHOD = 'WatchHeadIntentDiagnostics';
const ENUM_NAME = 'HeadIntentState';
const MESSAGE_NAME = 'HeadIntentDiagnostics';
const EMPTY_NAME = 'Empty';

// Strip any package qualifier / leading dot from a proto type reference so
// `.JoystickControl.HeadIntentState`, `JoystickControl.HeadIntentState`, and
// `HeadIntentState` all normalize to `HeadIntentState`.
function leafType(typeName) {
    if (!typeName) return '';
    const noDot = String(typeName).replace(/^\./, '');
    const parts = noDot.split('.');
    return parts[parts.length - 1];
}

// Normalize one message's fields to a name-sorted array of
// {name, number, type, typeName, label, repeated}. Field ORDER in the proto is
// irrelevant to the wire contract — only the (name, number, type) tuples are —
// so we sort by field number for a stable, diff-friendly comparison.
function normalizeMessageFields(messageDef) {
    const fields = (messageDef && messageDef.type && messageDef.type.field) || [];
    return fields
        .map((f) => ({
            name: f.name,
            number: f.number,
            type: f.type, // e.g. TYPE_UINT64, TYPE_ENUM, TYPE_BOOL, TYPE_DOUBLE
            typeName: leafType(f.typeName), // '' for scalars; leaf for enum/message
            label: f.label, // LABEL_OPTIONAL / LABEL_REPEATED
        }))
        .sort((a, b) => a.number - b.number);
}

function normalizeEnumValues(enumDef) {
    const values = (enumDef && enumDef.type && enumDef.type.value) || [];
    return values
        .map((v) => ({ name: v.name, number: v.number }))
        .sort((a, b) => a.number - b.number);
}

// Build the canonical descriptor object from a proto-loader package definition
// (as returned by protoLoader.loadSync). Throws a descriptive error if any of
// the three required declarations, or the method, is missing — that itself is a
// drift signal worth failing on.
function extractHeadIntentDescriptor(packageDefinition) {
    const emptyKey = `${PACKAGE}.${EMPTY_NAME}`;
    const enumKey = `${PACKAGE}.${ENUM_NAME}`;
    const messageKey = `${PACKAGE}.${MESSAGE_NAME}`;
    const serviceKey = `${PACKAGE}.${SERVICE}`;

    const emptyDef = packageDefinition[emptyKey];
    const enumDef = packageDefinition[enumKey];
    const messageDef = packageDefinition[messageKey];
    const serviceDef = packageDefinition[serviceKey];

    if (!emptyDef) throw new Error(`missing message ${emptyKey}`);
    if (!enumDef) throw new Error(`missing enum ${enumKey}`);
    if (!messageDef) throw new Error(`missing message ${messageKey}`);
    if (!serviceDef) throw new Error(`missing service ${serviceKey}`);

    const method = serviceDef[METHOD];
    if (!method) throw new Error(`missing rpc ${serviceKey}/${METHOD}`);

    return {
        package: PACKAGE,
        empty: {
            name: EMPTY_NAME,
            fields: normalizeMessageFields(emptyDef), // must be []
        },
        enum: {
            name: ENUM_NAME,
            values: normalizeEnumValues(enumDef),
        },
        message: {
            name: MESSAGE_NAME,
            fields: normalizeMessageFields(messageDef),
        },
        method: {
            name: METHOD,
            path: method.path, // /JoystickControl.JoystickControl/WatchHeadIntentDiagnostics
            requestStream: method.requestStream,
            responseStream: method.responseStream,
            requestType: leafType(method.requestType && method.requestType.type && method.requestType.type.name),
            responseType: leafType(method.responseType && method.responseType.type && method.responseType.type.name),
        },
    };
}

module.exports = {
    extractHeadIntentDescriptor,
    leafType,
    PACKAGE,
    SERVICE,
    METHOD,
    ENUM_NAME,
    MESSAGE_NAME,
    EMPTY_NAME,
};
