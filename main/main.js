// Electron main process (CommonJS -- Electron's main is rock-solid as CJS;
// ESM main on Electron 31 / Node 20 crashes importing the built-in electron
// module). Owns: window lifecycle, the mediamtx video supervisor, and the
// telemetry source (replay by default; a live source slots in behind the same
// interface). Pushes telemetry to the renderer over a single IPC channel. The
// renderer is fully sandboxed -- it reaches Node only through the preload.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

const { MediamtxSupervisor } = require('./mediamtx.js');
const { ReplaySource } = require('../shared/replaySource.js');
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
  return null; // HUD runs fully on gamepad + display model with no source
}

let mediamtx = null;
let telemetry = null;

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
    });
    telemetry.start();
  }

  win.loadFile(path.join(projectRoot, 'renderer', 'index.html'));
  return win;
}

app.whenReady().then(() => {
  const { binaryPath, configPath } = mediamtxPaths();
  mediamtx = new MediamtxSupervisor({ binaryPath, configPath, log: (l) => console.log(l) });
  mediamtx.start();

  telemetry = chooseTelemetrySource();
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
  if (telemetry) telemetry.stop();
  if (mediamtx) mediamtx.stop();
});
