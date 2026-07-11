// One-line "what's configured" strip for the GRID screen: mode · network ·
// adapter · pad, formatted from persisted settings. Pure ESM (renderer +
// vitest), no IO — display formatting only, in the checklist.mjs style.

import { getPreset } from './inputPresets.mjs';

// Display labels for the persisted mode values (matches the GARAGE cards;
// the persisted values stay 'solo' / 'iphone-hud' — labels only).
const MODE_LABELS = { solo: 'DESKTOP FPV', 'iphone-hud': 'IPHONE COCKPIT' };

export function summaryLine(settings = {}) {
    const parts = [MODE_LABELS[settings.fpvMode] || MODE_LABELS.solo];
    // The network step exists only in iPhone mode — echoing its persisted
    // leftovers in a desktop session would mislead. Empty parts are omitted.
    if (settings.fpvMode === 'iphone-hud') {
        const net = settings.network || {};
        if (net.kind === 'hotspot') parts.push(`NET ${net.hotspot?.ssid || 'W17-GRID'} (HOTSPOT)`);
        else if (net.kind === 'join' && net.ssid) parts.push(`NET ${net.ssid}`);
        else if (net.kind === 'guide') parts.push('NET GUIDE');
        if (net.adapter) parts.push(`ADAPTER ${net.adapter}`);
    }
    parts.push(`PAD ${getPreset(settings.controller?.preset).label}`);
    return parts.join(' · ');
}
