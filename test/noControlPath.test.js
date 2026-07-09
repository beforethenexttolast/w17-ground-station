import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as crsf from '../shared/crsf.js';

// The W2 bridge must remain viewer-only: it exports telemetry OUT and opens NO
// control path back to the car. These guards fail loudly if a future edit adds
// an RC-channel encoder, a serial write, or a UDP receiver to the bridge files.

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

  it('head-tracking intent is consumed only by main.js and its own modules (module graph)', () => {
    // No other runtime module may import the head-tracking code -- importing it
    // anywhere else (renderer, bridge, telemetry) would be the first step of a
    // control path and must fail review + CI.
    const runtimeFiles = [
      '../main/IphoneTelemetryBridge.js', '../main/iphoneBridgeConfig.js',
      '../main/CrsfSerialSource.js', '../main/mediamtx.js', '../main/preload.cjs',
      '../shared/telemetrySnapshot.js', '../shared/telemetry.js', '../shared/crsf.js',
      '../shared/crsfTelemetry.js', '../shared/crsfAssembler.js', '../shared/replaySource.js',
      '../shared/linkState.mjs', '../renderer/hud.js', '../renderer/whep.js',
    ];
    for (const file of runtimeFiles) {
      const src = read(file);
      expect(src, `${file} must not import head-tracking code`).not.toMatch(/headTracking|HeadTracking/);
    }
    // main.js may construct it, but must not wire its data anywhere: the only
    // references are require/construct/start/stop -- never a data read.
    const main = read('../main/main.js');
    expect(main).not.toContain('getDiagnostics');
    expect(main).not.toMatch(/headTracking\.(on|emit|pipe)/);
  });

  // --- Setup-flow additions (settings/session runtime): same dead-end rules. ---
  // These modules are new consumers of NOTHING head-tracking-related and must
  // stay that way: no head-tracking imports, no control/servo/serial tokens.
  // (shared/settings.js only carries the user's W17_HEADTRACK env-override flag
  // and the w3DiagnosticEnabled boolean wish — main.js alone resolves those
  // into the receiver, which is why the camelCase import ban still holds.)

  it('setup-flow modules import no head-tracking code and no control API', () => {
    const setupFlowFiles = [
      '../shared/settings.js', '../main/settingsStore.js', '../main/sessionRuntime.js',
      '../shared/wifiParse.js', '../shared/processList.js', '../shared/inputPresets.mjs',
      '../main/runCommand.js', '../main/wifiManager.js', '../main/hotspot.js',
      '../main/elrsLauncher.js', '../main/hostProbe.js', '../main/remoteAddrHint.js',
    ];
    for (const file of setupFlowFiles) {
      const src = read(file);
      expect(src, `${file} must not import head-tracking code`).not.toMatch(/headTracking|HeadTracking/);
      for (const forbidden of [
        'serialport', 'SerialPort', 'CrsfFrameBuilder', 'RcChannels',
        'buildRcChannels', 'encodeRcChannels', 'setPosition', 'setThrottle', 'ledc',
      ]) {
        expect(src, `${file} must not reference ${forbidden}`).not.toContain(forbidden);
      }
    }
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
