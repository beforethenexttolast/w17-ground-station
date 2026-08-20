// Cross-platform Electron launcher. Strips ELECTRON_RUN_AS_NODE from the
// child env before spawning: the VS Code integrated terminal (VS Code is
// itself Electron) leaks that variable, which makes ANY electron app boot as
// bare Node.js -- `require('electron')` then has no `app` and the main
// process crashes. Launching through this script makes `npm start` / `npm run
// demo` work from any terminal, on Windows/macOS/Linux.
//
// `require('electron')` from plain Node returns the path to the electron
// binary (documented behavior) -- exactly what we spawn.
const { spawn } = require('node:child_process');
const electronPath = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;
if (process.argv.includes('--demo')) env.W17_TELEMETRY_SOURCE = 'replay';
// Low-battery banner rehearsal: the same replay backend on the timeline that
// sags through the warn/critical thresholds (shared/replaySource.js), so the
// banner is demoable without draining a real pack.
if (process.argv.includes('--demo-low-battery')) {
  env.W17_TELEMETRY_SOURCE = 'replay';
  env.W17_REPLAY_TIMELINE = 'low-battery';
}

const child = spawn(electronPath, ['.'], { stdio: 'inherit', env });
child.on('close', (code) => process.exit(code ?? 0));
