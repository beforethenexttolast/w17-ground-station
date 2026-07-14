// Dependency-injected wiring seams for the Electron main process (audit D2).
// main.js stays the composition root and the ONLY sanctioned wiring point for
// the W3 head-tracking receiver — nothing here references head-tracking, and
// the no-control-path directory sweep keeps it that way. These factories exist
// so the integration seams (env -> services, services -> IPC surface, push
// channels, window options, shutdown) unit-test with fakes instead of booting
// Electron, while production behavior stays byte-equivalent.
//
// Nothing in this module may grow a control path: it wires the same viewer
// services main.js always constructed, and the IPC surface it registers is
// exactly the preload contract (test/ipcSurface.test.js pins the symmetry).

const path = require('node:path');

const { ReplaySource } = require('../shared/replaySource.js');
const { CrsfSerialSource } = require('./CrsfSerialSource.js');
const { WifiManager } = require('./wifiManager.js');
const { HotspotManager } = require('./hotspot.js');
const { HotspotLifecycle } = require('./hotspotLifecycle.js');
const { simScenario, createSimRun } = require('./wifiSim.js');
const { resolveEffective } = require('../shared/settings.js');

// The two main -> renderer push channels. The preload subscribes to exactly
// these names (ipcSurface test pins both directions); main.js sends through
// these constants so the strings cannot drift apart silently.
const PUSH_CHANNELS = Object.freeze({
    telemetry: 'telemetry',
    hotspotState: 'hotspot-state',
});

// Setup-flow platform services (thin IO; all soft-fail with reasons). With
// W17_WIFI_SIM set (dev preview only) both managers run against the canned
// netsh/powershell runner from wifiSim.js — same managers, same parsers, no
// OS. The hotspot lifecycle authority is constructed HERE so the composition
// root hands the SAME instance to the IPC handlers, the state push, and the
// quit policy — there is exactly one runtime hotspot truth.
function createNetworkServices({ env = process.env, log = () => {} } = {}) {
    const scenario = simScenario(env, log);
    const simRun = scenario ? createSimRun(scenario, log) : null;
    const wifi = simRun
        ? new WifiManager({ run: simRun, platform: 'win32', log })
        : new WifiManager({ log });
    const hotspot = simRun
        ? new HotspotManager({ run: simRun, platform: 'win32', log })
        : new HotspotManager({ log });
    const hotspotLifecycle = new HotspotLifecycle({ manager: hotspot, log });
    return { wifi, hotspot, hotspotLifecycle, sim: !!simRun };
}

// Telemetry source selection from the EFFECTIVE config (post env-override).
// 'none' returns null: the HUD runs fully on gamepad + display model.
function telemetrySourceFor(cfg, { platform = process.platform, log = () => {} } = {}) {
    if (cfg.source === 'replay') return new ReplaySource();
    if (cfg.source === 'crsf-serial') {
        // Real battery + link-quality over the ELRS backchannel (docs/TELEMETRY.md).
        return new CrsfSerialSource({
            path: cfg.port || (platform === 'win32' ? 'COM5' : '/dev/ttyUSB0'),
            log,
        });
    }
    return null;
}

// The apply-session seam: persisted settings + env -> effective config ->
// session runtime, with the resolved effective config retained for the
// config/settings IPC answers. applyW3 is INJECTED by main.js (the sanctioned
// W3 wiring point) and returns the receiver-exists boolean the summary carries.
// Precedence lives entirely in shared/settings.js resolveEffective — an env
// var that is SET wins (including explicit force-off values); unset falls
// through to persisted settings.
function createSessionApplier({ settingsStore, runtime, env = process.env, applyW3 = () => false, warn = () => {} }) {
    let lastEffective = null;
    return {
        apply() {
            const settings = settingsStore.load();
            lastEffective = resolveEffective(settings, env, warn);
            const applied = runtime.applyConfig(lastEffective);
            const w3 = applyW3(lastEffective);
            return { ...applied, w3 };
        },
        effective: () => lastEffective,
    };
}

