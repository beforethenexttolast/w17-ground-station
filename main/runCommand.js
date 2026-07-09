// Tiny promise wrapper around child_process.spawn for the setup-flow's OS
// queries (netsh / powershell / tasklist / ping). SECURITY RULE: args is
// always an ARRAY — values that originated as user input (SSIDs, passwords,
// paths, addresses) ride argv verbatim and are never interpolated into a
// shell string, so there is nothing to inject into. shell:false always.

const { spawn } = require('node:child_process');

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
            try { child.kill(); } catch { /* already gone */ }
            finish({ ok: false, code: null, stdout, stderr: `timeout after ${timeoutMs}ms` });
        }, timeoutMs);
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', (err) => finish({ ok: false, code: null, stdout, stderr: String(err.message) }));
        child.on('close', (code) => finish({ ok: code === 0, code, stdout, stderr }));
    });
}

module.exports = { runCommand };
