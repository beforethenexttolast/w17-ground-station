// Main-process wiring seams (audit D2): the integration layer between env,
// persisted settings, the session runtime, the IPC surface, and shutdown —
// exercised with fakes and REAL collaborators (SessionRuntime, settingsStore,
// HotspotLifecycle, resolveEffective) instead of a booted Electron process.
// These are the seams where configuration and lifecycle mistakes hide; the
// pure pieces (resolveEffective matrix, SessionRuntime choreography, the
// lifecycle state machine) keep their own focused suites.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    PUSH_CHANNELS,
    createNetworkServices,
    telemetrySourceFor,
    createSessionApplier,
    createKeyedInstance,
    mediamtxPaths,
    registerIpcHandlers,
    wireHotspotPush,
    createWindowOptions,
    installNavigationPolicy,
    createTeardown,
} from '../main/appWiring.js';
import { createSettingsStore } from '../main/settingsStore.js';
import { SessionRuntime } from '../main/sessionRuntime.js';
import { HotspotManager } from '../main/hotspot.js';
import { HotspotLifecycle } from '../main/hotspotLifecycle.js';

// ---------- shared fakes ----------

// Strict fake ipcMain: a duplicate registration is an error, exactly like the
// real one ("Attempted to register a second handler for ...").
function fakeIpcMain() {
    const handlers = new Map();
    const listeners = new Map();
    return {
        handle(channel, fn) {
            if (handlers.has(channel)) throw new Error(`second handler for ${channel}`);
            handlers.set(channel, fn);
        },
        on(channel, fn) {
            if (listeners.has(channel)) throw new Error(`second listener for ${channel}`);
            listeners.set(channel, fn);
        },
        invoke: (channel, ...args) => handlers.get(channel)({ /* event */ }, ...args),
        emit: (channel, ...args) => listeners.get(channel)({ /* event */ }, ...args),
        handlers,
        listeners,
    };
}

function fakeBridge(cfg, extra) {
    return {
        cfg,
        extra,
        started: 0,
        stopped: 0,
        start() { this.started += 1; },
        stop() { this.stopped += 1; },
        onTelemetry() {},
        onCommandMirror() {},
    };
}

function fakeSource(cfg) {
    return {
        cfg,
        started: 0,
        stopped: 0,
        start() { this.started += 1; },
        stop() { this.stopped += 1; },
        onTelemetry() { return () => {}; },
    };
}

// A real settings store in a throwaway dir + a real SessionRuntime over fake
// factories + a spy applyW3: the actual applySession composition main.js runs.
function makeApplier({ env = {}, seed = null, applyW3 } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'w17-appwiring-'));
    if (seed !== null) writeFileSync(join(dir, 'settings.json'), seed, 'utf8');
    const settingsStore = createSettingsStore({ dir });
    const sources = [];
    const bridges = [];
    const runtime = new SessionRuntime({
        createTelemetrySource: (cfg) => {
            if (cfg.source === 'none') return null;
            const s = fakeSource(cfg);
            sources.push(s);
            return s;
        },
        createIphoneBridge: (cfg, extra) => {
            const b = fakeBridge(cfg, extra);
            bridges.push(b);
            return b;
        },
    });
    const w3Spy = applyW3 || vi.fn(() => false);
    const applier = createSessionApplier({ settingsStore, runtime, env, applyW3: w3Spy });
    return {
        dir, settingsStore, runtime, sources, bridges, applier, w3Spy,
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
}

const IPHONE_SETTINGS = JSON.stringify({
    fpvMode: 'iphone-hud', iphoneAddr: '192.168.137.2', iphonePort: 5601,
});

// ---------- network services ----------

