import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MediamtxSupervisor } = require('../main/mediamtx.js');

// Review correctness-4 (gift-blocking, armed by boundaries-1): a mediamtx that
// is PRESENT but unrunnable — Defender quarantine, mark-of-the-web, a
// wrong-arch binary — makes spawn() return cleanly and then emit 'error'.
// With no 'error' listener that is an UNCAUGHT EXCEPTION in the Electron main
// process, i.e. the whole viewer dies instead of the documented soft-fail
// ("video disabled; HUD + telemetry still work").
//
// The fake child below is a REAL EventEmitter, so this suite is a genuine
// regression proof: EventEmitter#emit('error') with no listener THROWS, so
// deleting the handler fails these tests loudly rather than silently.
//
// No real process is ever spawned here (workspace rule).

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

function harness() {
  const children = [];
  const logs = [];
  const sup = new MediamtxSupervisor({
    // process.execPath exists on every host, so start()'s existsSync guard
    // passes and the spawn seam is reached — the point of the test is the
    // PRESENT-but-unrunnable case, which that guard cannot see.
    binaryPath: process.execPath,
    configPath: '/tmp/mediamtx.yml',
    log: (m) => logs.push(m),
    spawnFn: () => {
      const c = fakeChild();
      children.push(c);
      return c;
    },
  });
  return { sup, children, logs };
}

const errored = (code) => Object.assign(new Error(`spawn ${code}`), { code });

describe("MediamtxSupervisor 'error' handling (review correctness-4)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('a present-but-unrunnable binary is a SOFT fail: the error is handled, not thrown', () => {
    const { sup, children, logs } = harness();
    sup.start();
    expect(children).toHaveLength(1);
    // The regression itself: with no listener this emit throws out of the
    // supervisor and, in production, out of the main process.
    expect(() => children[0].emit('error', errored('EACCES'))).not.toThrow();
    expect(logs.join('\n')).toMatch(/could not start \(EACCES\)/);
    expect(logs.join('\n')).toMatch(/video is off/);
    sup.stop();
  });

  it("Node fires NO 'exit' after a spawn error, so the retry is armed by the error path itself", () => {
    const { sup, children } = harness();
    sup.start();
    children[0].emit('error', errored('UNKNOWN'));
    expect(children).toHaveLength(1);
    vi.advanceTimersByTime(2000);
    expect(children).toHaveLength(2); // one retry, from the error path
    sup.stop();
  });

  it('stop() wins: a late error from the stopped child arms no retry and logs nothing new', () => {
    const { sup, children, logs } = harness();
    sup.start();
    const child = children[0];
    sup.stop();
    const before = logs.length;
    expect(() => child.emit('error', errored('EACCES'))).not.toThrow();
    vi.advanceTimersByTime(10000);
    expect(children).toHaveLength(1); // nothing respawned after a deliberate stop
    expect(logs.length).toBe(before);
  });

  it('the identity guard holds: a late error from a REPLACED child never touches the live one', () => {
    const { sup, children } = harness();
    sup.start();
    const first = children[0];
    first.emit('exit', 1);
    vi.advanceTimersByTime(2000);
    expect(children).toHaveLength(2);
    const second = children[1];

    // The replaced child now reports its own failure, late.
    expect(() => first.emit('error', errored('EACCES'))).not.toThrow();
    vi.advanceTimersByTime(10000);
    // No third child: the stale event neither cleared the live process nor
    // armed a second restart timer.
    expect(children).toHaveLength(2);

    // …and the live child is still the one the supervisor stops.
    sup.stop();
    expect(second.kill).toHaveBeenCalledTimes(1);
    expect(first.kill).not.toHaveBeenCalled();
  });

  it("the pre-existing 'exit' restart behaviour is unchanged by the refactor", () => {
    const { sup, children, logs } = harness();
    sup.start();
    children[0].emit('exit', 3);
    expect(logs.join('\n')).toMatch(/exited \(code 3\); restarting in 2s/);
    vi.advanceTimersByTime(2000);
    expect(children).toHaveLength(2);
    sup.stop();
  });

  it('a MISSING binary still short-circuits before any spawn (the older, narrower soft-fail)', () => {
    const spawnFn = vi.fn();
    const logs = [];
    const sup = new MediamtxSupervisor({
      binaryPath: '/definitely/not/here/mediamtx',
      configPath: '/tmp/mediamtx.yml',
      log: (m) => logs.push(m),
      spawnFn,
    });
    sup.start();
    expect(spawnFn).not.toHaveBeenCalled();
    expect(logs.join('\n')).toMatch(/binary not found/);
  });
});

// --- the config the phone depends on (owner adjudication OD-16 / Q8) --------
// The phone's cockpit view pulls WHEP from THIS process over the car Wi-Fi
// hotspot. Two things have to hold, and both live in the checked-in config
// rather than in code, so they are asserted from the file itself.
describe('mediamtx.yml — reachable from the hotspot, not only from loopback', () => {
  const yml = readFileSync(new URL('../mediamtx/mediamtx.yml', import.meta.url), 'utf8');
  const value = (key) => {
    const line = yml.split('\n').find((l) => l.startsWith(`${key}:`));
    return line ? line.slice(key.length + 1).trim() : null;
  };

  it('the WHEP endpoint binds EVERY interface (a bare :port), which it always did', () => {
    expect(value('webrtcAddress')).toBe(':8889');
    expect(value('webrtcLocalUDPAddress')).toBe(':8189');
  });

  it('the ICE host candidates include the hotspot address the phone sees, and still loopback', () => {
    const hosts = value('webrtcAdditionalHosts');
    // 127.0.0.1 serves the laptop's own renderer; 192.168.137.1 is the address
    // the phone is expected to see. Without it the phone can complete
    // signalling and then receive nothing.
    expect(hosts).toContain('127.0.0.1');
    expect(hosts).toContain('192.168.137.1');
  });

  it('the ICS address the config advertises is in the /24 this app itself looks for — and says the .1 is unverified', () => {
    const hotspotSrc = readFileSync(new URL('../main/hotspot.js', import.meta.url), 'utf8');
    // Review finding 8: what the code checks is the PREFIX, not the last octet.
    // The config used to claim the hotspot "always takes" .1 and cite this
    // function as support; it does not support that.
    expect(hotspotSrc).toContain("startsWith('192.168.137.')");
    expect(value('webrtcAdditionalHosts')).toContain('192.168.137.');
    // So the claim is hedged where it is made, the way the giftee doc hedges it.
    expect(yml).toContain('[win-TBD]');
    expect(yml).not.toContain('the hotspot always takes');
  });
});
