// Renders the app icon (build/icon.png, 512x512) from an inline SVG using
// Electron's offscreen renderer — no extra dependencies, no visible window.
// The design is the HUD's number-plate motif: teal skewed plate, carbon "17".
// Run via `npm run icon`; the PNG is committed so builds never re-render.
//
// Dual-mode file: under plain Node it re-spawns itself through the Electron
// binary (stripping ELECTRON_RUN_AS_NODE like scripts/run.js); under Electron
// it renders and exits.

const path = require('node:path');

if (!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE) {
  const { spawn } = require('node:child_process');
  const electronPath = require('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  const child = spawn(electronPath, [__filename], { stdio: 'inherit', env });
  child.on('close', (code) => process.exit(code ?? 0));
  return;
}

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');

const SIZE = 512;
const OUT = path.join(__dirname, '..', 'build', 'icon.png');

const SVG = `
<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="bg" cx="50%" cy="42%" r="75%">
      <stop offset="0%" stop-color="#151d1f"/>
      <stop offset="60%" stop-color="#0a0f10"/>
      <stop offset="100%" stop-color="#050708"/>
    </radialGradient>
  </defs>
  <rect x="16" y="16" width="480" height="480" rx="96" fill="url(#bg)"
        stroke="rgba(0,210,190,.45)" stroke-width="8"/>
  <g transform="translate(256,256)">
    <polygon points="-118,-96 156,-96 118,96 -156,96" fill="#00D2BE"/>
    <text x="0" y="66" text-anchor="middle" transform="skewX(-8)"
          font-family="'Arial Narrow','Roboto Condensed','Segoe UI',system-ui,sans-serif"
          font-style="italic" font-weight="800" font-size="185" fill="#070A0B">17</text>
  </g>
  <text x="256" y="446" text-anchor="middle"
        font-family="'Arial Narrow','Roboto Condensed','Segoe UI',system-ui,sans-serif"
        font-weight="700" font-size="40" letter-spacing="18" fill="#7E898E">W17</text>
</svg>`;

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true },
  });
  const html = `<!DOCTYPE html><meta charset="utf-8">
    <style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block}</style>
    ${SVG}`;
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  win.webContents.once('did-finish-load', () => {
    // Give the offscreen compositor one beat to paint before capturing.
    setTimeout(async () => {
      const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, image.toPNG());
      console.log(`[icon] wrote ${OUT} (${image.getSize().width}x${image.getSize().height})`);
      app.quit();
    }, 400);
  });
});