describe('createNetworkServices — sim routing (audit D2)', () => {
    it('without W17_WIFI_SIM the managers run against the real OS layer (platform = host)', () => {
        const { wifi, hotspot, hotspotLifecycle, sim } = createNetworkServices({ env: {} });
        expect(sim).toBe(false);
        expect(wifi.capabilities().platform).toBe(process.platform);
        expect(hotspot).toBeTruthy();
        expect(hotspotLifecycle.snapshot()).toMatchObject({ phase: 'inactive', owned: false });
    });

    it('with W17_WIFI_SIM the managers run the canned runner as win32 (dev preview, no OS calls)', async () => {
        const { wifi, hotspotLifecycle, sim } = createNetworkServices({
            env: { W17_WIFI_SIM: 'two-adapters' },
        });
        expect(sim).toBe(true);
        expect(wifi.capabilities()).toMatchObject({ platform: 'win32', canScan: true });
        const ifaces = await wifi.listInterfaces();
        expect(ifaces.ok).toBe(true);
        expect(ifaces.ifaces.length).toBe(2);
        // The lifecycle wraps the SAME sim-backed manager: a probe resolves
        // without any real PowerShell.
        const probe = await hotspotLifecycle.probe();
        expect(probe.status).toBe('supported');
    });
});

// ---------- telemetry source selection ----------

describe('telemetrySourceFor — effective source to instance (audit D2)', () => {
    it("'none' returns null: HUD runs on the gamepad + display model", () => {
        expect(telemetrySourceFor({ source: 'none', port: '' })).toBeNull();
    });

    // Class identity is asserted by constructor NAME: the test's ESM import
    // and appWiring's require would otherwise be two module instances under
    // the vitest interop, failing instanceof for the same class.
    it("'replay' returns a ReplaySource", () => {
        expect(telemetrySourceFor({ source: 'replay', port: '' }).constructor.name).toBe('ReplaySource');
    });

    it("'crsf-serial' returns a CrsfSerialSource on the configured port", () => {
        const s = telemetrySourceFor({ source: 'crsf-serial', port: 'COM9' }, { platform: 'win32' });
        expect(s.constructor.name).toBe('CrsfSerialSource');
        expect(s._path).toBe('COM9');
    });

    it("'crsf-serial' with no port falls to the platform default (COM5 / /dev/ttyUSB0)", () => {
        expect(telemetrySourceFor({ source: 'crsf-serial', port: '' }, { platform: 'win32' })._path).toBe('COM5');
        expect(telemetrySourceFor({ source: 'crsf-serial', port: '' }, { platform: 'darwin' })._path).toBe('/dev/ttyUSB0');
    });
});

// ---------- session applier: env + settings -> runtime effects ----------

