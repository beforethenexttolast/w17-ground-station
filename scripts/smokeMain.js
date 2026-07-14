// Electron boot smoke, Electron side (audit D3). Spawned by
// scripts/electron-smoke.js as `electron scripts/smokeMain.js`; it points
// userData at the controller's throwaway directory, requires the REAL,
// UNMODIFIED main/main.js, and then proves the boot through PUBLIC Electron
// APIs only — window exists, page loaded, the preload exposed exactly the
// pinned surface, a real IPC round trip answered, the GARAGE setup step is
// visible, and no uncaught exception occurred. Every stage emits a structured
// W17_SMOKE token on stdout; the controller decides pass/fail from those.
//
// Safety posture (pinned by test/electronSmoke.test.js):
//  - No production file changes: production code never reads W17_SMOKE_*.
//  - No new IPC, no preload change, no webPreferences override, no exposed
//    debug channel — the page is interrogated via executeJavaScript, and the
//    only preload methods it calls are READ-ONLY (getConfig/getSettings) plus
//    an onTelemetry subscribe/unsubscribe probe.
//  - Never touches Wi-Fi join, hotspot start, ELRS launch, serial, or any
//    control/mutation surface; W17_WIFI_SIM keeps even read paths canned.
//  - W17_SMOKE_FAIL_STAGE / W17_SMOKE_HANG are smoke-only fault injections for
//    the controller's negative scenarios; they exist only in this file.

'use strict';

const path = require('node:path');
const { EVENT_PREFIX, EXPECTED_API, REQUIRED_STAGES, isAllowedConsoleError } = require('./smokeShared.js');

const emit = (event, data = {}) => {
  process.stdout.write(`${EVENT_PREFIX}${JSON.stringify({ event, ...data })}\n`);
};
// The result token must reach the pipe before the process exits.
const emitFlushed = (event, data = {}) => new Promise((resolve) => {
  process.stdout.write(`${EVENT_PREFIX}${JSON.stringify({ event, ...data })}\n`, resolve);
});

const fatal = [];          // main-process exceptions + renderer crashes
const consoleErrors = [];  // renderer error-level console messages
let currentStage = 'preflight';

process.on('uncaughtException', (err) => {
  fatal.push(`main uncaughtException at ${currentStage}: ${err && err.stack ? err.stack : err}`);
  emit('main-exception', { stage: currentStage, message: String((err && err.message) || err) });
});
process.on('unhandledRejection', (reason) => {
  fatal.push(`main unhandledRejection at ${currentStage}: ${reason && reason.stack ? reason.stack : reason}`);
  emit('main-exception', { stage: currentStage, message: String((reason && reason.message) || reason) });
});

const userData = process.env.W17_SMOKE_USERDATA;
if (!userData) {
  emit('result', { ok: false, failedStage: 'preflight', failures: ['W17_SMOKE_USERDATA is not set — launch via scripts/electron-smoke.js'] });
  process.exit(1);
}

const { app, BrowserWindow } = require('electron');
app.setPath('userData', userData);

// Capture the main process's own log lines (main.js logs via console.log) so
// stage checks can assert on real boot evidence — e.g. the navigation-denial
// marker — without modifying production code. Lines still pass through to
// stdout, so the controller's captured log keeps everything.
const mainLog = [];
const consoleLogPassthrough = console.log.bind(console);
console.log = (...args) => {
  mainLog.push(args.join(' '));
  consoleLogPassthrough(...args);
};

// Boot the REAL application. From here on, everything main.js does — service
// construction, settings load, session apply, window creation, preload — is
// the production path; this file only observes it.
require(path.join(__dirname, '..', 'main', 'main.js'));

const FAIL_STAGE = process.env.W17_SMOKE_FAIL_STAGE || '';
const HANG = process.env.W17_SMOKE_HANG === '1';
const STAGE_TIMEOUT_MS = 30000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(label, probe, timeoutMs = STAGE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(100);
  }
}

const checks = {}; // accumulated per-stage evidence, reported in the result token

