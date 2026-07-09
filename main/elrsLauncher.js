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
const { runCommand } = require('./runCommand.js');

class ElrsLauncher {
    constructor({ run = runCommand, log = () => {}, platform = process.platform } = {}) {
        this._run = run;
        this._log = log;
        this._platform = platform;
    }

    // Fire-and-forget. The result only says whether the spawn call succeeded;
    // liveness afterwards is detectRunning()'s job (GRID re-polls it).
    launchDetached(elrsPath) {
        if (!elrsPath) return { ok: false, error: 'no elrs-joystick-control path configured' };
        if (!fs.existsSync(elrsPath)) return { ok: false, error: `not found: ${elrsPath}` };
        try {
            const child = spawn(elrsPath, [], {
                detached: true,
                stdio: 'ignore',
                cwd: path.dirname(elrsPath),
                windowsHide: false, // it has its own UI/console — let it show
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