describe('createSessionApplier — startup and effective configuration (audit D2)', () => {
    it('clean first boot: defaults apply — no telemetry source, no W2 bridge, W3 wish off', () => {
        const t = makeApplier();
        try {
            const applied = t.applier.apply();
            expect(applied).toEqual({ telemetry: 'none', iphoneBridge: false, w3: false });
            expect(t.sources).toEqual([]);
            expect(t.bridges).toEqual([]);
            const eff = t.applier.effective();
            expect(eff.envOverridden).toEqual({
                telemetrySource: false, telemetryPort: false, iphoneBridge: false, w3: false,
            });
            expect(t.w3Spy).toHaveBeenCalledWith(eff);
        } finally { t.cleanup(); }
    });

    it('a corrupted settings.json degrades to defaults — boot never throws', () => {
        const t = makeApplier({ seed: '{"fpvMode": "iphone-hud", "iphoneAddr": ' }); // truncated JSON
        try {
            const applied = t.applier.apply();
            expect(applied).toEqual({ telemetry: 'none', iphoneBridge: false, w3: false });
        } finally { t.cleanup(); }
    });

    it('effective() is null before the first apply (config:get answers conservatively)', () => {
        const t = makeApplier();
        try {
            expect(t.applier.effective()).toBeNull();
        } finally { t.cleanup(); }
    });

    it('iPhone mode with a confirmed target starts W2 with the persisted addr/port', () => {
        const t = makeApplier({ seed: IPHONE_SETTINGS });
        try {
            const applied = t.applier.apply();
            expect(applied.iphoneBridge).toBe(true);
            expect(t.bridges.length).toBe(1);
            expect(t.bridges[0].cfg).toEqual({ addr: '192.168.137.2', port: 5601, rateHz: 10 });
            expect(t.bridges[0].started).toBe(1);
            expect(t.bridges[0].extra).toEqual({ demo: false });
        } finally { t.cleanup(); }
    });

    it('desktop (solo) mode never starts W2, even with an address saved', () => {
        const t = makeApplier({ seed: JSON.stringify({ fpvMode: 'solo', iphoneAddr: '192.168.137.2' }) });
        try {
            expect(t.applier.apply().iphoneBridge).toBe(false);
            expect(t.bridges).toEqual([]);
        } finally { t.cleanup(); }
    });

    it('iPhone mode WITHOUT a confirmed target does not start W2 (no half-config)', () => {
        const t = makeApplier({ seed: JSON.stringify({ fpvMode: 'iphone-hud', iphoneAddr: '' }) });
        try {
            expect(t.applier.apply().iphoneBridge).toBe(false);
            expect(t.bridges).toEqual([]);
        } finally { t.cleanup(); }
    });

    it('W17_IPHONE_BRIDGE=0 force-disables a settings-enabled bridge (explicit env off wins)', () => {
        const t = makeApplier({ seed: IPHONE_SETTINGS, env: { W17_IPHONE_BRIDGE: '0' } });
        try {
            expect(t.applier.apply().iphoneBridge).toBe(false);
            expect(t.bridges).toEqual([]);
            expect(t.applier.effective().envOverridden.iphoneBridge).toBe(true);
        } finally { t.cleanup(); }
    });

    it('repeated apply is idempotent: one bridge, one source, never restarted (GRID re-entry)', () => {
        const t = makeApplier({ seed: IPHONE_SETTINGS, env: { W17_TELEMETRY_SOURCE: 'replay' } });
        try {
            t.applier.apply();
            t.applier.apply();
            t.applier.apply();
            expect(t.bridges.length).toBe(1);
            expect(t.bridges[0].started).toBe(1);
            expect(t.bridges[0].stopped).toBe(0);
            expect(t.sources.length).toBe(1);
            expect(t.sources[0].started).toBe(1);
        } finally { t.cleanup(); }
    });

    it('a target-IP change rekeys W2: the old sender stops, exactly one new one starts', () => {
        const t = makeApplier({ seed: IPHONE_SETTINGS });
        try {
            t.applier.apply();
            t.settingsStore.save({ iphoneAddr: '192.168.137.9' });
            t.applier.apply();
            expect(t.bridges.length).toBe(2);
            expect(t.bridges[0].stopped).toBe(1); // old sender gone — no duplicate stream
            expect(t.bridges[1].cfg.addr).toBe('192.168.137.9');
            expect(t.bridges[1].started).toBe(1);
            expect(t.bridges[1].stopped).toBe(0);
        } finally { t.cleanup(); }
    });

    it('replay source tags the bridge demo:true; a runtime source switch re-keys the bridge honestly', () => {
        const t = makeApplier({ seed: IPHONE_SETTINGS });
        try {
            t.applier.apply();
            expect(t.bridges[0].extra).toEqual({ demo: false });
            t.settingsStore.save({ telemetry: { source: 'replay' } });
            t.applier.apply();
            expect(t.sources.length).toBe(1);
            expect(t.sources[0].cfg.source).toBe('replay');
            // demo rides the bridge key, so the sender restarts with the tag.
            expect(t.bridges.length).toBe(2);
            expect(t.bridges[1].extra).toEqual({ demo: true });
        } finally { t.cleanup(); }
    });

    it('partial env lock: only the overridden field reads locked (port yes, source no)', () => {
        const t = makeApplier({ env: { W17_TELEMETRY_PORT: 'COM7' } });
        try {
            t.applier.apply();
            const eff = t.applier.effective();
            expect(eff.envOverridden.telemetryPort).toBe(true);
            expect(eff.envOverridden.telemetrySource).toBe(false);
            expect(eff.telemetry.port).toBe('COM7');
        } finally { t.cleanup(); }
    });

    it('the applyW3 seam receives the resolved effective config and its answer is the summary w3', () => {
        const applyW3 = vi.fn(() => true);
        const t = makeApplier({ env: { W17_HEADTRACK: '1' }, applyW3 });
        try {
            const applied = t.applier.apply();
            expect(applied.w3).toBe(true);
            expect(applyW3).toHaveBeenCalledTimes(1);
            expect(applyW3.mock.calls[0][0].envOverridden.w3).toBe(true);
        } finally { t.cleanup(); }
    });
});

