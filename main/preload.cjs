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
  onTelemetry: (cb) => {
    const handler = (_event, telemetry) => cb(telemetry);
    ipcRenderer.on('telemetry', handler);
    return () => ipcRenderer.removeListener('telemetry', handler);
  },
});
