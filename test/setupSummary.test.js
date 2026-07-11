import { describe, it, expect } from 'vitest';
import { summaryLine } from '../shared/setupSummary.mjs';

describe('summaryLine — the GRID "what\'s configured" strip', () => {
    it('solo shows mode + pad only (network step does not exist in solo)', () => {
        expect(summaryLine({ fpvMode: 'solo', controller: { preset: 'dualshock' } }))
            .toBe('DESKTOP FPV · PAD DualShock');
        // Persisted network leftovers must not leak into a desktop session.
        expect(summaryLine({
            fpvMode: 'solo',
            network: { kind: 'join', ssid: 'PaddockNet', adapter: 'Wi-Fi 2' },
        })).toBe('DESKTOP FPV · PAD DualShock');
    });

    it('iphone-hud join shows the joined SSID and the pinned adapter', () => {
        expect(summaryLine({
            fpvMode: 'iphone-hud',
            network: { kind: 'join', ssid: 'PaddockNet', adapter: 'Wi-Fi 2' },
            controller: { preset: 'xbox' },
        })).toBe('IPHONE COCKPIT · NET PaddockNet · ADAPTER Wi-Fi 2 · PAD Xbox');
    });

    it('hotspot shows the hotspot SSID; guide says GUIDE; empty parts are omitted', () => {
        expect(summaryLine({
            fpvMode: 'iphone-hud',
            network: { kind: 'hotspot', hotspot: { ssid: 'W17-GRID' } },
        })).toBe('IPHONE COCKPIT · NET W17-GRID (HOTSPOT) · PAD DualShock');
        expect(summaryLine({ fpvMode: 'iphone-hud', network: { kind: 'guide' } }))
            .toBe('IPHONE COCKPIT · NET GUIDE · PAD DualShock');
        // join with no saved SSID yet: the NET part is omitted, not invented.
        expect(summaryLine({ fpvMode: 'iphone-hud', network: { kind: 'join', ssid: '' } }))
            .toBe('IPHONE COCKPIT · PAD DualShock');
    });

    it('tolerates missing/partial settings with sane defaults', () => {
        expect(summaryLine()).toBe('DESKTOP FPV · PAD DualShock');
        expect(summaryLine({ fpvMode: 'iphone-hud' })).toBe('IPHONE COCKPIT · PAD DualShock');
    });
});