// ---------- keyed instance: the W3 receiver's restart choreography ----------

describe('createKeyedInstance — idempotent keyed restart (audit D2, the W3 holder)', () => {
    function harness() {
        const events = [];
        const made = [];
        const holder = createKeyedInstance({
            construct: (cfg) => {
                events.push('construct');
                const inst = {
                    cfg,
                    started: 0,
                    stopped: 0,
                    start() { this.started += 1; events.push('start'); },
                    stop() { this.stopped += 1; events.push('stop'); },
                };
                made.push(inst);
                return inst;
            },
        });
        return { holder, events, made };
    }

    it('re-applying an identical config keeps the same instance running (no restart on GRID re-entry)', () => {
        const { holder, made } = harness();
        expect(holder.apply({ port: 5602, staleMs: 300 })).toBe(true);
        expect(holder.apply({ port: 5602, staleMs: 300 })).toBe(true);
        expect(holder.apply({ port: 5602, staleMs: 300 })).toBe(true);
        expect(made.length).toBe(1);
        expect(made[0].started).toBe(1);
        expect(made[0].stopped).toBe(0);
    });

    it('a changed config stops the OLD instance before constructing the new one', () => {
        const { holder, events, made } = harness();
        holder.apply({ port: 5602 });
        holder.apply({ port: 5700 });
        expect(events).toEqual(['construct', 'start', 'stop', 'construct', 'start']);
        expect(made.length).toBe(2);
        expect(made[0].stopped).toBe(1);
        expect(made[1].cfg).toEqual({ port: 5700 });
        expect(made[1].stopped).toBe(0);
    });

    it('a null config stops and clears; repeated null stays stopped (idempotent off — the teardown path)', () => {
        const { holder, made } = harness();
        holder.apply({ port: 5602 });
        expect(holder.apply(null)).toBe(false);
        expect(made[0].stopped).toBe(1);
        expect(holder.apply(null)).toBe(false); // no second stop, no construct
        expect(made.length).toBe(1);
        expect(made[0].stopped).toBe(1);
        expect(holder.active()).toBe(false);
    });

    it('off -> on -> off -> on creates exactly one instance per on-phase', () => {
        const { holder, made } = harness();
        expect(holder.apply(null)).toBe(false); // starts off: nothing constructed
        holder.apply({ port: 5602 });
        holder.apply(null);
        holder.apply({ port: 5602 });
        expect(made.length).toBe(2);
        expect(made.every((i) => i.started === 1)).toBe(true);
        expect(holder.active()).toBe(true);
    });
});

// ---------- IPC surface: registration + delegation + answer scope ----------

function makeServices(t, overrides = {}) {
    return {
        whepUrl: 'http://127.0.0.1:8889/cam/whep',
        platform: 'win32',
        feel: { gears: 4 },
        runtime: t.runtime,
        settingsStore: t.settingsStore,
        sessionApplier: t.applier,
        w3Active: () => false,
        wifi: { capabilities: vi.fn(() => ({ platform: 'win32', canScan: true, canJoin: true })), listInterfaces: vi.fn(), scan: vi.fn(), join: vi.fn(), status: vi.fn() },
        sim: false,
        hotspotLifecycle: { start: vi.fn(), stop: vi.fn(), snapshot: vi.fn(), probe: vi.fn() },
        addrHint: { get: vi.fn(() => null), note: () => {} },
        hostProbe: { probe: vi.fn() },
        elrs: { detectRunning: vi.fn(), launchDetached: vi.fn() },
        ...overrides,
    };
}

