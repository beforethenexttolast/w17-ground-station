import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as crsf from '../shared/crsf.js';

// The W2 bridge must remain viewer-only: it exports telemetry OUT and opens NO
// control path back to the car. These guards fail loudly if a future edit adds
// an RC-channel encoder, a serial write, or a UDP receiver to the bridge files.
//
// Two layers (audit D1 strengthens the second):
//   1. Targeted SEMANTIC assertions on the specific inert files (bridge is
//      send-only, receiver feeds nothing, the W3 addr seam is IP-only, …).
//      These know each file's job and pin it precisely.
//   2. A DIRECTORY SWEEP over every runtime module under main/ shared/ renderer/
//      (audit V1). It does not depend on an enumerated file list, so a NEW
//      runtime module cannot silently bypass the control-path bans — it is
//      discovered automatically the moment it lands in one of those dirs.

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('no-control-path regression (contract A + E)', () => {
  it('shared/crsf.js exposes NO RC-channel encoder — decode only', () => {
    const encoderLike = Object.keys(crsf).filter((k) => /^(encode|build)/i.test(k));
    expect(encoderLike).toEqual([]);
    // The decoders we DO expect are still present (sanity: we didn't neuter it).
    expect(typeof crsf.decodeFrame).toBe('function');
  });

  it('the telemetry bridge writes no serial and touches no control/servo API', () => {
    const src = read('../main/IphoneTelemetryBridge.js');
    for (const forbidden of [
      'serialport', 'SerialPort', 'CrsfFrameBuilder', 'RcChannels',
      'buildRcChannels', 'encodeRcChannels', 'setPosition', 'setThrottle', 'ledc',
    ]) {
      expect(src, `bridge must not reference ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('the telemetry bridge is send-only — it does not bind or receive datagrams', () => {
    const src = read('../main/IphoneTelemetryBridge.js');
    expect(src).toContain('.send('); // it sends
    expect(src).not.toContain('.bind(');
    expect(src).not.toContain("on('message'");
    expect(src).not.toContain('on("message"');
    expect(src).not.toContain('onmessage');
  });

  it('the snapshot builder is pure telemetry — no CRSF, channel, or serial references', () => {
    const src = read('../shared/telemetrySnapshot.js').toLowerCase();
    // "crsf" appears only in a doc comment about NOT sending raw CRSF; assert no
    // code-level channel/serial handling.
    expect(src).not.toContain('serialport');
    expect(src).not.toContain('channels[');
    expect(src).not.toContain('setposition');
  });

  // --- W3: the head-tracking receiver must be a log-only dead end. ---

  it('the head-tracking modules touch no control/servo/serial/CRSF API', () => {
    for (const file of ['../main/HeadTrackingReceiver.js', '../shared/headTracking.js', '../main/headTrackingConfig.js']) {
      const src = read(file);
      for (const forbidden of [
        'serialport', 'SerialPort', 'CrsfFrameBuilder', 'RcChannels',
        'buildRcChannels', 'encodeRcChannels', 'setPosition', 'setThrottle', 'ledc',
      ]) {
        expect(src, `${file} must not reference ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('the head-tracking receiver feeds NOTHING: no telemetry source, no IPC, no renderer, no outbound bridge', () => {
    const src = read('../main/HeadTrackingReceiver.js');
    for (const forbidden of [
      'TelemetrySource', 'webContents', 'ipcMain', 'ipcRenderer',
      'IphoneTelemetryBridge', 'onTelemetry', 'onCommandMirror', 'send(',
    ]) {
      expect(src, `receiver must not reference ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('head-tracking intent is wired ONLY inside main.js — and there it is constructed, never read', () => {
    // main.js may construct the receiver, but must not wire its data anywhere:
    // the only references are require/construct/start/stop — never a data read.
    // (The directory sweep below proves NO OTHER runtime module even mentions
    // head-tracking; this pins main.js's own inertness.)
    const main = read('../main/main.js');
    expect(main).not.toContain('getDiagnostics');
    expect(main).not.toMatch(/headTracking\.(on|emit|pipe)/);
  });

  it('the elrs launcher is launch-only: detached spawn, no pipes, no kill, no IPC', () => {
    const src = read('../main/elrsLauncher.js');
    // Must launch fire-and-forget…
    expect(src).toContain('detached: true');
    expect(src).toContain("stdio: 'ignore'");
    expect(src).toContain('.unref()');
    // …and must have NO way to stop or talk to the control app.
    for (const forbidden of [
      '.kill(', 'stdin', "on('message'", 'on("message"', 'ipcMain', 'webContents',
    ]) {
      expect(src, `elrs launcher must not reference ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('the W3 address-suggestion seam carries the sender IP string and NOTHING else', () => {
    // Receiver side: the sink is called with exactly rinfo.address — widening
    // it to pass packet contents must fail here first.
    const receiver = read('../main/HeadTrackingReceiver.js');
    expect(receiver).toMatch(/_noteRemoteAddr\(rinfo\.address\)/);
    expect(receiver).not.toMatch(/noteRemoteAddr\((?!rinfo\.address\))/);
    // Store side: transport metadata only — no orientation/intent vocabulary.
    const hint = read('../main/remoteAddrHint.js');
    for (const forbidden of ['yaw', 'pitch', 'roll', 'quaternion', 'centered', 'tracking_enabled', 'ingest', 'Monitor']) {
      expect(hint, `remoteAddrHint must not reference ${forbidden}`).not.toContain(forbidden);
    }
    expect(hint).not.toContain('ipcMain');
    expect(hint).not.toContain('dgram');
  });
});

// --- audit D1: directory sweep (no enumerated file list) --------------------
// V1 in the audit: the old guard scanned a hardcoded list of files, so a NEW
// runtime module importing head-tracking or a control encoder passed CI until
// someone remembered to append it. This sweep walks the runtime dirs instead,
// so discovery is automatic.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SWEPT_DIRS = ['main', 'shared', 'renderer'];

// Extensions we treat as executable RUNTIME code (scanned) vs. non-code ASSETS
// (present in the dirs, deliberately not scanned). Anything with an extension
// in NEITHER set is surfaced as `unknown` so a novel artifact type (a `.ts`, a
// generated bundle, …) can't slip past unclassified — the guard fails until it
// is intentionally categorized here.
const RUNTIME_EXT = new Set(['.js', '.mjs', '.cjs']);
const ASSET_EXT = new Set(['.css', '.html', '.map', '.json', '.png', '.svg', '.ico', '.icns', '.txt', '.md', '.yml', '.yaml']);
const TEST_FILE_RE = /\.(test|spec)\.(js|mjs|cjs)$/;

// Control-OUTPUT primitives. These must never appear in ANY runtime file —
// there is no legitimate producer of car outputs anywhere in this viewer. Swept
// universally (no exceptions).
const ALWAYS_FORBIDDEN = [
  'CrsfFrameBuilder', 'buildRcChannels', 'encodeRcChannels', 'RcChannels',
  'setPosition', 'setThrottle', 'ledc',
];

// Serial I/O tokens. A serial WRITE would be a control path, so they are banned
// everywhere EXCEPT the two files that legitimately touch the read-only CRSF
// telemetry backchannel (telemetry IN, never control OUT — the ALWAYS_FORBIDDEN
// sweep still proves neither carries a control-output primitive):
//   - main/CrsfSerialSource.js — opens the serial port to READ CRSF telemetry.
//   - shared/crsfTelemetry.js  — names "serialport" only in a "pure (no
//     serialport)" comment; carries no port at all.
const SERIAL_TOKENS = ['serialport', 'SerialPort'];
const SERIAL_ALLOWED = new Set(['main/CrsfSerialSource.js', 'shared/crsfTelemetry.js']);

// Head-tracking (W3) intent may be referenced ONLY by the receiver's own
// modules and by main.js (the single wiring site, which constructs it and reads
// nothing — pinned above). Every other runtime module mentioning it would be
// the first step of a control path. Matched on the camelCase identifiers so
// harmless UI prose ("HEAD-TRACK LOGGING") never trips the guard.
const HEADTRACK_RE = /headTracking|HeadTracking/;
const HEADTRACK_ALLOWED = new Set([
  'main/main.js', 'main/HeadTrackingReceiver.js', 'main/headTrackingConfig.js', 'shared/headTracking.js',
]);

// Walk a directory tree WITHOUT following symlinks: a symlink could point
// outside the repo and cause uncontrolled traversal (or a scan of attacker
// content), so it is recorded as `unknown` (surfaced, never traversed). Returns
// { runtime, assets, unknown } of { abs, rel } entries; `rel` is relative to
// `baseDir` for readable failures and exception matching.
function discover(absDir, baseDir) {
  const runtime = [];
  const assets = [];
  const unknown = [];
  const toRel = (abs) => relative(baseDir, abs).split(sep).join('/');
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, ent.name);
      const rel = toRel(abs);
      if (ent.isSymbolicLink()) { unknown.push({ abs, rel, why: 'symlink (not traversed)' }); continue; }
      if (ent.isDirectory()) { walk(abs); continue; }
      if (!ent.isFile()) continue;
      if (TEST_FILE_RE.test(ent.name)) continue; // tests are not runtime
      const ext = extname(ent.name);
      if (RUNTIME_EXT.has(ext)) runtime.push({ abs, rel });
      else if (ASSET_EXT.has(ext)) assets.push({ abs, rel });
      else unknown.push({ abs, rel, why: `unknown extension "${ext}"` });
    }
  };
  walk(absDir);
  return { runtime, assets, unknown };
}

// Every no-control-path violation in one file, as human-readable strings that
// name the exact matched rule (audit D1: failure output identifies file + rule).
function scanRuntimeFile(rel, src) {
  const violations = [];
  for (const tok of ALWAYS_FORBIDDEN) {
    if (src.includes(tok)) violations.push(`control-output token "${tok}"`);
  }
  if (!SERIAL_ALLOWED.has(rel)) {
    for (const tok of SERIAL_TOKENS) {
      if (src.includes(tok)) violations.push(`serial token "${tok}"`);
    }
  }
  if (!HEADTRACK_ALLOWED.has(rel) && HEADTRACK_RE.test(src)) {
    violations.push('head-tracking reference (import/use outside the allowed wiring site)');
  }
  return violations;
}

function sweepRepo() {
  const runtime = [];
  const assets = [];
  const unknown = [];
  for (const d of SWEPT_DIRS) {
    const r = discover(join(REPO_ROOT, d), REPO_ROOT);
    runtime.push(...r.runtime);
    assets.push(...r.assets);
    unknown.push(...r.unknown);
  }
  return { runtime, assets, unknown };
}

describe('no-control-path directory sweep (audit D1 — no enumerated list)', () => {
  it('every discovered file is classified — no unknown extension or symlink slips through', () => {
    const { unknown } = sweepRepo();
    expect(
      unknown.map((u) => `${u.rel}: ${u.why}`),
      'unclassified files under main/ shared/ renderer/ — classify them in the guard (RUNTIME_EXT/ASSET_EXT) before merging',
    ).toEqual([]);
  });

  it('the sweep actually found the runtime tree (a broken walk must not silently pass)', () => {
    const { runtime } = sweepRepo();
    // 46 runtime modules today (34 .js + 11 .mjs + 1 .cjs); a comfortably low
    // floor guards against a discovery bug that finds nothing and vacuously
    // passes the inertness assertion.
    expect(runtime.length).toBeGreaterThan(30);
  });

  it('NO runtime module under main/ shared/ renderer/ contains a control path', () => {
    const { runtime } = sweepRepo();
    const failures = [];
    for (const { abs, rel } of runtime) {
      for (const v of scanRuntimeFile(rel, readFileSync(abs, 'utf8'))) {
        failures.push(`${rel}: ${v}`);
      }
    }
    expect(failures, `no-control-path violations:\n${failures.join('\n')}`).toEqual([]);
  });

  it('auto-includes newly-added runtime files with NO guard-list edit', () => {
    const runtime = new Set(sweepRepo().runtime.map((f) => f.rel));
    // All added AFTER this guard was first written and present in NO hardcoded
    // list — the sweep finds them purely by walking the dirs. If discovery ever
    // regresses to an enumerated list, this breaks.
    for (const f of [
      'shared/videoState.mjs', 'shared/envLocks.mjs', 'shared/reachability.mjs',
      'shared/keyboardFocus.mjs', 'main/hotspotLifecycle.js', 'main/quitPolicy.js',
    ]) {
      expect(runtime.has(f), `${f} must be discovered by the sweep automatically`).toBe(true);
    }
  });
});

// The mechanism proof: a brand-new runtime file dropped into a scanned dir is
// discovered and flagged WITHOUT touching the guard — the exact failure mode V1
// described (a new module escaping an enumerated list).
describe('no-control-path sweep — discovers a newly-created runtime file (audit D1)', () => {
  it('a new .js module wiring head-tracking into a CRSF encoder is found and flagged; assets/tests/symlinks are not scanned', () => {
    const dir = mkdtempSync(join(tmpdir(), 'w17-sweep-'));
    try {
      // A sneaky new runtime module — the precise class of edit the guard exists
      // to catch: it imports the W3 receiver AND emits RC channels.
      writeFileSync(
        join(dir, 'sneakyControl.js'),
        "const { HeadTrackingReceiver } = require('./HeadTrackingReceiver.js');\n"
        + 'module.exports = { encodeRcChannels: (yaw) => yaw };\n',
      );
      // Non-code + tests must not be treated as runtime; a novel extension must
      // be surfaced as unknown.
      writeFileSync(join(dir, 'styles.css'), 'body{}');
      writeFileSync(join(dir, 'thing.test.js'), 'it("x", () => {});');
      writeFileSync(join(dir, 'weird.ts'), 'export const x = 1;');
      let symlinkMade = false;
      try { symlinkSync('/etc/hosts', join(dir, 'evil.js')); symlinkMade = true; } catch { /* symlink perms (e.g. Windows) */ }

      const found = discover(dir, dir);

      // Discovery: exactly the real runtime file; css/test excluded; ts unknown.
      expect(found.runtime.map((f) => f.rel)).toEqual(['sneakyControl.js']);
      expect(found.assets.map((f) => f.rel)).toEqual(['styles.css']);
      expect(found.unknown.some((u) => u.rel === 'weird.ts')).toBe(true);
      if (symlinkMade) {
        // A .js symlink is surfaced as unknown and NEVER scanned as runtime.
        expect(found.unknown.some((u) => u.rel === 'evil.js')).toBe(true);
        expect(found.runtime.some((f) => f.rel === 'evil.js')).toBe(false);
      }

      // Scan: the planted module is flagged on BOTH counts, naming each rule.
      const src = readFileSync(found.runtime[0].abs, 'utf8');
      const violations = scanRuntimeFile('sneakyControl.js', src);
      expect(violations.join(' | ')).toMatch(/encodeRcChannels/);
      expect(violations.join(' | ')).toMatch(/head-tracking/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the mapper head-intent diagnostics consumer is a subscriber-only, one-way display path (CB8 slice 3B)', () => {
    // The consumer CORE is transport-agnostic and read-only: it never writes to
    // the gRPC call, never names a mapper RPC, and binds no socket (it is a gRPC
    // client, not the 5602 receiver).
    const core = read('../main/HeadIntentDiagnosticsClient.js');
    expect(core).not.toMatch(/\.write\(/);
    for (const forbidden of ['setConfig', 'setCRSFDeviceField', 'startLink', 'stopLink', 'dgram', '.bind(', "on('message'"]) {
      expect(core, `diagnostics client core must not reference ${forbidden}`).not.toContain(forbidden);
    }

    // The gRPC transport factory invokes ONLY the read-only watch RPC.
    const connect = read('../main/headIntentGrpcConnect.js');
    const rpcCalls = [...connect.matchAll(/\.(\w+)\(\{\}\)/g)].map((m) => m[1]); // client.<Method>({})
    expect(rpcCalls).toContain('WatchHeadIntentDiagnostics');
    for (const forbidden of ['setConfig', 'setCRSFDeviceField', 'startLink', 'stopLink', '.write(']) {
      expect(connect, `gRPC factory must not reference ${forbidden}`).not.toContain(forbidden);
    }

    // The renderer-facing surface is RECEIVE-ONLY: the single head-intent preload
    // method is a subscription (ipcRenderer.on + removeListener), never an
    // invoke/send toward main or the mapper.
    const preload = read('../main/preload.cjs');
    const headIntentMethods = [...preload.matchAll(/(\w*HeadIntent\w*)\s*:/g)].map((m) => m[1]);
    expect(headIntentMethods).toEqual(['onHeadIntentDiagnostics']);
    const body = preload.slice(
      preload.indexOf('onHeadIntentDiagnostics:'),
      preload.indexOf('},', preload.indexOf('onHeadIntentDiagnostics:')) + 2,
    );
    expect(body).toContain("ipcRenderer.on('head-intent-diagnostics'");
    expect(body).toContain('removeListener');
    expect(body).not.toContain('invoke');
    expect(body).not.toContain('ipcRenderer.send');
  });

  it('the allow/exception rules are narrow: a serial-exempt path is exempt only for serial, never for control output', () => {
    // CrsfSerialSource is allowed to say "SerialPort" (telemetry IN)…
    expect(scanRuntimeFile('main/CrsfSerialSource.js', 'const { SerialPort } = require("serialport");')).toEqual([]);
    // …but the SAME file would still be flagged for a control-output primitive.
    expect(scanRuntimeFile('main/CrsfSerialSource.js', 'module.exports = { encodeRcChannels(){} };'))
      .toContain('control-output token "encodeRcChannels"');
    // A non-exempt file gets the serial ban.
    expect(scanRuntimeFile('main/IphoneTelemetryBridge.js', 'const { SerialPort } = require("serialport");'))
      .toContain('serial token "SerialPort"');
    // main.js may reference head-tracking; a random module may not.
    expect(scanRuntimeFile('main/main.js', 'new HeadTrackingReceiver()')).toEqual([]);
    expect(scanRuntimeFile('renderer/hud.js', 'import { headTracking } from "x"'))
      .toContain('head-tracking reference (import/use outside the allowed wiring site)');
  });
});
