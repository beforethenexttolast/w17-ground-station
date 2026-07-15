// The mirrored proto + gRPC transport factory (CB8 slice 3B). These are the
// STRONGEST no-control-path guards for the consumer: they prove that the wire
// definition the client loads exposes ONLY the read-only, server-streaming
// WatchHeadIntentDiagnostics RPC — so the generated client physically has no
// method that could mutate the mapper. Hermetic: proto-loader parses the file;
// no socket is opened, no mapper is contacted.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    loadHeadIntentPackage,
    serviceMethodNames,
    PROTO_PATH,
} = require('../main/headIntentGrpcConnect.js');

const protoSrc = readFileSync(PROTO_PATH, 'utf8');
// The proto's header comment deliberately NAMES the omitted mapper RPCs to
// explain why they are absent; the setter-ban checks run on code only.
const protoCode = protoSrc.replace(/\/\/[^\n]*/g, '');

describe('head-intent proto — SUBSCRIBER-ONLY service surface', () => {
    it('declares exactly one RPC, and it is WatchHeadIntentDiagnostics', () => {
        expect(serviceMethodNames()).toEqual(['WatchHeadIntentDiagnostics']);
    });

    it('that RPC is read-only server-streaming (Empty in, stream out)', () => {
        const packageDef = loadHeadIntentPackage().packageDef;
        const method = packageDef['JoystickControl.JoystickControl'].WatchHeadIntentDiagnostics;
        expect(method.requestStream).toBe(false);
        expect(method.responseStream).toBe(true);
        expect(method.path).toBe('/JoystickControl.JoystickControl/WatchHeadIntentDiagnostics');
    });

    it('the generated client constructor has NO mapper setter/mutator method', () => {
        const { proto } = loadHeadIntentPackage();
        const Ctor = proto.JoystickControl.JoystickControl;
        const methods = Object.keys(Ctor.service);
        expect(methods).toEqual(['WatchHeadIntentDiagnostics']);
        // None of the mapper's real mutators leaked into this subscriber client.
        for (const forbidden of ['setConfig', 'setCRSFDeviceField', 'startLink', 'stopLink', 'startHTTP', 'clearCRSFDeviceLinkCriticalFlags']) {
            expect(Ctor.prototype[forbidden]).toBeUndefined();
        }
    });
});

describe('head-intent proto — the file is a faithful, self-contained mirror', () => {
    it('is the only RPC in the file (no other rpc lines slipped in)', () => {
        const rpcs = [...protoSrc.matchAll(/^\s*rpc\s+(\w+)/gm)].map((m) => m[1]);
        expect(rpcs).toEqual(['WatchHeadIntentDiagnostics']);
    });

    it('carries no client->server setter of any kind (code, comments aside)', () => {
        for (const forbidden of ['setConfig', 'SetConfig', 'setCRSFDeviceField', 'startLink', 'stopLink']) {
            expect(protoCode).not.toContain(forbidden);
        }
    });

    it('mirrors the mapper enum: 9 states, explicit UNSPECIFIED=0, no active-control state', () => {
        expect(protoSrc).toContain('HEAD_INTENT_STATE_UNSPECIFIED = 0;');
        expect(protoSrc).toContain('HEAD_INTENT_STATE_ACTIVE_LOG_ONLY = 8;');
        const states = [...protoSrc.matchAll(/HEAD_INTENT_STATE_\w+\s*=\s*\d+;/g)];
        expect(states.length).toBe(9);
        // There is deliberately no "active control" state name.
        expect(protoSrc).not.toMatch(/HEAD_INTENT_STATE_ACTIVE\s*=/);
        expect(protoSrc).not.toContain('HEAD_INTENT_STATE_CONTROL');
    });

    it('is self-contained (no google/protobuf import to resolve) and in the mapper package', () => {
        expect(protoSrc).not.toContain('import ');
        expect(protoSrc).toContain('package JoystickControl;');
    });
});