async function stage(name, fn) {
  currentStage = name;
  if (FAIL_STAGE === name) {
    // Smoke-only fault injection (negative scenario): fail THIS stage loudly
    // so the controller can prove failures are reported and identified.
    throw Object.assign(new Error(`forced failure injected by W17_SMOKE_FAIL_STAGE=${name}`), { stage: name });
  }
  const detail = await fn();
  if (detail !== undefined) checks[name] = detail;
  emit('stage', { stage: name, ...(detail && typeof detail === 'object' ? { detail } : {}) });
}

const fail = (stageName, message) => {
  throw Object.assign(new Error(message), { stage: stageName });
};

// Page-world probes (main world — where contextBridge exposes groundStation).
// Read-only by design: they inspect the DOM and the exposed API and call
// nothing that mutates settings, network, session, or process state.
const PAGE_API_PROBE = `(() => {
  const api = window.groundStation;
  return {
    apiType: typeof api,
    apiKeys: api ? Object.keys(api).sort() : [],
    allFunctions: api ? Object.keys(api).every((k) => typeof api[k] === 'function') : false,
    requireType: typeof require,
    processType: typeof process,
    bufferType: typeof Buffer,
    ipcRendererGlobal: typeof window.ipcRenderer,
    cspMeta: (document.querySelector('meta[http-equiv="Content-Security-Policy"]') || {}).content || '',
  };
})()`;

const PAGE_READY_PROBE = `(() => {
  const gate = document.getElementById('gate');
  const garage = document.querySelector('.setup-screen[data-step="garage"]');
  const bootError = document.getElementById('bootError');
  return {
    gateVisible: !!gate && !gate.classList.contains('hidden'),
    garageActive: !!garage && garage.classList.contains('active'),
    bootErrorHidden: !bootError || bootError.classList.contains('hidden'),
  };
})()`;

const PAGE_IPC_PROBE = `(async () => {
  const cfg = await window.groundStation.getConfig();
  const st = await window.groundStation.getSettings();
  return { cfg, st };
})()`;

const PAGE_UNSUBSCRIBE_PROBE = `(() => {
  const unsubscribe = window.groundStation.onTelemetry(() => {});
  const ok = typeof unsubscribe === 'function';
  if (ok) unsubscribe();
  return ok;
})()`;

