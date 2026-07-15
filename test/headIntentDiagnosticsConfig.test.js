// Pure config + topology resolution for the mapper head-intent diagnostics
// consumer (CB8 slice 3B). No Electron, no grpc — plain objects only.
import { describe, it, expect } from 'vitest';
import {
    mapperHeadIntentConfigFromEnv,
    resolveHeadIntentModes,
    DEFAULT_GRPC_ADDR,
} from '../main/headIntentDiagnosticsConfig.js';

describe('mapperHeadIntentConfigFromEnv — disabled by default', () => {
    it('returns null unless W17_MAPPER_HEADINTENT=1 (no gRPC client, app unchanged)', () => {
        expect(mapperHeadIntentConfigFromEnv({})).toBeNull();
        expect(mapperHeadIntentConfigFromEnv({ W17_MAPPER_HEADINTENT: '0' })).toBeNull();
        expect(mapperHeadIntentConfigFromEnv({ W17_MAPPER_HEADINTENT: 'true' })).toBeNull();
    });

    it('enables against the mapper loopback gRPC endpoint by default', () => {
        expect(mapperHeadIntentConfigFromEnv({ W17_MAPPER_HEADINTENT: '1' }))
            .toEqual({ addr: DEFAULT_GRPC_ADDR });
        expect(DEFAULT_GRPC_ADDR).toBe('127.0.0.1:10000');
    });

    it('honors an explicit gRPC address override (trimmed)', () => {
        expect(mapperHeadIntentConfigFromEnv({
            W17_MAPPER_HEADINTENT: '1', W17_MAPPER_GRPC_ADDR: '  192.168.137.1:10000  ',
        })).toEqual({ addr: '192.168.137.1:10000' });
    });

    it('falls back to the default when the override is blank', () => {
        expect(mapperHeadIntentConfigFromEnv({ W17_MAPPER_HEADINTENT: '1', W17_MAPPER_GRPC_ADDR: '   ' }))
            .toEqual({ addr: DEFAULT_GRPC_ADDR });
    });
});

// Topology (a): UDP 5602 has exactly one owner. The consumer being enabled means
// the mapper owns 5602, so the local W3 receiver MUST be forced off — even if a
// W3 config would otherwise be produced. This is the mutual-exclusivity switch.
describe('resolveHeadIntentModes — mutual exclusivity (topology (a))', () => {
    const W3 = { port: 5602, bindHost: '0.0.0.0', staleMs: 300 };
    const CONSUMER = { addr: '127.0.0.1:10000' };

    it('consumer OFF: the W3 config passes through untouched (Electron owns 5602)', () => {
        expect(resolveHeadIntentModes({ consumerCfg: null, w3Cfg: W3 }))
            .toEqual({ consumer: null, w3: W3 });
    });

    it('consumer OFF and no W3 wish: neither mode runs', () => {
        expect(resolveHeadIntentModes({ consumerCfg: null, w3Cfg: null }))
            .toEqual({ consumer: null, w3: null });
    });

    it('consumer ON force-disables the W3 receiver (mapper owns 5602 — no double bind)', () => {
        // Even with a fully-formed W3 config present, the consumer wins and W3 → null.
        expect(resolveHeadIntentModes({ consumerCfg: CONSUMER, w3Cfg: W3 }))
            .toEqual({ consumer: CONSUMER, w3: null });
    });

    it('consumer ON with no W3 config: consumer runs, W3 stays off', () => {
        expect(resolveHeadIntentModes({ consumerCfg: CONSUMER, w3Cfg: null }))
            .toEqual({ consumer: CONSUMER, w3: null });
    });

    it('defaults: called with nothing yields both-off', () => {
        expect(resolveHeadIntentModes()).toEqual({ consumer: null, w3: null });
    });
});
