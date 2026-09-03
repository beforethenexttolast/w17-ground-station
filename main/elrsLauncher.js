// elrs-joystick-control launcher: LAUNCH-ONLY, by explicit safety decision.
//
// That program is the actual control path (DualShock -> CRSF -> ELRS). This
// viewer may START it as a convenience, but must never be able to take it
// down or talk to it: the child is spawned DETACHED with all stdio ignored
// and immediately unref()ed — no pipes, no IPC channel, no handle kept, and
// this module deliberately has NO kill/stop/restart function. If the ground
// station crashes or quits, elrs-joystick-control keeps driving the car.
// (test/noControlPath.test.js pins these properties structurally.)

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { parseTasklistCsv, parsePgrepOutput, imageNameFromPath } = require('../shared/processList.js');
const { scrubW17Env } = require('../shared/childEnv.js');
const { runCommand } = require('./runCommand.js');

class ElrsLauncher {
    // spawnFn / env / existsSync are TEST SEAMS only (no real process is ever
    // created in the suite); the defaults are the production wiring.
    constructor({
        run = runCommand,
        log = () => {},
        platform = process.platform,
        spawnFn = spawn,
        env = process.env,
        existsSync = fs.existsSync,
    } = {}) {
        this._run = run;
        this._log = log;
        this._platform = platform;
        this._spawn = spawnFn;
        this._env = env;
        this._existsSync = existsSync;
    }

    // Fire-and-forget. The result only says whether the spawn call succeeded;
    // liveness afterwards is detectRunning()'s job (GRID re-polls it).
    launchDetached(elrsPath) {
        if (!elrsPath) return { ok: false, error: 'no elrs-joystick-control path configured' };
        if (!this._existsSync(elrsPath)) return { ok: false, error: `not found: ${elrsPath}` };
        try {
            const child = this._spawn(elrsPath, [], {
                detached: true,
                stdio: 'ignore',
                cwd: path.dirname(elrsPath),
                // Scrubbed environment (review boundaries-4/5). This launch stays
                // deliberately "like a human would start it" in every other
                // respect — detached, own console, never stopped from here — but
                // it starts the SAME program race day manages, so it must not be
                // the one door through which a stray W17_* variable reaches the
                // mapper. Race day adopts an externally-launched instance as
                // ok/'external', so an un-scrubbed launch here would survive as
                // race day's drive program.
                env: scrubW17Env(this._env),
                windowsHide: false, // it has its own UI/console — let it show
            });
            // Review correctness-3 (the same shape as correctness-4 on the
            // mediamtx supervisor): spawn() returns cleanly and reports a
            // START failure asynchronously as an 'error' event — EACCES,
            // ENOEXEC, UNKNOWN: a program that is PRESENT (existsSync above
            // passed) but cannot be executed, e.g. quarantined by Defender or
            // carrying the mark-of-the-web. An 'error' event with no listener
            // is an uncaught exception, so the try/catch around spawn does NOT
            // cover it and the GRID's convenience button would take the whole
            // viewer down. This listener is the entire fix: log it and let the
            // GRID's own re-poll (detectRunning) report the program as not
            // running, which is the truth.
            //
            // Nothing is "settled" here the way the mapper runner settles
            // state: this launcher deliberately keeps NO handle on the child
            // (that is the launch-only contract), so the closure's own `child`
            // is the only identity involved and a late event can clobber
            // nothing.
            child.on('error', (err) => {
                const code = (err && (err.code || err.message)) || 'unknown';
                this._log(`[elrs] could not start ${elrsPath} (${code}); it is not running`);
            });
            child.unref();
            this._log(`[elrs] launched detached: ${elrsPath} (this app will never stop it)`);
            return { ok: true };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    }

    async detectRunning(elrsPath) {
        const image = imageNameFromPath(elrsPath);
        if (!image) return { configured: false, detected: false };
        if (this._platform === 'win32') {
            const res = await this._run('tasklist', [
                '/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH',
            ]);
            return {
                configured: true,
                detected: res.ok && parseTasklistCsv(res.stdout, image) > 0,
                method: 'tasklist',
            };
        }
        const res = await this._run('pgrep', ['-f', image]);
        return {
            configured: true,
            detected: res.ok && parsePgrepOutput(res.stdout) > 0,
            method: 'pgrep',
        };
    }
}

module.exports = { ElrsLauncher };