describe('registerIpcHandlers — delegation and renderer-visible answers (audit D2)', () => {
    it('registers every channel exactly once on a strict ipcMain (duplicate registration throws)', () => {
        const t = makeApplier();
        try {
            const ipc = fakeIpcMain();
            const { invokeChannels, sendChannels } = registerIpcHandlers({ ipcMain: ipc, services: makeServices(t) });
            expect(invokeChannels.length).toBe(ipc.handlers.size);
            expect(sendChannels).toEqual(['command-mirror']);
        } finally { t.cleanup(); }
    });

    it('config:get answers conservatively before the first apply and truthfully after it', async () => {
        const t = makeApplier({ seed: JSON.stringify({ setupCompleted: true }), env: { W17_TELEMETRY_SOURCE: 'replay' } });
        try {
            const ipc = fakeIpcMain();
            registerIpcHandlers({ ipcMain: ipc, services: makeServices(t) });
            const before = await ipc.invoke('config:get');
            expect(before).toMatchObject({ telemetrySource: 'none', setupCompleted: false, envOverridden: {} });
            t.applier.apply();
            const after = await ipc.invoke('config:get');
            expect(after.telemetrySource).toBe('replay');
            expect(after.setupCompleted).toBe(true);
            expect(after.envOverridden.telemetrySource).toBe(true);
            // The answer surface is pinned: adding a field is a deliberate act.
            expect(Object.keys(after).sort()).toEqual([
                'envOverridden', 'feel', 'hasTelemetrySource', 'platform',
                'setupCompleted', 'telemetrySource', 'w3Active', 'whepUrl',
            ]);
        } finally { t.cleanup(); }
    });

    it('settings:get exposes ONLY the three effective display fields — no secret rides the metadata', async () => {
        const t = makeApplier({
            seed: JSON.stringify({ network: { hotspot: { ssid: 'W17-GRID', password: 'grid-secret-1' } } }),
        });
        try {
            const ipc = fakeIpcMain();
            registerIpcHandlers({ ipcMain: ipc, services: makeServices(t) });
            t.applier.apply();
            const res = await ipc.invoke('settings:get');
            expect(Object.keys(res.effective).sort()).toEqual(['telemetryPort', 'telemetrySource', 'w3']);
            // The persisted hotspot password reaches the renderer ONLY inside
            // settings.network.hotspot (the PIT WALL pre-fill; E1 owns its
            // storage policy) — never in the effective/env metadata.
            expect(JSON.stringify(res.effective)).not.toContain('grid-secret-1');
            expect(JSON.stringify(res.envOverridden)).not.toContain('grid-secret-1');
            expect(res.settings.network.hotspot.password).toBe('grid-secret-1');
            // audit E1: the non-secret credential status rides settings:get, and
            // it carries NEITHER the value NOR any ciphertext/safeStorage detail.
            expect(Object.keys(res.credential).sort()).toEqual(['encryptionAvailable', 'hasPassword', 'state']);
            const credJson = JSON.stringify(res.credential);
            expect(credJson).not.toContain('grid-secret-1');
            expect(credJson).not.toContain('w17cred:');
            expect(credJson).not.toContain('passwordEnc');
            // No ciphertext token anywhere in the whole settings:get answer.
            expect(JSON.stringify(res)).not.toContain('w17cred:');
        } finally { t.cleanup(); }
    });

    it('settings:set saves through the store; session:apply re-resolves — the C3 lock flow end-to-end', async () => {
        const t = makeApplier({ env: { W17_TELEMETRY_SOURCE: 'replay' } });
        try {
            const ipc = fakeIpcMain();
            registerIpcHandlers({ ipcMain: ipc, services: makeServices(t) });
            await ipc.invoke('settings:set', { telemetry: { source: 'crsf-serial', port: 'COM7' } });
            const applied = await ipc.invoke('session:apply');
            // env lock wins for the source; the unlocked port persisted.
            expect(applied.telemetry).toBe('replay');
            expect(t.applier.effective().telemetry.port).toBe('COM7');
            expect(t.settingsStore.load().telemetry.source).toBe('crsf-serial'); // persisted, inert while locked
        } finally { t.cleanup(); }
    });

    it('hotspot channels delegate 1:1 to the lifecycle authority with defaulted opts', async () => {
        const t = makeApplier();
        try {
            const ipc = fakeIpcMain();
            const services = makeServices(t);
            registerIpcHandlers({ ipcMain: ipc, services });
            await ipc.invoke('wifi:hotspot-start', { ssid: 'W17-GRID', password: 'x' });
            await ipc.invoke('wifi:hotspot-start');
            await ipc.invoke('wifi:hotspot-stop');
            await ipc.invoke('wifi:hotspot-state');
            await ipc.invoke('wifi:hotspot-probe', { refresh: true });
            await ipc.invoke('wifi:hotspot-probe');
            const lc = services.hotspotLifecycle;
            expect(lc.start).toHaveBeenNthCalledWith(1, { ssid: 'W17-GRID', password: 'x' });
            expect(lc.start).toHaveBeenNthCalledWith(2, {});
            expect(lc.stop).toHaveBeenCalledTimes(1);
            expect(lc.snapshot).toHaveBeenCalledTimes(1);
            expect(lc.probe).toHaveBeenNthCalledWith(1, { refresh: true });
            expect(lc.probe).toHaveBeenNthCalledWith(2, {});
        } finally { t.cleanup(); }
    });

    it('elrs channels read the CURRENT persisted path on every call (no stale capture)', async () => {
        const t = makeApplier();
        try {
            const ipc = fakeIpcMain();
            const services = makeServices(t);
            registerIpcHandlers({ ipcMain: ipc, services });
            await ipc.invoke('elrs:status');
            expect(services.elrs.detectRunning).toHaveBeenLastCalledWith('');
            t.settingsStore.save({ elrsPath: 'C:/elrs/elrs-joystick-control.exe' });
            await ipc.invoke('elrs:status');
            expect(services.elrs.detectRunning).toHaveBeenLastCalledWith('C:/elrs/elrs-joystick-control.exe');
            await ipc.invoke('elrs:launch');
            expect(services.elrs.launchDetached).toHaveBeenCalledWith('C:/elrs/elrs-joystick-control.exe');
        } finally { t.cleanup(); }
    });

    it('setup helpers delegate: probe-host gets the addr, addr-hint returns the store answer', async () => {
        const t = makeApplier();
        try {
            const ipc = fakeIpcMain();
            const services = makeServices(t, {
                addrHint: { get: vi.fn(() => ({ addr: '10.0.0.7', ageMs: 120 })), note: () => {} },
            });
            registerIpcHandlers({ ipcMain: ipc, services });
            await ipc.invoke('setup:probe-host', '10.0.0.7');
            expect(services.hostProbe.probe).toHaveBeenCalledWith('10.0.0.7');
            expect(await ipc.invoke('setup:addr-hint')).toEqual({ addr: '10.0.0.7', ageMs: 120 });
        } finally { t.cleanup(); }
    });

    it('command-mirror is a one-way ipcMain.on listener forwarding to the runtime only', () => {
        const t = makeApplier({ seed: IPHONE_SETTINGS });
        try {
            const ipc = fakeIpcMain();
            registerIpcHandlers({ ipcMain: ipc, services: makeServices(t) });
            t.applier.apply();
            const onMirror = vi.spyOn(t.bridges[0], 'onCommandMirror');
            const mirror = { throttle: 0.4, brake: 0, steering: -0.2, videoPlaying: true };
            const result = ipc.emit('command-mirror', mirror);
            expect(onMirror).toHaveBeenCalledWith(mirror);
            expect(result).toBeUndefined(); // nothing is answered back on this channel
        } finally { t.cleanup(); }
    });
});

