// The only bridge between the sandboxed renderer and Node. Exposes a minimal,
// typed surface: fetch config (WHEP URL + whether a telemetry source is live)
// and subscribe to telemetry pushes. The renderer never sees ipcRenderer,
// require, or any Node primitive directly.
//
// NOTE: preload runs in a CommonJS context regardless of the package "type",
// so this file uses require() intentionally.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('groundStation', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  // Persisted setup-flow settings (main/settingsStore.js). setSettings saves
  // only; applySession re-resolves settings+env and (re)starts the session
  // runtime, returning a summary of what is now running.
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  applySession: () => ipcRenderer.invoke('session:apply'),
  // PIT WALL network step (Windows-only OS control; guide mode elsewhere).
  wifiCapabilities: () => ipcRenderer.invoke('wifi:capabilities'),
  wifiInterfaces: () => ipcRenderer.invoke('wifi:interfaces'),
  wifiScan: (opts) => ipcRenderer.invoke('wifi:scan', opts),
  wifiJoin: (opts) => ipcRenderer.invoke('wifi:join', opts),
  wifiStatus: () => ipcRenderer.invoke('wifi:status'),
  hotspotStart: (opts) => ipcRenderer.invoke('wifi:hotspot-start', opts),
  hotspotStop: () => ipcRenderer.invoke('wifi:hotspot-stop'),
  // Setup helpers: last-sender address suggestion (user-confirmed) + ping.
  getAddrHint: () => ipcRenderer.invoke('setup:addr-hint'),
  probeHost: (addr) => ipcRenderer.invoke('setup:probe-host', addr),
  // elrs-joystick-control: launch-only convenience; this app never stops it.
  elrsStatus: () => ipcRenderer.invoke('elrs:status'),
  elrsLaunch: () => ipcRenderer.invoke('elrs:launch'),
  onTelemetry: (cb) => {
    const handler = (_event, telemetry) => cb(telemetry);
    ipcRenderer.on('telemetry', handler);
    return () => ipcRenderer.removeListener('telemetry', handler);
  },
  // READ-ONLY display mirror (throttle/brake/steering/camera as drawn on the
  // HUD) for the outbound iPhone telemetry bridge. One-way renderer -> main ->
  // UDP out; main only serializes it — it never feeds control, and nothing
  // comes back on this channel.
  sendCommandMirror: (mirror) => ipcRenderer.send('command-mirror', mirror),
});
