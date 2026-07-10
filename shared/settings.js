// Pure settings model for the pre-ride setup flow. CommonJS, Electron-free.
//
// Two jobs, both side-effect free so they unit-test with plain objects:
//   normalizeSettings(raw)          -> a complete, type-safe settings object
//   resolveEffective(settings, env) -> per-subsystem runtime config with the
//                                      precedence rule: AN ENV VAR THAT IS SET
//                                      ALWAYS WINS for its subsystem; unset
//                                      falls through to persisted settings.
// The existing pure env resolver (main/iphoneBridgeConfig.js) stays the single
// source of truth for the bridge's defaults — resolveEffective delegates to it
// rather than duplicating semantics.
//
// The W3 diagnostic receiver is deliberately NOT resolved here: this module
// only carries the user's on/off wish (`w3DiagnosticEnabled`) and whether env
// overrides it. main.js — the one sanctioned wiring point for that receiver —
// turns the wish into a config. That keeps this file importable by anything
// without weakening the no-control-path module-graph guards.

const { iphoneBridgeConfigFromEnv } = require('../main/iphoneBridgeConfig.js');

const FPV_MODES = ['solo', 'iphone-hud'];
const NETWORK_KINDS = ['join', 'hotspot', 'guide'];
const CONTROLLER_PRESETS = ['dualshock', 'xbox', 'generic'];
const TELEMETRY_SOURCES = ['none', 'replay', 'crsf-serial'];

const SETTINGS_VERSION = 1;

const DEFAULT_SETTINGS = Object.freeze({
    version: SETTINGS_VERSION,
    setupCompleted: false,
    fpvMode: 'solo',
    network: Object.freeze({
        kind: 'guide',
        ssid: '',
        adapter: '', // preferred WLAN interface name ('' = system default)
        hotspot: Object.freeze({ ssid: 'W17-GRID', password: '' }),
    }),
    iphoneAddr: '',
    iphonePort: 5601,
    controller: Object.freeze({ id: '', preset: 'dualshock' }),
    soundEnabled: false, // radio sounds are opt-in by decision
    elrsPath: '',
    w3DiagnosticEnabled: false, // LOG-ONLY diagnostic wish; resolved in main.js
    telemetry: Object.freeze({ source: 'none', port: '' }),
});

const str = (v, fallback) => (typeof v === 'string' ? v : fallback);
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
const oneOf = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
const port = (v, fallback) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
};

// Accepts anything (missing file, garbage JSON, old versions) and returns a
// complete settings object. Unknown keys are dropped; bad values fall back to
// defaults field-by-field so one corrupt entry never nukes the rest.
function normalizeSettings(raw) {
    const d = DEFAULT_SETTINGS;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return JSON.parse(JSON.stringify(d));
    }
    const net = raw.network && typeof raw.network === 'object' ? raw.network : {};
    const hs = net.hotspot && typeof net.hotspot === 'object' ? net.hotspot : {};
    const ctl = raw.controller && typeof raw.controller === 'object' ? raw.controller : {};
    const tel = raw.telemetry && typeof raw.telemetry === 'object' ? raw.telemetry : {};
    return {
        version: SETTINGS_VERSION,
        setupCompleted: bool(raw.setupCompleted, d.setupCompleted),
        fpvMode: oneOf(raw.fpvMode, FPV_MODES, d.fpvMode),
        network: {
            kind: oneOf(net.kind, NETWORK_KINDS, d.network.kind),
            ssid: str(net.ssid, d.network.ssid),
            adapter: str(net.adapter, d.network.adapter),
            hotspot: {
                ssid: str(hs.ssid, d.network.hotspot.ssid) || d.network.hotspot.ssid,
                password: str(hs.password, d.network.hotspot.password),
            },
        },
        iphoneAddr: str(raw.iphoneAddr, d.iphoneAddr),
        iphonePort: port(raw.iphonePort, d.iphonePort),
        controller: {
            id: str(ctl.id, d.controller.id),
            preset: oneOf(ctl.preset, CONTROLLER_PRESETS, d.controller.preset),
        },
        soundEnabled: bool(raw.soundEnabled, d.soundEnabled),
        elrsPath: str(raw.elrsPath, d.elrsPath),
        w3DiagnosticEnabled: bool(raw.w3DiagnosticEnabled, d.w3DiagnosticEnabled),
        telemetry: {
            source: oneOf(tel.source, TELEMETRY_SOURCES, d.telemetry.source),
            port: str(tel.port, d.telemetry.port),
        },
    };
}

// env-over-settings merge. For each subsystem the MASTER env var being set
// (to anything) hands full control to the env path — so W17_IPHONE_BRIDGE=0
// force-disables the bridge even if settings would enable it: exactly the
// dev/CI escape hatch the plan requires. Sub-key env vars (ports, rates) also
// override when the subsystem is settings-enabled, by feeding them through the
// same resolver with a synthetic master flag.
function resolveEffective(settings, env = {}, warn = () => {}) {
    const s = normalizeSettings(settings);

    // --- telemetry source ---
    const telemetrySourceFromEnv = env.W17_TELEMETRY_SOURCE !== undefined;
    const telemetryPortFromEnv = env.W17_TELEMETRY_PORT !== undefined;
    const telemetry = {
        source: telemetrySourceFromEnv
            ? oneOf(env.W17_TELEMETRY_SOURCE, TELEMETRY_SOURCES, 'none')
            : s.telemetry.source,
        port: telemetryPortFromEnv ? env.W17_TELEMETRY_PORT : s.telemetry.port,
    };

    // --- iPhone telemetry bridge (W2, send-only) ---
    const bridgeFromEnv = env.W17_IPHONE_BRIDGE !== undefined;
    let iphoneBridge;
    if (bridgeFromEnv) {
        iphoneBridge = iphoneBridgeConfigFromEnv(env, warn);
    } else if (s.fpvMode === 'iphone-hud' && s.iphoneAddr) {
        iphoneBridge = iphoneBridgeConfigFromEnv(
            {
                W17_IPHONE_BRIDGE: '1',
                W17_IPHONE_ADDR: s.iphoneAddr,
                W17_IPHONE_PORT: env.W17_IPHONE_PORT !== undefined
                    ? env.W17_IPHONE_PORT
                    : String(s.iphonePort),
                W17_IPHONE_RATE_HZ: env.W17_IPHONE_RATE_HZ,
            },
            warn,
        );
    } else {
        iphoneBridge = null;
    }

    // --- W3 diagnostic receiver: wish only, resolved in main.js (see header) ---
    const w3FromEnv = env.W17_HEADTRACK !== undefined;

    return {
        telemetry,
        iphoneBridge,
        w3Wish: { fromEnv: w3FromEnv, enabled: s.w3DiagnosticEnabled },
        elrs: { path: s.elrsPath },
        ui: {
            fpvMode: s.fpvMode,
            network: s.network,
            controller: s.controller,
            iphoneAddr: s.iphoneAddr,
            soundEnabled: s.soundEnabled,
            setupCompleted: s.setupCompleted,
        },
        envOverridden: {
            telemetrySource: telemetrySourceFromEnv,
            telemetryPort: telemetryPortFromEnv,
            iphoneBridge: bridgeFromEnv,
            w3: w3FromEnv,
        },
    };
}

module.exports = {
    DEFAULT_SETTINGS,
    SETTINGS_VERSION,
    FPV_MODES,
    NETWORK_KINDS,
    CONTROLLER_PRESETS,
    TELEMETRY_SOURCES,
    normalizeSettings,
    resolveEffective,
};