// Keyed single-instance holder (audit D2): (re)applies a config-derived
// instance, keeping the running one while the config key is unchanged
// (idempotent re-apply — a GRID re-entry must not restart it), stopping the
// old instance BEFORE constructing the new on a change, and stopping outright
// on a null config. main.js uses this for the W3 receiver, so the restart
// choreography is testable with fakes while CONSTRUCTION stays at the one
// sanctioned wiring site — this module never names the receiver and carries
// no data path: it only holds, starts, and stops what `construct` returns.
function createKeyedInstance({ construct, keyOf = (cfg) => JSON.stringify(cfg) }) {
    let instance = null;
    let key = null;
    return {
        apply(cfg) {
            const nextKey = cfg ? keyOf(cfg) : null;
            if (nextKey === key) return !!instance;
            if (instance) {
                instance.stop();
                instance = null;
            }
            key = nextKey;
            if (cfg) {
                instance = construct(cfg);
                instance.start();
            }
            return !!instance;
        },
        active: () => !!instance,
    };
}

// mediamtx location: next to the app in dev, an unpacked extraResource in the
// packaged build, or an explicit W17_MEDIAMTX_DIR override (points at a
// directory containing the binary + mediamtx.yml — used by the boot smoke to
// exercise the missing-binary soft-fail deterministically, and available for
// a custom install location). A missing binary is ALWAYS a soft-fail: the
// supervisor logs and video stays off while HUD + telemetry keep working.
function mediamtxPaths({ env = process.env, platform = process.platform, isPackaged = false, resourcesPath = '', projectRoot }) {
    const exe = platform === 'win32' ? 'mediamtx.exe' : 'mediamtx';
    if (env.W17_MEDIAMTX_DIR) {
        return {
            binaryPath: path.join(env.W17_MEDIAMTX_DIR, exe),
            configPath: path.join(env.W17_MEDIAMTX_DIR, 'mediamtx.yml'),
        };
    }
    const base = isPackaged ? resourcesPath : projectRoot;
    return {
        binaryPath: path.join(base, 'mediamtx', exe),
        configPath: path.join(base, 'mediamtx', 'mediamtx.yml'),
    };
}

// The renderer-facing IPC surface. ONE registration site, driven by injected
// services, so tests can register into a fake ipcMain and prove: every preload
// invoke channel has a handler, every handler is consumed, handlers delegate
// exactly once, and no renderer-visible answer carries a credential beyond the
// documented settings payload (E1 territory). Returns the registered channel
// names for the symmetry test.
function registerIpcHandlers({ ipcMain, services }) {
    const {
        whepUrl, platform, feel, runtime, settingsStore, sessionApplier,
        w3Active, wifi, sim, hotspotLifecycle, addrHint, hostProbe, elrs,
    } = services;

    const handle = new Map();
    const on = new Map();
    const reg = (channel, fn) => {
        if (handle.has(channel)) throw new Error(`duplicate ipc handler: ${channel}`);
        handle.set(channel, fn);
        ipcMain.handle(channel, fn);
    };
    const regOn = (channel, fn) => {
        if (on.has(channel)) throw new Error(`duplicate ipc listener: ${channel}`);
        on.set(channel, fn);
        ipcMain.on(channel, fn);
    };

    reg('config:get', () => {
        const effective = sessionApplier.effective();
        return {
            whepUrl,
            hasTelemetrySource: runtime.hasTelemetrySource(),
            // Effective telemetry source (post env-override) for the HUD replay
            // chip (audit C2): 'replay' shows TELEMETRY · REPLAY at HUD boot.
            telemetrySource: effective ? effective.telemetry.source : 'none',
            platform,
            setupCompleted: effective ? effective.ui.setupCompleted : false,
            envOverridden: effective ? effective.envOverridden : {},
            // W3 receiver EXISTENCE only, for the LOG-ONLY status chip — the
            // same boolean applySession returns. Never receiver data.
            w3Active: w3Active(),
            feel,
        };
    });

    reg('settings:get', () => {
        const effective = sessionApplier.effective();
        return {
            settings: settingsStore.load(),
            envOverridden: effective ? effective.envOverridden : {},
            // Effective values for the env-locked ⚙ controls (audit C3): the ⚙
            // menu shows THESE (not the ignored persisted values) when locked.
            // Deliberately narrow — three display fields, nothing else rides in.
            effective: effective
                ? {
                    telemetrySource: effective.telemetry.source,
                    telemetryPort: effective.telemetry.port,
                    w3: w3Active(),
                }
                : {},
        };
    });

    reg('settings:set', (_event, patch) => settingsStore.save(patch));

    reg('session:apply', () => sessionApplier.apply());

    // --- PIT WALL: WiFi + hotspot (Windows-only; guide mode elsewhere) ---
    // Capabilities answer instantly (audit N3): the slow WinRT hotspot probe is
    // its own non-blocking channel below, so PIT WALL renders immediately.
    reg('wifi:capabilities', () => ({ ...wifi.capabilities(), sim }));
    reg('wifi:interfaces', () => wifi.listInterfaces());
    reg('wifi:scan', (_event, opts) => wifi.scan(opts || {}));
    reg('wifi:join', (_event, opts) => wifi.join(opts || {}));
    reg('wifi:status', () => wifi.status());
    // Hotspot runtime: every mutation and read goes through the lifecycle
    // authority; the renderer mirrors its snapshots (query + 'hotspot-state'
    // pushes) and never derives ownership from its own DOM.
    reg('wifi:hotspot-start', (_event, opts) => hotspotLifecycle.start(opts || {}));
    reg('wifi:hotspot-stop', () => hotspotLifecycle.stop());
    reg('wifi:hotspot-state', () => hotspotLifecycle.snapshot());
    reg('wifi:hotspot-probe', (_event, opts) => hotspotLifecycle.probe(opts || {}));

    // --- Setup helpers: address suggestion + reachability ---
    reg('setup:addr-hint', () => addrHint.get());
    reg('setup:probe-host', (_event, addr) => hostProbe.probe(addr));

    // --- GRID: elrs-joystick-control (launch-only; this app NEVER stops it) ---
    reg('elrs:status', () => elrs.detectRunning(settingsStore.load().elrsPath));
    reg('elrs:launch', () => elrs.launchDetached(settingsStore.load().elrsPath));

    // Read-only display mirror from the renderer (throttle/brake/steering/camera
    // as drawn on the HUD) -- forwarded outward to the iPhone bridge only. This
    // is one-way: nothing is sent back, and no control state is touched.
    regOn('command-mirror', (_event, mirror) => {
        runtime.onCommandMirror(mirror);
    });

    return { invokeChannels: [...handle.keys()], sendChannels: [...on.keys()] };
}

