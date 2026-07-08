// Electron main process (CommonJS -- Electron's main is rock-solid as CJS;
// ESM main on Electron 31 / Node 20 crashes importing the built-in electron
// module). Owns: window lifecycle, the mediamtx video supervisor, and the
// telemetry source (replay by default; a live source slots in behind the same
// interface). Pushes telemetry to the renderer over a single IPC channel. The
// renderer is fully sandboxed -- it reaches Node only through the preload.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { MediamtxSupervisor } = require('./mediamtx.js');
const { ReplaySource } = require('../shared/replaySource.js');
const { CrsfSerialSource } = require('./CrsfSerialSource.js');
const { IphoneTelemetryBridge } = require('./IphoneTelemetryBridge.js');
const { iphoneBridgeConfigFromEnv } = require('./iphoneBridgeConfig.js');
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

function chooseTelemetrySource() {
  const kind = process.env.W17_TELEMETRY_SOURCE || 'none';
  if (kind === 'replay') return new ReplaySource();
  if (kind === 'crsf-serial') {
    // Real battery + link-quality over the ELRS backchannel (docs/TELEMETRY.md).
    return new CrsfSerialSource({
      path: process.env.W17_TELEMETRY_PORT || (process.platform === 'win32' ? 'COM5' : '/dev/ttyUSB0'),
      log: (m) => console.log(m),
    });
  }
  return null; // HUD runs fully on gamepad + display model with no source
}

// Windows -> iPhone telemetry bridge (docs/windows_bridge_contract.md — the
// iPhone app's canonical contract; UDP JSON to port 5601 by default).
// Off unless W17_IPHONE_BRIDGE=1 AND a destination address is set -- with either
// missing, this returns null and app behavior is unchanged (no socket opened).
// `linkStateFn` is the SAME pure function the renderer uses, so both HUDs agree.
function chooseIphoneBridge(linkStateFn) {
  const cfg = iphoneBridgeConfigFromEnv(process.env, (m) => console.log(m));
  if (!cfg) return null;
  // Diagnostic `mode` tag for the packet: the replay source is the demo.
  const mode = (process.env.W17_TELEMETRY_SOURCE || 'none') === 'replay' ? 'demo' : undefined;
  return new IphoneTelemetryBridge({ ...cfg, linkStateFn, mode, log: (m) => console.log(m) });
}

let mediamtx = null;
let telemetry = null;
let iphoneBridge = null;

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

  ipcMain.handle('config:get', () => ({
    whepUrl: WHEP_URL,
    hasTelemetrySource: !!telemetry,
    feel: {
      gears: feel.GEARS,
      topSpeedKmh: feel.TOP_SPEED_KMH,
      ersDeployPctPerSec: feel.ERS_DEPLOY_PCT_PER_SEC,
      ersHarvestPctPerSec: feel.ERS_HARVEST_PCT_PER_SEC,
      ersBoostMultiplier: feel.ERS_BOOST_MULTIPLIER,
    },
  }));

  if (telemetry) {
    telemetry.onTelemetry((t) => {
      if (!win.isDestroyed()) win.webContents.send('telemetry', t);
      // Second consumer: the iPhone bridge. Feeding it here never alters the
      // renderer push above (the HUD is untouched).
      if (iphoneBridge) iphoneBridge.onTelemetry(t);
    });
    telemetry.start();
  }

  win.loadFile(path.join(projectRoot, 'renderer', 'index.html'));
  return win;
}

app.whenReady().then(async () => {
  const { binaryPath, configPath } = mediamtxPaths();
  mediamtx = new MediamtxSupervisor({ binaryPath, configPath, log: (l) => console.log(l) });
  mediamtx.start();

  telemetry = chooseTelemetrySource();

  // linkState lives in an ES module (shared/linkState.mjs, consumed by the
  // renderer + vitest); load it dynamically so the bridge derives link state
  // with the exact same logic as the HUD. Only used when the bridge is enabled.
  const { linkState } = await import(pathToFileURL(path.join(projectRoot, 'shared', 'linkState.mjs')).href);
  iphoneBridge = chooseIphoneBridge(linkState);
  if (iphoneBridge) iphoneBridge.start();

  // Read-only display mirror from the renderer (throttle/brake/steering/camera
  // as drawn on the HUD) -- forwarded outward to the iPhone bridge only. This
  // is one-way: nothing is sent back, and no control state is touched.
  ipcMain.on('command-mirror', (_event, mirror) => {
    if (iphoneBridge) iphoneBridge.onCommandMirror(mirror);
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Always tear down the child + source so nothing is orphaned.
app.on('will-quit', () => {
  if (iphoneBridge) iphoneBridge.stop();
  if (telemetry) telemetry.stop();
  if (mediamtx) mediamtx.stop();
});