// ---------- hotspot push + quit-policy wiring ----------

describe('wireHotspotPush — authoritative snapshots to the renderer channel (audit D2)', () => {
    const okRes = (stdout) => ({ ok: true, code: 0, stdout, stderr: '' });
    const routedRun = async (cmd, args) => {
        const key = `${cmd} ${args.join(' ')}`;
        if (key.includes('StartTetheringAsync')) return okRes('START_OK');
        if (key.includes('StopTetheringAsync')) return okRes('STOP_OK');
        return okRes('PROBE_STATE_Off\nPROBE_OK');
    };

    it('every lifecycle change is broadcast on PUSH_CHANNELS.hotspotState with a strictly rising seq', async () => {
        const manager = new HotspotManager({ run: routedRun, platform: 'win32' });
        const lifecycle = new HotspotLifecycle({ manager });
        const pushes = [];
        const unwire = wireHotspotPush({
            lifecycle,
            broadcast: (channel, snap) => pushes.push({ channel, snap }),
        });
        await lifecycle.start({ ssid: 'W17-GRID', password: 'lights0ut' });
        await lifecycle.stop();
        expect(pushes.length).toBeGreaterThanOrEqual(4); // starting, live, stopping, inactive
        expect(pushes.every((p) => p.channel === PUSH_CHANNELS.hotspotState)).toBe(true);
        const seqs = pushes.map((p) => p.snap.seq);
        expect([...seqs].sort((a, b) => a - b)).toEqual(seqs); // causal order at the source
        expect(pushes.map((p) => p.snap.phase)).toEqual(['starting', 'live', 'stopping', 'inactive']);
        // No snapshot ever carries the password.
        expect(JSON.stringify(pushes)).not.toContain('lights0ut');
        unwire();
        await lifecycle.start({ ssid: 'W17-GRID', password: 'lights0ut' });
        expect(pushes.map((p) => p.snap.phase)).toEqual(['starting', 'live', 'stopping', 'inactive']); // unwired: no further pushes
    });

    it('push channel names match the preload subscription channels exactly', () => {
        expect(PUSH_CHANNELS).toEqual({ telemetry: 'telemetry', hotspotState: 'hotspot-state' });
    });
});

