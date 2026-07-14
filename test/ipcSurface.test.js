// IPC / preload / renderer symmetry (audit D2). The preload is the ONLY bridge
// between the sandboxed renderer and main, so its surface is pinned from all
// three sides: every channel the preload invokes has a registered main handler,
// every registered handler has a preload method, every preload method has a
// renderer consumer, and every renderer call names a real preload method. Push
// channels are pinned the same way. A dead or asymmetric surface — the class of
// defect audit M3 found (a stop handler no renderer could reach) — fails here.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { PUSH_CHANNELS, registerIpcHandlers } from '../main/appWiring.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const preloadSrc = read('../main/preload.cjs');
const mainSrc = read('../main/main.js');
const indexHtml = read('../renderer/index.html');

const matchAll = (src, re) => [...src.matchAll(re)].map((m) => m[1]);

// --- the three surfaces, extracted from the actual sources ---

const preloadInvokes = [...new Set(matchAll(preloadSrc, /ipcRenderer\.invoke\('([^']+)'/g))];
const preloadSends = [...new Set(matchAll(preloadSrc, /ipcRenderer\.send\('([^']+)'/g))];
const preloadSubscribes = [...new Set(matchAll(preloadSrc, /ipcRenderer\.on\('([^']+)'/g))];

// Exposed method names: the keys of the exposeInMainWorld object literal.
const exposedBlock = preloadSrc.slice(
    preloadSrc.indexOf("exposeInMainWorld('groundStation', {"),
    preloadSrc.lastIndexOf('});'),
);
const exposedKeys = matchAll(exposedBlock, /^ {2}(\w+):/gm);

// Renderer usage: every `gs.<method>` / `groundStation.<method>` reference in
// the renderer modules (property checks like `gs.hotspotState &&` included).
const RENDERER_FILES = ['../renderer/setupFlow.js', '../renderer/hud.js', '../renderer/whep.js', '../renderer/padPreview.js', '../renderer/sounds.js'];
const rendererUsage = new Set();
for (const f of RENDERER_FILES) {
    for (const name of matchAll(read(f), /\b(?:gs|groundStation)\.(\w+)/g)) rendererUsage.add(name);
}

// The registered main-process surface, captured from the real registration
// function over a strict fake ipcMain with stub services.
function registeredChannels() {
    const handlers = new Map();
    const listeners = new Map();
    const ipcMain = {
        handle: (ch, fn) => {
            if (handlers.has(ch)) throw new Error(`dup ${ch}`);
            handlers.set(ch, fn);
        },
        on: (ch, fn) => {
            if (listeners.has(ch)) throw new Error(`dup ${ch}`);
            listeners.set(ch, fn);
        },
    };
    registerIpcHandlers({
        ipcMain,
        services: {
            whepUrl: 'http://127.0.0.1:8889/cam/whep',
            platform: 'win32',
            feel: {},
            runtime: { hasTelemetrySource: () => false, onCommandMirror: () => {} },
            settingsStore: { load: () => ({ elrsPath: '' }), save: vi.fn() },
            sessionApplier: { apply: vi.fn(), effective: () => null },
            w3Active: () => false,
            wifi: { capabilities: () => ({}), listInterfaces: vi.fn(), scan: vi.fn(), join: vi.fn(), status: vi.fn() },
            sim: false,
            hotspotLifecycle: { start: vi.fn(), stop: vi.fn(), snapshot: vi.fn(), probe: vi.fn() },
            addrHint: { get: vi.fn() },
            hostProbe: { probe: vi.fn() },
            elrs: { detectRunning: vi.fn(), launchDetached: vi.fn() },
        },
    });
    return { handled: [...handlers.keys()], listened: [...listeners.keys()] };
}

describe('IPC surface symmetry (audit D2)', () => {
    it('sanity: the extraction found a real surface (a broken parse must not vacuously pass)', () => {
        expect(preloadInvokes.length).toBeGreaterThan(10);
        expect(exposedKeys.length).toBeGreaterThan(15);
        expect(rendererUsage.size).toBeGreaterThan(15);
    });

    it('every preload invoke channel has a registered handler, and vice versa (no dead channels)', () => {
        const { handled } = registeredChannels();
        expect([...preloadInvokes].sort()).toEqual([...handled].sort());
    });

    it('every preload fire-and-forget send channel has a registered listener, and vice versa', () => {
        const { listened } = registeredChannels();
        expect([...preloadSends].sort()).toEqual([...listened].sort());
    });

    it('every preload event subscription maps to a real main push channel, and vice versa', () => {
        expect([...preloadSubscribes].sort()).toEqual(Object.values(PUSH_CHANNELS).sort());
    });

    it('main.js pushes ONLY through the PUSH_CHANNELS constants — no raw channel literals to drift', () => {
        expect(mainSrc).toContain('PUSH_CHANNELS.telemetry');
        expect(mainSrc).toContain('wireHotspotPush');
        expect(mainSrc).not.toMatch(/send\('telemetry'/);
        expect(mainSrc).not.toMatch(/send\('hotspot-state'/);
    });

    it('every renderer groundStation call names an exposed preload method (no phantom methods)', () => {
        const unknown = [...rendererUsage].filter((n) => !exposedKeys.includes(n));
        expect(unknown, `renderer references non-existent preload methods: ${unknown.join(', ')}`).toEqual([]);
    });

    it('every exposed preload method has a renderer consumer (no dead preload surface — audit M3 class)', () => {
        const dead = exposedKeys.filter((n) => !rendererUsage.has(n));
        expect(dead, `preload methods no renderer calls: ${dead.join(', ')}`).toEqual([]);
    });

    it('registration is single-sited: only appWiring registers ipc handlers (unknown channels stay unavailable)', () => {
        // main.js passes ipcMain into the one registration seam and registers
        // nothing itself; no other runtime module may touch ipcMain (the
        // no-control-path sweep already bans it from the W3 modules).
        expect(mainSrc).not.toMatch(/ipcMain\.(handle|on)\(/);
        expect(read('../main/appWiring.js').match(/ipcMain\.handle\(/g).length).toBe(1); // one reg helper, not scattered calls
    });
});

describe('preload minimalism (audit D2)', () => {
    it('exposes exactly one bridge object and requires only electron', () => {
        expect(preloadSrc.match(/exposeInMainWorld/g).length).toBe(1);
        const requires = matchAll(preloadSrc, /require\('([^']+)'\)/g);
        expect(requires).toEqual(['electron']);
    });

    it('never hands ipcRenderer (or any Node primitive) to the page — member access only', () => {
        // In CODE (comments stripped) the only bare non-member mention is the
        // destructuring require line.
        const code = preloadSrc.replace(/^\s*\/\/.*$/gm, '');
        const bare = code.match(/ipcRenderer(?!\.)/g) || [];
        expect(bare.length).toBe(1);
        for (const forbidden of ['process.', 'require(', 'window.', '__dirname', 'Buffer']) {
            expect(exposedBlock, `preload must not expose ${forbidden}`).not.toContain(forbidden);
        }
    });

    it('the exposed surface is the pinned 20-method contract — additions are deliberate', () => {
        expect([...exposedKeys].sort()).toEqual([
            'applySession', 'elrsLaunch', 'elrsStatus', 'getAddrHint', 'getConfig',
            'getSettings', 'hotspotProbe', 'hotspotStart', 'hotspotState', 'hotspotStop',
            'onHotspotState', 'onTelemetry', 'probeHost', 'sendCommandMirror', 'setSettings',
            'wifiCapabilities', 'wifiInterfaces', 'wifiJoin', 'wifiScan', 'wifiStatus',
        ]);
    });

    it('event subscriptions return an unsubscribe (no listener-leak surface)', () => {
        // Both on* methods must removeListener on the returned disposer.
        const onBlocks = preloadSrc.split('ipcRenderer.on(').slice(1);
        expect(onBlocks.length).toBe(preloadSubscribes.length);
        for (const block of onBlocks) {
            expect(block.slice(0, 300)).toContain('removeListener');
        }
    });
});

describe('composition pins in main.js (audit D2)', () => {
    it('the quit policy receives the SAME hotspot lifecycle authority the IPC surface uses', () => {
        expect(mainSrc).toMatch(/createQuitPolicy\(\{\s*lifecycle:\s*hotspotLifecycle/);
        expect(mainSrc).toMatch(/hotspotLifecycle,?\s*\n?\s*addrHint/); // services object hands the same instance to IPC
    });

    it('shutdown never stops the hotspot — that decision belongs to the quit policy alone (Q1)', () => {
        expect(mainSrc).not.toMatch(/hotspotLifecycle\.stop|hotspot\.stop/);
        // The teardown steps are exactly the owned runtime children.
        expect(mainSrc).toMatch(/head-tracking receiver/);
        expect(mainSrc).toMatch(/session runtime/);
        expect(mainSrc).toMatch(/mediamtx/);
    });

    it('the renderer page pins a CSP whose connect-src is loopback-only (WHEP), scripts self-only', () => {
        const csp = indexHtml.match(/Content-Security-Policy"\s*content="([^"]+)"/)[1];
        expect(csp).toContain("default-src 'self'");
        expect(csp).toContain("script-src 'self'");
        expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
        const connect = csp.match(/connect-src ([^;]+)/)[1].trim().split(/\s+/);
        for (const src of connect) {
            expect(src, `connect-src must stay loopback-only, got ${src}`).toMatch(/^http:\/\/(127\.0\.0\.1|localhost):8889$/);
        }
    });
});