async function run() {
  await stage('electron-ready', async () => {
    await app.whenReady();
  });

  let win = null;
  await stage('window-created', async () => {
    win = await until('a BrowserWindow', () => BrowserWindow.getAllWindows()[0] || null);
    return { windows: BrowserWindow.getAllWindows().length };
  });

  // Observe renderer health from here on: a renderer crash, a failed main
  // frame load, or an error-level console message is boot evidence.
  win.webContents.on('render-process-gone', (_event, details) => {
    fatal.push(`render-process-gone: ${details.reason} (exitCode ${details.exitCode})`);
  });
  win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame) fatal.push(`did-fail-load: ${description} (${code}) ${url}`);
  });
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 3) consoleErrors.push(`${message} [${sourceId}:${line}]`);
  });

  await stage('window-loaded', async () => {
    await until('renderer load', () => win.webContents.getURL() && !win.webContents.isLoading());
    return { url: win.webContents.getURL() };
  });

  if (HANG) {
    // Smoke-only wedge (negative scenario): a booted app that never reaches
    // readiness. The controller's hard timeout must kill the process tree.
    emit('hang', { stage: currentStage });
    return new Promise(() => {});
  }

  const exec = (code) => win.webContents.executeJavaScript(code, true);

  await stage('preload-api', async () => {
    const probe = await exec(PAGE_API_PROBE);
    if (probe.apiType !== 'object') fail('preload-api', `window.groundStation is ${probe.apiType}, expected object`);
    const expected = [...EXPECTED_API];
    if (JSON.stringify(probe.apiKeys) !== JSON.stringify(expected)) {
      fail('preload-api', `exposed API mismatch: got [${probe.apiKeys.join(', ')}]`);
    }
    if (!probe.allFunctions) fail('preload-api', 'a groundStation member is not a function');
    if (probe.requireType !== 'undefined') fail('preload-api', 'require is reachable from the page');
    if (probe.processType !== 'undefined') fail('preload-api', 'process is reachable from the page');
    if (probe.bufferType !== 'undefined') fail('preload-api', 'Buffer is reachable from the page');
    if (probe.ipcRendererGlobal !== 'undefined') fail('preload-api', 'ipcRenderer is reachable from the page');
    return { apiKeys: probe.apiKeys.length, cspPresent: !!probe.cspMeta };
  });

  await stage('security', async () => {
    if (typeof win.webContents.getLastWebPreferences !== 'function') {
      fail('security', 'webContents.getLastWebPreferences unavailable — update smokeMain for this Electron version');
    }
    // Electron 31's getLastWebPreferences() reports the security flags but
    // NOT the preload path — preload EXECUTION is already proven by the
    // preload-api stage (the exact pinned surface exists only if the real
    // preload ran), and the preload PATH is pinned statically by
    // test/appWiring.test.js over createWindowOptions.
    const prefs = win.webContents.getLastWebPreferences();
    if (prefs.contextIsolation !== true) fail('security', 'contextIsolation is not true at runtime');
    if (prefs.nodeIntegration !== false) fail('security', 'nodeIntegration is not false at runtime');
    if (prefs.sandbox !== true) fail('security', 'sandbox is not true at runtime');
    if (prefs.webSecurity !== true) fail('security', 'webSecurity is not true at runtime');
    if (prefs.webviewTag !== false) fail('security', 'webviewTag is enabled at runtime');

    const url = win.webContents.getURL();
    if (!url.startsWith('file://') || !url.endsWith('renderer/index.html')) {
      fail('security', `unexpected page URL: ${url}`);
    }

    const probe = await exec(PAGE_API_PROBE);
    if (!probe.cspMeta.includes("default-src 'self'")) fail('security', `CSP meta missing or weakened: "${probe.cspMeta}"`);

    // window.open must be denied (production setWindowOpenHandler): the call
    // returns null and no second window appears.
    const openedNull = await exec(`window.open('https://smoke.invalid/') === null`);
    if (openedNull !== true) fail('security', 'window.open was not denied');
    if (BrowserWindow.getAllWindows().length !== 1) fail('security', 'window.open created a window');

    // Renderer-initiated navigation must be denied (production will-navigate
    // policy): the URL stays put and main logs the denial marker.
    await exec(`(() => { location.assign('https://smoke.invalid/blocked'); return true; })()`);
    await until('the navigation-denial log marker', () => mainLog.some((l) => l.includes('[window] blocked navigation')), 5000);
    if (win.webContents.getURL() !== url) fail('security', 'renderer-initiated navigation was not blocked');
    return { contextIsolation: true, nodeIntegration: false, sandbox: true, windowOpenDenied: true, navigationDenied: true };
  });

  await stage('ipc-roundtrip', async () => {
    const { cfg, st } = await exec(PAGE_IPC_PROBE);
    if (!cfg || typeof cfg.whepUrl !== 'string' || !cfg.whepUrl.startsWith('http')) fail('ipc-roundtrip', 'config:get returned no WHEP URL');
    if (cfg.platform !== process.platform) fail('ipc-roundtrip', `config platform ${cfg.platform} != ${process.platform}`);
    if (cfg.setupCompleted !== false) fail('ipc-roundtrip', 'fresh profile reports setupCompleted=true');
    if (cfg.w3Active !== false) fail('ipc-roundtrip', 'W3 receiver active in the smoke environment');
    if (cfg.telemetrySource !== 'none') fail('ipc-roundtrip', `effective telemetry source ${cfg.telemetrySource}, expected none`);
    if (cfg.hasTelemetrySource !== false) fail('ipc-roundtrip', 'a telemetry source is live in the smoke environment');
    if (!cfg.feel || typeof cfg.feel.gears !== 'number') fail('ipc-roundtrip', 'feel constants missing from config:get');
    for (const [key, value] of Object.entries(cfg.envOverridden || {})) {
      if (value) fail('ipc-roundtrip', `unexpected env override in scrubbed smoke env: ${key}`);
    }
    if (!st || !st.settings) fail('ipc-roundtrip', 'settings:get returned no settings');
    if (st.settings.fpvMode !== 'solo') fail('ipc-roundtrip', `fresh profile fpvMode ${st.settings.fpvMode}, expected solo`);
    if (st.settings.setupCompleted !== false) fail('ipc-roundtrip', 'fresh profile settings report setupCompleted=true');
    if (st.settings.network.hotspot.password !== '') fail('ipc-roundtrip', 'fresh profile carries a hotspot password');
    if (/"password"\s*:\s*"[^"]/.test(JSON.stringify(st))) fail('ipc-roundtrip', 'a non-empty password rode the settings:get answer');
    // audit E1: no ciphertext / safeStorage token ever rides the renderer answer,
    // and the non-secret credential status is present with no password set.
    const stJson = JSON.stringify(st);
    if (stJson.includes('passwordEnc') || stJson.includes('w17cred:')) {
      fail('ipc-roundtrip', 'a credential ciphertext token rode the settings:get answer');
    }
    if (!st.credential || typeof st.credential.encryptionAvailable !== 'boolean' || st.credential.hasPassword !== false) {
      fail('ipc-roundtrip', 'settings:get credential status missing or wrong for the fresh smoke profile');
    }
    if (!st.effective || st.effective.telemetrySource !== 'none' || st.effective.w3 !== false) {
      fail('ipc-roundtrip', 'settings:get effective block missing or wrong for the smoke environment');
    }
    return { whepUrl: cfg.whepUrl, telemetrySource: cfg.telemetrySource, fpvMode: st.settings.fpvMode };
  });

  await stage('renderer-ready', async () => {
    const ready = await until('the GARAGE setup step', async () => {
      const r = await exec(PAGE_READY_PROBE);
      return r.gateVisible && r.garageActive && r.bootErrorHidden ? r : null;
    }, 20000);
    const unsubscribeOk = await exec(PAGE_UNSUBSCRIBE_PROBE);
    if (unsubscribeOk !== true) fail('renderer-ready', 'onTelemetry did not return a working unsubscribe');
    return { ...ready, unsubscribeOk };
  });

  await stage('console-clean', async () => {
    const unexpected = consoleErrors.filter((entry) => !isAllowedConsoleError(entry));
    if (unexpected.length) fail('console-clean', `unexpected renderer console error(s): ${unexpected.slice(0, 3).join(' | ')}`);
    if (fatal.length) fail('console-clean', fatal.slice(0, 3).join(' | '));
    return { consoleErrors: consoleErrors.length, allowed: consoleErrors.length - unexpected.length };
  });
}

async function finish(exitCode, resultPayload) {
  await emitFlushed('result', resultPayload);
  // Graceful production shutdown: before-quit (quit policy; no owned hotspot
  // in the smoke) then will-quit (the failure-isolated teardown). Electron's
  // quit path exits 0 regardless of process.exitCode, so the 'quit' hook —
  // which fires AFTER the will-quit teardown has run — forces the verdict
  // code. If quitting wedges, the unref()'d fallback forces the exit so the
  // controller never waits out its hard timeout on a decided run.
  app.once('quit', () => process.exit(exitCode));
  setTimeout(() => {
    consoleLogPassthrough('[smoke] graceful quit timed out; forcing exit');
    app.exit(exitCode);
  }, 8000).unref();
  app.quit();
}

run().then(
  () => finish(0, { ok: true, stages: [...REQUIRED_STAGES], checks }),
  (err) => finish(1, {
    ok: false,
    failedStage: (err && err.stage) || currentStage,
    failures: [String((err && err.message) || err), ...fatal],
    checks,
  }),
);
