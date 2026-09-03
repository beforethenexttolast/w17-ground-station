// Supervises the bundled mediamtx binary: spawn, restart-on-crash, kill on
// app quit, pipe logs. mediamtx ingests the camera RTSP and republishes it as
// WebRTC/WHEP for the renderer. A classic bug is an orphaned mediamtx holding
// the port after the app dies -- we own its lifecycle explicitly. CommonJS.
//
// Video profiles (vision decision 7): the supervisor can carry per-profile
// mediamtx overrides as MTX_* environment variables (mediamtx gives env vars
// precedence over the config file, pinned v1.9.3 semantics), so the checked-in
// mediamtx.yml stays the single, operator-editable base config. With NO
// overrides (the DRIVE profile / pre-profile callers) the spawn options are
// BYTE-IDENTICAL to the pre-profile app -- the env key is not even present --
// which is what lets test/videoProfiles.test.js prove "DRIVE = today".
// A PROFILE CHANGE IS A NEW SUPERVISOR: main.js holds this class in a
// createKeyedInstance, so switching stops the old process and constructs a
// fresh one -- this class itself stays single-shot and dumb.

const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

class MediamtxSupervisor {
  constructor({ binaryPath, configPath, log = () => {}, extraEnv = null, spawnFn = spawn, baseEnv = process.env }) {
    this._binaryPath = binaryPath;
    this._configPath = configPath;
    this._log = log;
    this._extraEnv = extraEnv && Object.keys(extraEnv).length ? { ...extraEnv } : null;
    this._spawnFn = spawnFn;
    this._baseEnv = baseEnv;
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
    if (this._extraEnv) {
      // Profile overrides are operational config, not secrets -- log them so a
      // bench session can see exactly which knobs the running process carries.
      this._log(`[mediamtx] profile overrides: ${Object.entries(this._extraEnv).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    }
    const child = this._spawnFn(this._binaryPath, [this._configPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Conditional spread: with no overrides the options object stays exactly
      // the historical literal (no `env` key), inheriting the parent env the
      // same implicit way it always did.
      ...(this._extraEnv ? { env: { ...this._baseEnv, ...this._extraEnv } } : {}),
    });
    this._proc = child;
    child.stdout.on('data', (d) => this._log(`[mediamtx] ${d.toString().trimEnd()}`));
    child.stderr.on('data', (d) => this._log(`[mediamtx] ${d.toString().trimEnd()}`));
    // Review correctness-4: 'error' fires when the child could not be STARTED
    // and the failure surfaces asynchronously — EACCES / ENOEXEC / UNKNOWN, i.e.
    // a binary that is PRESENT but unrunnable (Defender quarantine,
    // mark-of-the-web, a wrong-arch download). spawn() itself returns cleanly in
    // that case, so the try-free existsSync guard in start() does not cover it,
    // and an 'error' event with no listener is an UNCAUGHT EXCEPTION: the
    // documented soft-fail ("video disabled; HUD + telemetry still work",
    // start() above and main/appWiring.js:166-167) became a main-process crash.
    // For THIS failure Node never fires 'exit' either, so the restart timer has
    // to be armed here.
    //
    // Identity-guarded exactly like main/mapperRunner.js:136-143: a late event
    // from a replaced child (stop() ran, or a profile switch built a new one)
    // must never clobber a newer run's state or arm a second timer.
    child.on('error', (err) => {
      if (this._proc !== child) return;
      this._proc = null;
      const code = (err && (err.code || err.message)) || 'unknown';
      if (this._stopping) return;
      this._log(`[mediamtx] could not start (${code}); video is off — retrying in 2s`);
      this._restartTimer = setTimeout(() => this._spawn(), 2000);
    });
    child.on('exit', (code) => {
      // The 'error' path above may have settled this child already, and after a
      // restart `this._proc` is a NEWER child — never touch another run's state.
      if (this._proc !== child) return;
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
      this._proc.kill();
      this._proc = null;
    }
  }
}

module.exports = { MediamtxSupervisor };