// Forward every lifecycle snapshot to the renderer push channel. `broadcast`
// is injected (webContents.send over all live windows in the app, a spy in
// tests); the channel name comes from PUSH_CHANNELS so it cannot drift from
// the preload subscription. Returns the lifecycle's unsubscribe.
function wireHotspotPush({ lifecycle, broadcast }) {
    return lifecycle.onChange((snap) => broadcast(PUSH_CHANNELS.hotspotState, snap));
}

// BrowserWindow construction options (audit D3 security surface). The renderer
// is fully sandboxed: context isolation ON, node integration OFF, sandbox ON,
// and the ONLY bridge is the preload. Tests pin these so a convenience edit
// (e.g. flipping nodeIntegration on to debug) cannot land silently.
function createWindowOptions({ preloadPath, iconPath = null }) {
    return {
        width: 1280,
        height: 720,
        backgroundColor: '#000000',
        autoHideMenuBar: true,
        ...(iconPath ? { icon: iconPath } : {}),
        webPreferences: {
            preload: preloadPath,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    };
}

// Navigation policy (audit D3): this window shows exactly one local page. The
// renderer never opens child windows and never navigates, so both are denied
// outright — a compromised or confused page cannot pop a window or leave for
// an external URL. loadFile/loadURL from the main process do not fire
// will-navigate, so the initial load is unaffected.
function installNavigationPolicy(webContents, { log = () => {} } = {}) {
    webContents.setWindowOpenHandler(({ url }) => {
        log(`[window] blocked window.open -> ${url}`);
        return { action: 'deny' };
    });
    webContents.on('will-navigate', (event, url) => {
        log(`[window] blocked navigation -> ${url}`);
        event.preventDefault();
    });
}

// Shutdown seam (audit D2): runs each [label, fn] step exactly once, isolating
// failures so one throwing stop can never orphan the remaining children (the
// old inline will-quit chain stopped at the first throw). Repeated calls are
// no-ops. The hotspot is DELIBERATELY not a step anywhere: its shutdown is the
// quit policy's decision (Q1), never an implicit teardown.
function createTeardown({ steps, log = () => {} }) {
    let done = false;
    return () => {
        if (done) return;
        done = true;
        for (const [label, fn] of steps) {
            try {
                fn();
            } catch (err) {
                log(`[shutdown] ${label} stop failed: ${err && err.message ? err.message : err}`);
            }
        }
    };
}

module.exports = {
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
};
