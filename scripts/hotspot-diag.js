// Bench diagnostic for the Mobile Hotspot WinRT PowerShell path (audit H1).
// Runs the ACTUAL fail-closed scripts exported by main/hotspot.js against real
// Windows PowerShell 5.1 and prints raw output + the interpreted result token,
// so the bench operator can confirm the backend before trusting the in-app
// flow. Mocked unit tests can pin the script STRUCTURE but never its real WinRT
// behavior — this is where that gap is closed on the bench host.
//
// Usage (on the Windows bench host):
//   node scripts/hotspot-diag.js                    # probe only (read-only, safe)
//   node scripts/hotspot-diag.js --start SSID PW    # configure + start (pw 8+ chars)
//   node scripts/hotspot-diag.js --stop             # stop tethering
//
// SECURITY: SSID/password ride process ENV, never the script text (same as the
// app). This tool never persists credentials and never prints the password.

const { PS_SCRIPTS } = require('../main/hotspot.js');
const { runCommand } = require('../main/runCommand.js');

const psArgs = (script) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];

async function run(label, script, env) {
  console.log(`\n=== ${label} ===`);
  const res = await runCommand('powershell', psArgs(script), { timeoutMs: 30000, env });
  console.log(`exit ok=${res.ok} code=${res.code}`);
  console.log(`stdout: ${JSON.stringify(res.stdout)}`);
  console.log(`stderr: ${JSON.stringify(res.stderr)}`);
  return res;
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('[hotspot-diag] Windows-only — this validates the real WinRT PowerShell path.');
    process.exit(1);
  }
  const args = process.argv.slice(2);
  if (args[0] === '--start') {
    const ssid = args[1];
    const pass = args[2];
    if (!ssid || !pass || pass.length < 8) {
      console.error('usage: node scripts/hotspot-diag.js --start "SSID" "password(8+ chars)"');
      process.exit(1);
    }
    await run('PROBE', PS_SCRIPTS.probe);
    const res = await run('START', PS_SCRIPTS.start, { W17_HOTSPOT_SSID: ssid, W17_HOTSPOT_PASS: pass });
    console.log(
      res.stdout.includes('START_OK')
        ? `\n[hotspot-diag] START_OK — verify SSID "${ssid}" is visible on a phone, then run: node scripts/hotspot-diag.js --stop`
        : '\n[hotspot-diag] start did NOT report START_OK — read the tokens above (the app would not claim success either).',
    );
  } else if (args[0] === '--stop') {
    await run('STOP', PS_SCRIPTS.stop);
  } else {
    await run('PROBE', PS_SCRIPTS.probe);
    console.log('\n[hotspot-diag] probe only. Use --start "SSID" "pw" to test tethering, then --stop.');
  }
}

main().catch((e) => {
  console.error(`[hotspot-diag] ${e.message}`);
  process.exit(1);
});
