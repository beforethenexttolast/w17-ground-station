// Electron main process (CommonJS -- Electron's main is rock-solid as CJS;
// ESM main on Electron 31 / Node 20 crashes importing the built-in electron
// module). Owns: window lifecycle, the mediamtx video supervisor, persisted
// setup-flow settings, and the session runtime (telemetry source + outbound
// iPhone bridge, reconfigurable via `session:apply` after the setup flow).
// Pushes telemetry to the renderer over a single IPC channel. The renderer is
// fully sandboxed -- it reaches Node only through the preload.
//
// Config precedence everywhere: an env var that is SET wins over persisted
// settings (shared/settings.js `resolveEffective`); with no env vars and a
// fresh settings file the app behaves exactly like the pre-settings build.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { MediamtxSupervisor } = require('./mediamtx.js');
const { ReplaySource } = require('../shared/replaySource.js');
const { CrsfSerialSource } = require('./CrsfSerialSource.js');
const { IphoneTelemetryBridge } = require('./IphoneTelemetryBridge.js');
const { HeadTrackingReceiver } = require('./HeadTrackingReceiver.js');
const { headTrackingConfigFromEnv } = require('./headTrackingConfig.js');
const { resolveEffective } = require('../shared/settings.js');
const { createSettingsStore } = require('./settingsStore.js');
const { SessionRuntime } = require('./sessionRuntime.js');
const feel = require('../shared/feelConstants.js');

const projectRoot = path.join(__dirname, '..');

// mediamtx lives next to the app in dev, and as an unpacked extraResource in
// the packaged build (process.resourcesPath).
function mediamtxPaths() {
  const exe = process.platform === 'win32' ? 'mediamtx.exe' : 'mediamtx';
  const base = app.isPackaged ? process.resourcesPath : projectRoot;
  return {
    binaryPath: path.join(base, 'mediamtx', exe),
    configPath: path.join(base, 'mediamtx', 'mediamtx.yml'),
  };
}

// WHEP endpoint the renderer connects to (mediamtx default WebRTC port 8889).
const WHEP_URL = process.env.W17_WHEP_URL || 'http://127.0.0.1:8889/cam/whep';

// Session-scoped state, owned by whenReady below.
let mediamtx = null;
let settingsStore = null;
let runtime = null;
let lastEffective = null;

// iPhone -> Windows head-tracking receiver (contract section 3): LOG-ONLY.
// It is a dead end by construction -- nothing consumes its data; it logs and
// counts. It must never feed CRSF, servos, pan/tilt, telemetry, or the
// renderer (separate safety milestone required). Its wiring lives ONLY here.
let headTracking = null;
let headTrackingKey = null;

function telemetrySourceFor(cfg) {
  if (cfg.source === 'replay') return new ReplaySource();
  if (cfg.source === 'crsf-serial') {
    // Real battery + link-quality over the ELRS backchannel (docs/TELEMETRY.md).
    return new CrsfSerialSource({
      path: cfg.port || (process.platform === 'win32' ? 'COM5' : '/dev/ttyUSB0'),
      log: (m) => console.log(m),
    });
  }
  return null; // HUD runs fully on gamepad + display model with no source
}

// The W3 receiver's effective config: env master var wins outright (set to
// anything, including 0 = force-off); otherwise the persisted settings toggle
// decides, still honoring env sub-key overrides via the same pure resolver.
function w3ConfigFor(effective) {
  if (effective.envOverridden.w3) return headTrackingConfigFromEnv(process.env);
  if (effective.w3Wish.enabled) {
    return headTrackingConfigFromEnv({ ...process.env, W17_HEADTRACK: '1' });
  }
  return null;
}

function applyW3(effective) {
  const cfg = w3ConfigFor(effective);
  const key = cfg ? JSON.stringify(cfg) : null;
  if (key === headTrackingKey) return !!headTracking;
  if (headTracking) {
    headTracking.stop();
    headTracking = null;
  }
  headTrackingKey = key;
  if (cfg) {
    headTracking = new HeadTrackingReceiver({ ...cfg, log: (m) => console.log(m) });
    headTracking.start();
  }
  return !!headTracking;
}