// ---------- window options + navigation policy (audit D3 security surface) ----------

describe('createWindowOptions — sandboxed renderer invariants (audit D3)', () => {
    it('pins contextIsolation ON, nodeIntegration OFF, sandbox ON, preload as given', () => {
        const opts = createWindowOptions({ preloadPath: '/app/main/preload.cjs' });
        expect(opts.webPreferences).toEqual({
            preload: '/app/main/preload.cjs',
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        });
        expect(opts).toMatchObject({ width: 1280, height: 720, backgroundColor: '#000000', autoHideMenuBar: true });
        expect('icon' in opts).toBe(false);
    });

    it('includes the icon only when a path is supplied', () => {
        expect(createWindowOptions({ preloadPath: '/p', iconPath: '/app/build/icon.png' }).icon)
            .toBe('/app/build/icon.png');
    });
});

describe('installNavigationPolicy — one local page, no popups, no navigation (audit D3)', () => {
    function fakeWebContents() {
        const events = new Map();
        return {
            openHandler: null,
            setWindowOpenHandler(fn) { this.openHandler = fn; },
            on(ev, fn) { events.set(ev, fn); },
            emit(ev, ...args) { return events.get(ev)(...args); },
        };
    }

    it('window.open is denied for any URL', () => {
        const wc = fakeWebContents();
        const log = vi.fn();
        installNavigationPolicy(wc, { log });
        expect(wc.openHandler({ url: 'https://example.com' })).toEqual({ action: 'deny' });
        expect(wc.openHandler({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' });
        expect(log).toHaveBeenCalled();
    });

    it('renderer-initiated navigation is prevented (loadFile from main is unaffected by design)', () => {
        const wc = fakeWebContents();
        installNavigationPolicy(wc, { log: () => {} });
        const event = { preventDefault: vi.fn() };
        wc.emit('will-navigate', event, 'https://evil.example');
        expect(event.preventDefault).toHaveBeenCalledTimes(1);
        const local = { preventDefault: vi.fn() };
        wc.emit('will-navigate', local, 'file:///anything.html');
        expect(local.preventDefault).toHaveBeenCalledTimes(1); // the page never navigates itself
    });
});

// ---------- shutdown ----------

describe('createTeardown — failure-isolated, idempotent shutdown (audit D2)', () => {
    it('runs every step once, in order', () => {
        const calls = [];
        const teardown = createTeardown({
            steps: [
                ['a', () => calls.push('a')],
                ['b', () => calls.push('b')],
                ['c', () => calls.push('c')],
            ],
        });
        teardown();
        expect(calls).toEqual(['a', 'b', 'c']);
    });

    it('repeated shutdown is a no-op (owned resources close exactly once)', () => {
        const stop = vi.fn();
        const teardown = createTeardown({ steps: [['only', stop]] });
        teardown();
        teardown();
        teardown();
        expect(stop).toHaveBeenCalledTimes(1);
    });

    it('a throwing step is logged and the remaining children still stop (no orphaned mediamtx)', () => {
        const log = vi.fn();
        const later = vi.fn();
        const teardown = createTeardown({
            steps: [
                ['broken', () => { throw new Error('socket already closed'); }],
                ['mediamtx', later],
            ],
            log,
        });
        teardown();
        expect(later).toHaveBeenCalledTimes(1);
        expect(log.mock.calls.flat().join('\n')).toContain('broken');
    });

    it('W2/W3-style stops close safely through the seam: the real SessionRuntime stopAll is step-safe', () => {
        const t = makeApplier({ seed: IPHONE_SETTINGS });
        try {
            t.applier.apply();
            const teardown = createTeardown({ steps: [['session runtime', () => t.runtime.stopAll()]] });
            teardown();
            expect(t.bridges[0].stopped).toBe(1);
            teardown(); // idempotent: not stopped twice
            expect(t.bridges[0].stopped).toBe(1);
        } finally { t.cleanup(); }
    });
});

// ---------- mediamtx paths ----------

describe('mediamtxPaths — dev / packaged / override resolution (audit D3 smoke seam)', () => {
    it('dev build resolves next to the project root', () => {
        const p = mediamtxPaths({ env: {}, platform: 'darwin', isPackaged: false, projectRoot: '/repo' });
        expect(p).toEqual({ binaryPath: join('/repo', 'mediamtx', 'mediamtx'), configPath: join('/repo', 'mediamtx', 'mediamtx.yml') });
    });

    it('packaged build resolves under resourcesPath, with the .exe name on win32', () => {
        const p = mediamtxPaths({ env: {}, platform: 'win32', isPackaged: true, resourcesPath: '/res', projectRoot: '/repo' });
        expect(p.binaryPath).toBe(join('/res', 'mediamtx', 'mediamtx.exe'));
    });

    it('W17_MEDIAMTX_DIR overrides both paths (the smoke uses an empty dir for the soft-fail scenario)', () => {
        const p = mediamtxPaths({ env: { W17_MEDIAMTX_DIR: '/tmp/none' }, platform: 'win32', isPackaged: false, projectRoot: '/repo' });
        expect(p).toEqual({ binaryPath: join('/tmp/none', 'mediamtx.exe'), configPath: join('/tmp/none', 'mediamtx.yml') });
    });
});
