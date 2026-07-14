// Tiny promise wrapper around child_process.spawn for the setup-flow's OS
// queries (netsh / powershell / tasklist / ping). SECURITY RULE: args is
// always an ARRAY — values that originated as user input (SSIDs, passwords,
// paths, addresses) ride argv verbatim and are never interpolated into a
// shell string, so there is nothing to inject into. shell:false always.

const { spawn } = require('node:child_process');

// Windows tree-kill argv (audit N4): `taskkill /pid <pid> /t /f` takes down the
// whole process TREE (a hung PowerShell/netsh can spawn WinRT children that
// child.kill() alone would orphan). Pure + exported so the exact flags are
// regression-tested without needing a real hung process (audit D4). `/t` = the
// tree, `/f` = force.
const winTreeKillArgs = (pid) => ['/pid', String(pid), '/t', '/f'];

function runCommand(cmd, args, { timeoutMs = 15000, env } = {}) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(cmd, args, {
                shell: false,
                windowsHide: true,
                env: env ? { ...process.env, ...env } : process.env,
            });
        } catch (err) {
            resolve({ ok: false, code: null, stdout: '', stderr: String(err.message) });
            return;
        }
        let stdout = '';
        let stderr = '';
        let done = false;
        const finish = (result) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(result);
        };
        const timer = setTimeout(() => {
            try {
                // child.kill() does NOT kill the process TREE on Windows, so a
                // hung PowerShell/netsh can orphan WinRT work (audit N4). Use
                // taskkill /T to take the whole tree down; fall back to kill()
                // elsewhere (and if pid is already gone). Fire-and-forget.
                if (process.platform === 'win32' && child.pid) {
                    spawn('taskkill', winTreeKillArgs(child.pid), { windowsHide: true })
                        .on('error', () => { try { child.kill(); } catch { /* already gone */ } });
                } else {
                    child.kill();
                }
            } catch { /* already gone */ }
            finish({ ok: false, code: null, stdout, stderr: `timeout after ${timeoutMs}ms` });
        }, timeoutMs);
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', (err) => finish({ ok: false, code: null, stdout, stderr: String(err.message) }));
        child.on('close', (code) => finish({ ok: code === 0, code, stdout, stderr }));
    });
}

module.exports = { runCommand, winTreeKillArgs };
