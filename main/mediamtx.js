// Supervises the bundled mediamtx binary: spawn, restart-on-crash, kill on
// app quit, pipe logs. mediamtx ingests the camera RTSP and republishes it as
// WebRTC/WHEP for the renderer. A classic bug is an orphaned mediamtx holding
// the port after the app dies -- we own its lifecycle explicitly.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export class MediamtxSupervisor {
  // binaryPath: absolute path to mediamtx(.exe); configPath: mediamtx.yml.
  // log: (line) => void.
  constructor({ binaryPath, configPath, log = () => {} }) {
    this._binaryPath = binaryPath;
    this._configPath = configPath;
    this._log = log;
    this._proc = null;
    this._stopping = false;
    this._restartTimer = null;
  }

  start() {
    if (!existsSync(this._binaryPath)) {
      this._log(
        `[mediamtx] binary not found at ${this._binaryPath} -- run "npm run fetch-mediamtx" ` +
          `(video disabled; HUD + telemetry still work)`
      );
      return;
    }
    this._spawn();
  }

  _spawn() {
    this._log(`[mediamtx] starting: ${path.basename(this._binaryPath)} ${this._configPath}`);
    this._proc = spawn(this._binaryPath, [this._configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    this._proc.stdout.on('data', (d) => this._log(`[mediamtx] ${d.toString().trimEnd()}`));
    this._proc.stderr.on('data', (d) => this._log(`[mediamtx] ${d.toString().trimEnd()}`));
    this._proc.on('exit', (code) => {
      this._proc = null;
      if (this._stopping) return;
      this._log(`[mediamtx] exited (code ${code}); restarting in 2s`);
      this._restartTimer = setTimeout(() => this._spawn(), 2000);
    });
  }

  stop() {
    this._stopping = true;
    if (this._restartTimer) clearTimeout(this._restartTimer);
    if (this._proc) {
      this._proc.kill(); // SIGTERM; mediamtx exits promptly and frees the port
      this._proc = null;
    }
  }
}
