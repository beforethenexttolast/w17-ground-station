// Companion for 30-hotspot.ps1 — drives the EXACT hotspot mechanism the
// installed ground station uses, by requiring the app's OWN modules
// (main/hotspot.js: HotspotManager; main/hotspotVerify.js:
// createHotspotVerifier) out of its packaged app.asar and calling the same
// methods appWiring.js:createNetworkServices (appWiring.js:49-79) wires up.
// This is deliberately NOT a re-implementation of the WinRT/netsh calls: a
// second copy of those PowerShell script bodies would drift from the real
// ones over time, and the whole point of this validation pass is to prove
// what the SHIPPED code does, not what a parallel guess does.
//
// Run under the app's own Electron binary in Node mode (ELECTRON_RUN_AS_NODE
// = 1 — a plain `node.exe` cannot read app.asar; Electron's bundled Node can,
// asar-transparently, in EITHER mode). 30-hotspot.ps1 invokes this as:
//   $env:ELECTRON_RUN_AS_NODE = '1'
//   & <installDir>\<exe> <this file> <appAsarPath> <action> [method]
//
// Actions: probe | start | verify | stop
// SSID/password for `start` ride environment variables (W17_VAL_HOTSPOT_SSID /
// W17_VAL_HOTSPOT_PASS), never argv — the same discipline hotspot.js itself
// uses for the WinRT script (hotspot.js:100-101 reads $env:W17_HOTSPOT_SSID /
// $env:W17_HOTSPOT_PASS) so a credential can never show up in a process list.
//
// Every result prints as ONE line of JSON on stdout, prefixed HOTSPOT_PROBE_
// RESULT: — 30-hotspot.ps1 parses only that line; nothing else on stdout is
// machine-read. Never logs the password.

'use strict';

const path = require('node:path');

function fail(kind, message) {
  process.stdout.write(`HOTSPOT_PROBE_RESULT: ${JSON.stringify({ ok: false, kind, error: message })}\n`);
  process.exit(1);
}

const appRoot = process.argv[2];
const action = process.argv[3];
const backendHint = process.argv[4] || null;

if (!appRoot || !action) {
  fail('bad-args', 'usage: hotspot-probe.js <appAsarOrRoot> <probe|start|verify|stop> [backend]');
}

let HotspotManager;
let createHotspotVerifier;
try {
  ({ HotspotManager } = require(path.join(appRoot, 'main', 'hotspot.js')));
  ({ createHotspotVerifier } = require(path.join(appRoot, 'main', 'hotspotVerify.js')));
} catch (err) {
  fail('module-load-failed', `could not load the app's own hotspot modules from ${appRoot}: ${err.message}`);
}

const log = (m) => process.stderr.write(`[hotspot-probe] ${m}\n`); // diagnostics only — never the JSON result line
const manager = new HotspotManager({ log });
const verify = createHotspotVerifier({ log });

async function main() {
  if (action === 'probe') {
    const res = await manager.probeBackends();
    return res;
  }
  if (action === 'start') {
    const ssid = process.env.W17_VAL_HOTSPOT_SSID;
    const password = process.env.W17_VAL_HOTSPOT_PASS;
    if (!ssid || !password) fail('bad-args', 'W17_VAL_HOTSPOT_SSID / W17_VAL_HOTSPOT_PASS must be set in the environment');
    const res = await manager.start({ ssid, password });
    // Never echo the password back — HotspotManager's own result shape
    // already omits it (hotspot.js:265-297), this is defense in depth.
    if (res && 'password' in res) delete res.password;
    return res;
  }
  if (action === 'verify') {
    return verify({ backend: backendHint || manager.active() });
  }
  if (action === 'stop') {
    return manager.stop();
  }
  fail('bad-args', `unknown action "${action}" (expected probe|start|verify|stop)`);
}

main()
  .then((result) => {
    process.stdout.write(`HOTSPOT_PROBE_RESULT: ${JSON.stringify({ ok: true, action, result })}\n`);
    process.exit(0);
  })
  .catch((err) => {
    fail('threw', err && err.stack ? err.stack : String(err));
  });
