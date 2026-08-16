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
// GS DRIVE MODE display preference (NOT the car's mode). Maps to the firmware
// drive-mode index the HUD previews: normal=TRAINING(0), sim=RACE/gearbox(1),
// full-sim=ERS(2). The car owns its real mode and reports it via telemetry.
const DRIVING_MODES = ['normal', 'sim', 'full-sim'];

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
    startLightsEnabled: false, // five-red-lights countdown before the HUD; opt-in
    drivingMode: 'normal', // HUD DRIVE MODE display preference; the car reports its own
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

// --- wheel profile validation (CJS-local mirror of shared/wheelProfile.mjs) ---
//
// The real validator, `normalizeWheelSettings`, lives in shared/wheelProfile.mjs
// (ESM, renderer-loadable) and CANNOT be require()'d synchronously from this
// CommonJS module, so we cannot share a single sync core. Instead this is a
// deliberate LOCAL MIRROR of that function (wheelProfile.mjs:191-229) and its
// constants, kept honest by a corpus-based parity test
// (test/wheelProfilePersist.test.js) that asserts, over a broad hostile corpus,
// that normalizeWheelProfile(x) deep-equals normalizeWheelSettings(x). If the
// two ever drift, that test fails — it is what makes the mirror safe.
//
// This exists so normalizeSettings can admit a validated `wheel.profile` subtree
// on the persistence path: the SEAT FIT calibration is saved as
// { wheel: { profile } } and every save funnels through normalizeSettings, so
// without this the whole subtree was silently dropped (audit Finding 1, HIGH).
const DEFAULT_WHEEL_PROFILE = Object.freeze({
    steer: Object.freeze({ axis: 0 }),
    pedalMode: 'separate',
    throttle: Object.freeze({ axis: 1, rest: 1, full: -1 }),
    brake: Object.freeze({ axis: 2, rest: 1, full: -1 }),
    combined: Object.freeze({ axis: 1, rest: 0, throttleEnd: 1, brakeEnd: -1 }),
    deadzone: 0.05,
    buttons: Object.freeze({
        gearUp: 5, gearDown: 4, drs: 3, boost: 1, overtake: 2,
    }),
});
const MAX_DEADZONE = 0.5;
const WHEEL_BUTTON_ROLES = ['gearUp', 'gearDown', 'drs', 'boost', 'overtake'];

const wpFinite = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const wpClampAxis = (n) => (n < -1 ? -1 : n > 1 ? 1 : n);
const wpAxisIndex = (v, dflt) => {
    const n = wpFinite(v);
    return n !== null && n >= 0 ? Math.floor(n) : dflt;
};
const wpButtonIndex = (v) => {
    const n = wpFinite(v);
    return n !== null && n >= 0 ? Math.floor(n) : null;
};
const wpCal = (v, dflt) => { const n = wpFinite(v); return n === null ? dflt : wpClampAxis(n); };

// Mirror of normalizeWheelSettings (shared/wheelProfile.mjs). Coerce a persisted
// (possibly partial, wrong-typed, or hostile) blob into a valid wheel profile,
// filling every field from DEFAULT_WHEEL_PROFILE. Never throws.
function normalizeWheelProfile(raw) {
    const r = (raw && typeof raw === 'object') ? raw : {};
    const D = DEFAULT_WHEEL_PROFILE;
    const t = (r.throttle && typeof r.throttle === 'object') ? r.throttle : {};
    const b = (r.brake && typeof r.brake === 'object') ? r.brake : {};
    const c = (r.combined && typeof r.combined === 'object') ? r.combined : {};
    const s = (r.steer && typeof r.steer === 'object') ? r.steer : {};
    const btn = (r.buttons && typeof r.buttons === 'object') ? r.buttons : {};
    const dz = wpFinite(r.deadzone);
    return {
        steer: { axis: wpAxisIndex(s.axis, D.steer.axis) },
        pedalMode: r.pedalMode === 'combined' ? 'combined' : 'separate',
        throttle: {
            axis: wpAxisIndex(t.axis, D.throttle.axis),
            rest: wpCal(t.rest, D.throttle.rest),
            full: wpCal(t.full, D.throttle.full),
        },
        brake: {
            axis: wpAxisIndex(b.axis, D.brake.axis),
            rest: wpCal(b.rest, D.brake.rest),
            full: wpCal(b.full, D.brake.full),
        },
        combined: {
            axis: wpAxisIndex(c.axis, D.combined.axis),
            rest: wpCal(c.rest, D.combined.rest),
            throttleEnd: wpCal(c.throttleEnd, D.combined.throttleEnd),
            brakeEnd: wpCal(c.brakeEnd, D.combined.brakeEnd),
        },
        deadzone: dz === null ? D.deadzone : (dz < 0 ? 0 : dz > MAX_DEADZONE ? MAX_DEADZONE : dz),
        // Derived from WHEEL_BUTTON_ROLES so a new/renamed role can never be
        // silently dropped. An explicit null is a deliberate unassign and is
        // preserved; any other garbage repairs to the default index.
        buttons: Object.fromEntries(WHEEL_BUTTON_ROLES.map((role) => [
            role,
            btn[role] === null ? null : wpButtonIndex(btn[role]) ?? D.buttons[role],
        ])),
    };
}