// Recompute effective config from persisted settings + env and (re)apply the
// session runtime. Called once at startup and again on `session:apply`.
function applySession() {
  const settings = settingsStore.load();
  lastEffective = resolveEffective(settings, process.env, (m) => console.log(m));
  const applied = runtime.applyConfig(lastEffective);
  const w3 = applyW3(lastEffective);
  return { ...applied, w3 };
}

function registerIpcHandlers() {
  ipcMain.handle('config:get', () => ({
    whepUrl: WHEP_URL,
    hasTelemetrySource: runtime.hasTelemetrySource(),
    platform: process.platform,
    setupCompleted: lastEffective ? lastEffective.ui.setupCompleted : false,
    envOverridden: lastEffective ? lastEffective.envOverridden : {},
    feel: {
      gears: feel.GEARS,
      topSpeedKmh: feel.TOP_SPEED_KMH,
      ersDeployPctPerSec: feel.ERS_DEPLOY_PCT_PER_SEC,
      ersHarvestPctPerSec: feel.ERS_HARVEST_PCT_PER_SEC,
      ersBoostMultiplier: feel.ERS_BOOST_MULTIPLIER,
    },
  }));

  ipcMain.handle('settings:get', () => ({
    settings: settingsStore.load(),
    envOverridden: lastEffective ? lastEffective.envOverridden : {},
  }));

  ipcMain.handle('settings:set', (_event, patch) => settingsStore.save(patch));

  ipcMain.handle('session:apply', () => applySession());

  // Read-only display mirror from the renderer (throttle/brake/steering/camera
  // as drawn on the HUD) -- forwarded outward to the iPhone bridge only. This
  // is one-way: nothing is sent back, and no control state is touched.
  ipcMain.on('command-mirror', (_event, mirror) => {
    runtime.onCommandMirror(mirror);
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  runtime.setSnapshotSink((t) => {
    if (!win.isDestroyed()) win.webContents.send('telemetry', t);
  });

  win.loadFile(path.join(projectRoot, 'renderer', 'index.html'));
  return win;
}

app.whenReady().then(async () => {
  const { binaryPath, configPath } = mediamtxPaths();
  mediamtx = new MediamtxSupervisor({ binaryPath, configPath, log: (l) => console.log(l) });
  mediamtx.start();

  settingsStore = createSettingsStore({
    dir: app.getPath('userData'),
    log: (m) => console.log(m),
  });

  // linkState lives in an ES module (shared/linkState.mjs, consumed by the
  // renderer + vitest); load it dynamically so the bridge derives link state
  // with the exact same logic as the HUD. Only used when the bridge is enabled.
  const { linkState } = await import(pathToFileURL(path.join(projectRoot, 'shared', 'linkState.mjs')).href);

  runtime = new SessionRuntime({
    createTelemetrySource: (cfg) => telemetrySourceFor(cfg),
    // Windows -> iPhone telemetry bridge (docs/windows_bridge_contract.md — the
    // iPhone app's canonical contract; UDP JSON to port 5601 by default).
    createIphoneBridge: (cfg, { demo }) => new IphoneTelemetryBridge({
      ...cfg,
      linkStateFn: linkState,
      mode: demo ? 'demo' : undefined,
      log: (m) => console.log(m),
    }),
    log: (m) => console.log(m),
  });

  registerIpcHandlers();
  applySession();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Always tear down the children + sources so nothing is orphaned. (The
// elrs-joystick-control launcher is deliberately absent here: it spawns
// detached and is never killed by this app.)
app.on('will-quit', () => {
  if (headTracking) headTracking.stop();
  if (runtime) runtime.stopAll();
  if (mediamtx) mediamtx.stop();
});
