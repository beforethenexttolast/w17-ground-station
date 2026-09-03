// Companion for 40-mdns-udp.ps1 — browses for the iPhone HUD's mDNS
// advertisement using the app's OWN wire codec and policy modules
// (shared/dnsWire.js: buildQuery; shared/hudDiscovery.js: SERVICE_TYPE,
// hudsFromDatagram), the same two pure modules main/HudDiscovery.js wires up
// (main/HudDiscovery.js:34). This is a bench harness around those two
// modules, not a parallel mDNS implementation — SERVICE_TYPE comes from
// shared/hudDiscovery.js:27 (`_w17hud._udp.local`), which is the canonical
// value the contract also names — canonically at
// iPhone_rc/docs/windows_bridge_contract.md:95/111, mirrored in this repo at
// docs/windows_bridge_contract.md:119/135 (the iPhone copy is the authority;
// see this repo's mirror banner) — so a drift
// between the doc and the code would show up here as a mismatch, not just
// asserted.
//
// Run under the app's own Electron binary in Node mode (ELECTRON_RUN_AS_NODE
// = 1), same convention as hotspot-probe.js:
//   & <installDir>\<exe> <this file> <appAsarPath> [timeoutMs]
//
// No real iPhone is expected to be reachable during an autonomous VM session
// (owner decision A4: the owner connects adapters; no phone was on hand for
// this validation pass either — docs/windows_bridge_contract.md's own
// discovery section says the same, HudDiscovery.js:34). An empty result after
// the timeout is therefore NOT a failure by itself; 40-mdns-udp.ps1 treats
// "the query went out and the socket behaved" as the pass condition, and logs
// whatever candidates (if any) came back for the record.

'use strict';

const dgram = require('node:dgram');
const os = require('node:os');
const path = require('node:path');

const appRoot = process.argv[2];
const timeoutMs = Number(process.argv[3]) || 4000;

function fail(kind, message) {
  process.stdout.write(`MDNS_PROBE_RESULT: ${JSON.stringify({ ok: false, kind, error: message })}\n`);
  process.exit(1);
}

if (!appRoot) fail('bad-args', 'usage: mdns-probe.js <appAsarOrRoot> [timeoutMs]');

let buildQuery;
let SERVICE_TYPE;
let hudsFromDatagram;
try {
  ({ buildQuery } = require(path.join(appRoot, 'shared', 'dnsWire.js')));
  ({ SERVICE_TYPE, hudsFromDatagram } = require(path.join(appRoot, 'shared', 'hudDiscovery.js')));
} catch (err) {
  fail('module-load-failed', `could not load the app's own mDNS modules from ${appRoot}: ${err.message}`);
}

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;

function localIpv4Addresses() {
  const out = [];
  let ifaces;
  try { ifaces = os.networkInterfaces(); } catch { return out; }
  for (const list of Object.values(ifaces || {})) {
    for (const iface of list || []) {
      const isV4 = iface.family === 'IPv4' || iface.family === 4;
      if (isV4 && typeof iface.address === 'string' && !out.includes(iface.address)) out.push(iface.address);
    }
  }
  return out;
}

const found = new Map(); // addr -> hud
const rejected = [];

const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
socket.on('error', (err) => fail('socket-error', err.message));
socket.on('message', (buf, rinfo) => {
  const res = hudsFromDatagram(buf, { serviceType: SERVICE_TYPE });
  if (!res.ok) return;
  for (const r of res.rejected) rejected.push({ from: rinfo.address, reason: r.reason });
  for (const hud of res.huds) {
    if (hud.ttl === 0) { found.delete(hud.addr); continue; }
    if (rinfo.address && hud.addr !== rinfo.address) continue; // sender/address mismatch — same policy as HudDiscovery.js:139-142
    found.set(hud.addr, hud);
  }
});

socket.bind(() => {
  try { socket.setMulticastTTL(255); } catch { /* best-effort, same as HudDiscovery.js:220 */ }
  const packet = buildQuery(SERVICE_TYPE);
  const addrs = localIpv4Addresses();
  const targets = addrs.length ? addrs : [null];
  for (const addr of targets) {
    try {
      if (addr) socket.setMulticastInterface(addr);
    } catch { /* interface may not support multicast — try the send anyway */ }
    socket.send(packet, 0, packet.length, MDNS_PORT, MDNS_ADDR, () => {});
  }
});

setTimeout(() => {
  const result = {
    ok: true,
    serviceType: SERVICE_TYPE,
    queried: true,
    localIpv4Addresses: localIpv4Addresses(),
    hudsFound: Array.from(found.values()),
    rejectedAdvertisements: rejected.slice(0, 10),
  };
  process.stdout.write(`MDNS_PROBE_RESULT: ${JSON.stringify(result)}\n`);
  try { socket.close(); } catch { /* already closing */ }
  process.exit(0);
}, timeoutMs);