// --- low-battery thresholds (CJS-local mirror of shared/lowBattery.mjs) ---
//
// Same construction as the wheel mirror above, for the same reason: the real
// validator, `normalizeLowBatterySettings`, lives in shared/lowBattery.mjs
// (ESM, renderer-loadable — hud.js derives the banner level from it every
// frame) and CANNOT be require()'d synchronously here. This LOCAL MIRROR is
// kept honest by the corpus-based parity test in test/lowBatteryPersist.test.js
// — normalizeLowBattery(x) must deep-equal normalizeLowBatterySettings(x) over
// a hostile corpus, so a drift between the two fails the suite.
//
// Thresholds are PACK volts (2S defaults: warn 3.5 V/cell = 7.0 V, critical
// 3.3 V/cell = 6.6 V). The band rejects unit mistakes; an inverted pair is
// repaired by lowering critical to warn (the conservative direction). Callers
// that save this subtree always write BOTH fields (the saveWheel() rule):
// `lowBattery` stays OUT of settingsStore's nested-merge list, so a partial
// patch would otherwise silently reset the missing field to its default.
const DEFAULT_LOW_BATTERY = Object.freeze({ warnV: 7, criticalV: 6.6 });
const LOW_BATTERY_MIN_V = 1;
const LOW_BATTERY_MAX_V = 60;

const lbNum = (v) => {
    // Mirrors lowBattery.mjs num(): a boolean is never a threshold —
    // Number(true) === 1 sits inside the sanity band and would otherwise
    // become a 1 V warn line (banner silently never fires). Repair to default.
    if (typeof v === 'boolean') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= LOW_BATTERY_MIN_V && n <= LOW_BATTERY_MAX_V ? n : null;
};

// Mirror of normalizeLowBatterySettings (shared/lowBattery.mjs). Never throws.
function normalizeLowBattery(raw) {
    const r = (raw && typeof raw === 'object') ? raw : {};
    const warnV = lbNum(r.warnV) ?? DEFAULT_LOW_BATTERY.warnV;
    let criticalV = lbNum(r.criticalV) ?? DEFAULT_LOW_BATTERY.criticalV;
    if (criticalV > warnV) criticalV = warnV;
    return { warnV, criticalV };
}

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
        startLightsEnabled: bool(raw.startLightsEnabled, d.startLightsEnabled),
        drivingMode: oneOf(raw.drivingMode, DRIVING_MODES, d.drivingMode),
        elrsPath: str(raw.elrsPath, d.elrsPath),
        w3DiagnosticEnabled: bool(raw.w3DiagnosticEnabled, d.w3DiagnosticEnabled),
        telemetry: {
            source: oneOf(tel.source, TELEMETRY_SOURCES, d.telemetry.source),
            port: str(tel.port, d.telemetry.port),
        },
        // The SEAT FIT wheel calibration, admitted ONLY when a profile is
        // actually present (audit Finding 1). Realized via conditional spread
        // rather than a literal `wheel: undefined`: a no-wheel session then keeps
        // EXACTLY the 12 pre-existing keys on disk (a present `wheel: undefined`
        // is not deep-strict-equal to an absent key — the settings.test.js pins
        // depend on that). Only the profile persists; the active input TYPE is
        // deliberately never written (renderer decision #2 — always boots GAMEPAD).
        ...(raw.wheel && raw.wheel.profile
            ? { wheel: { profile: normalizeWheelProfile(raw.wheel.profile) } }
            : {}),
        // Low-battery banner thresholds, admitted ONLY when the subtree is
        // actually present — the same conditional spread as `wheel` above, for
        // the same reason: normalizeSettings rebuilds a fixed shape, so a key
        // it does not admit is silently dropped on every save (audit Finding 1
        // class), while an unconditional key would change the on-disk shape of
        // every existing install (the exactly-13-keys pins). A session that
        // never touched the thresholds keeps exactly the 13 baseline keys and
        // the renderer falls back to DEFAULT_LOW_BATTERY. Arrays are rejected
        // here (an array is not a config), not inside the normalizer.
        ...(raw.lowBattery && typeof raw.lowBattery === 'object' && !Array.isArray(raw.lowBattery)
            ? { lowBattery: normalizeLowBattery(raw.lowBattery) }
            : {}),
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
    DRIVING_MODES,
    normalizeSettings,
    normalizeWheelProfile,
    normalizeLowBattery,
    resolveEffective,
};
