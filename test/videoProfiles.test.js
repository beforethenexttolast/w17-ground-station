import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import {
  VIDEO_PROFILES, VIDEO_PROFILE_IDS, DEFAULT_VIDEO_PROFILE,
  videoProfileFor, normalizeVideoSettings, VIDEO_PROFILE_RESTART_NOTE,
} from '../shared/videoProfiles.mjs';
import { startWhep, WHEP_PLAYER_DEFAULTS } from '../renderer/whep.js';

const require = createRequire(import.meta.url);
const { MediamtxSupervisor } = require('../main/mediamtx.js');

// Video profiles (vision decision 7). The load-bearing half of this file is
// the DRIVE-EQUALS-TODAY proof: DRIVE is defined as the pre-profile tuning
// (the audit's "single fixed mediamtx path, WHEP pinned to min latency"), so
// these tests pin, at the actual seams, that selecting DRIVE produces the
// EXACT pre-profile configuration — an empty mediamtx override set whose spawn
// options are byte-identical to the historical literal, and player knobs equal
// to the WHEP client's own defaults (which are the historical literals).

describe('profile resolution', () => {
  it('exactly two profiles, drive is the default', () => {
    expect(VIDEO_PROFILE_IDS).toEqual(['drive', 'showpiece']);
    expect(DEFAULT_VIDEO_PROFILE).toBe('drive');
    expect(Object.keys(VIDEO_PROFILES).sort()).toEqual([...VIDEO_PROFILE_IDS].sort());
  });

  it('videoProfileFor resolves known ids and repairs anything else to DRIVE', () => {
    expect(videoProfileFor('drive')).toBe(VIDEO_PROFILES.drive);
    expect(videoProfileFor('showpiece')).toBe(VIDEO_PROFILES.showpiece);
    for (const junk of [undefined, null, '', 'imax', 'DRIVE', 42, {}, [], 'showpiece ']) {
      expect(videoProfileFor(junk)).toBe(VIDEO_PROFILES.drive);
    }
  });

  it('normalizeVideoSettings never throws and repairs to the DRIVE subtree', () => {
    for (const junk of [undefined, null, 42, 'x', [], ['showpiece'], {}, { profile: 'imax' }, { profile: 7 }]) {
      expect(normalizeVideoSettings(junk)).toEqual({ profile: 'drive' });
    }
    expect(normalizeVideoSettings({ profile: 'showpiece' })).toEqual({ profile: 'showpiece' });
    expect(normalizeVideoSettings({ profile: 'drive' })).toEqual({ profile: 'drive' });
  });

  it('profile definitions are deep-frozen — no runtime retuning', () => {
    expect(() => { VIDEO_PROFILES.drive.player.retryMs = 9; }).toThrow();
    expect(() => { VIDEO_PROFILES.showpiece.mediamtxEnv.MTX_WRITEQUEUESIZE = '4'; }).toThrow();
    expect(() => { VIDEO_PROFILES.extra = {}; }).toThrow();
  });

  it('every profile carries the full knob shape + giftee wording', () => {
    for (const id of VIDEO_PROFILE_IDS) {
      const p = VIDEO_PROFILES[id];
      expect(p.id).toBe(id);
      expect(typeof p.label).toBe('string');
      expect(typeof p.tagline).toBe('string');
      expect(typeof p.blurb).toBe('string');
      expect(p.mediamtxEnv).toBeTypeOf('object');
      expect(Object.keys(p.player).sort()).toEqual(['jitterBufferTargetMs', 'playoutDelayHintS', 'retryMs']);
    }
    expect(VIDEO_PROFILE_RESTART_NOTE).toMatch(/restart/i);
  });
});

describe('DRIVE equals today (the pre-profile tuning, byte for byte)', () => {
  it('DRIVE has NO mediamtx overrides — the checked-in yml stays the whole config', () => {
    expect(VIDEO_PROFILES.drive.mediamtxEnv).toStrictEqual({});
  });

  it("DRIVE's player knobs ARE the WHEP client defaults, and both are the historical literals", () => {
    // The literals the pre-profile client shipped with: playoutDelayHint = 0
    // set on the receiver, jitterBufferTarget never touched, retry 1500 ms.
    expect(WHEP_PLAYER_DEFAULTS).toStrictEqual({ playoutDelayHintS: 0, jitterBufferTargetMs: null, retryMs: 1500 });
    expect(VIDEO_PROFILES.drive.player).toStrictEqual({ ...WHEP_PLAYER_DEFAULTS });
  });

  it('a DRIVE-keyed supervisor spawns with EXACTLY the historical options (no env key at all)', () => {
    const spawnFn = vi.fn(() => ({
      stdout: { on() {} }, stderr: { on() {} }, on() {}, kill() {},
    }));
    // process.execPath exists on every host, so start() reaches the spawn.
    const sup = new MediamtxSupervisor({
      binaryPath: process.execPath,
      configPath: '/tmp/mediamtx.yml',
      extraEnv: VIDEO_PROFILES.drive.mediamtxEnv,
      spawnFn,
    });
    sup.start();
    sup.stop();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = spawnFn.mock.calls[0];
    expect(bin).toBe(process.execPath);
    expect(args).toEqual(['/tmp/mediamtx.yml']);
    // Byte-for-byte the pre-profile literal: the options object has ONE key.
    expect(opts).toStrictEqual({ stdio: ['ignore', 'pipe', 'pipe'] });
    expect('env' in opts).toBe(false);
  });

  it('a supervisor constructed the pre-profile way (no extraEnv at all) spawns identically', () => {
    const spawnFn = vi.fn(() => ({
      stdout: { on() {} }, stderr: { on() {} }, on() {}, kill() {},
    }));
    const sup = new MediamtxSupervisor({
      binaryPath: process.execPath, configPath: '/tmp/mediamtx.yml', spawnFn,
    });
    sup.start();
    sup.stop();
    expect(spawnFn.mock.calls[0][2]).toStrictEqual({ stdio: ['ignore', 'pipe', 'pipe'] });
  });
});

describe('SHOWPIECE mediamtx overrides ride the spawn env', () => {
  it('overrides are layered over the base env; base keys survive; MTX_ keys land', () => {
    const spawnFn = vi.fn(() => ({
      stdout: { on() {} }, stderr: { on() {} }, on() {}, kill() {},
    }));
    const sup = new MediamtxSupervisor({
      binaryPath: process.execPath,
      configPath: '/tmp/mediamtx.yml',
      extraEnv: VIDEO_PROFILES.showpiece.mediamtxEnv,
      baseEnv: { PATH: '/usr/bin', W17_MARKER: 'base' },
      spawnFn,
    });
    sup.start();
    sup.stop();
    const opts = spawnFn.mock.calls[0][2];
    expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(opts.env).toStrictEqual({
      PATH: '/usr/bin',
      W17_MARKER: 'base',
      MTX_PATHS_CAM_RTSPTRANSPORT: 'tcp',
      MTX_WRITEQUEUESIZE: '1024',
    });
  });

  it('the override set is exactly the two documented knobs, with mediamtx-valid values', () => {
    const env = VIDEO_PROFILES.showpiece.mediamtxEnv;
    expect(Object.keys(env).sort()).toEqual(['MTX_PATHS_CAM_RTSPTRANSPORT', 'MTX_WRITEQUEUESIZE']);
    expect(env.MTX_PATHS_CAM_RTSPTRANSPORT).toBe('tcp');
    // mediamtx (pinned v1.9.3) requires writeQueueSize to be a power of two.
    const q = Number(env.MTX_WRITEQUEUESIZE);
    expect(Number.isInteger(q) && q > 0 && (q & (q - 1)) === 0).toBe(true);
    expect(q).toBeGreaterThan(512); // quality-lean means MORE than the default
  });

  it('the two playout-delay spellings state the SAME target (0.3 s == 300 ms)', () => {
    const p = VIDEO_PROFILES.showpiece.player;
    expect(p.jitterBufferTargetMs).toBe(p.playoutDelayHintS * 1000);
    // And the reconnect pacing is deliberately identical to DRIVE (documented
    // in the module: pacing is outage recovery, not picture quality).
    expect(p.retryMs).toBe(VIDEO_PROFILES.drive.player.retryMs);
  });
});

// --- WHEP player tuning at the receiver seam -------------------------------
// The same fake-PC harness as test/whep.test.js, plus a receiver object so the
// ontrack path can be driven. Both properties EXIST on the fake receiver (the
// `in` guards pass), so "untouched" is a real observation, not a missing API.

let instances;
class FakePC {
  constructor() {
    this.connectionState = 'new';
    this.ontrack = null;
    this.onconnectionstatechange = null;
    instances.push(this);
  }
  addTransceiver() {}
  async createOffer() { return { sdp: 'v=0 offer' }; }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  close() { this.connectionState = 'closed'; }
  emit(state) { this.connectionState = state; if (this.onconnectionstatechange) this.onconnectionstatechange(); }
}

const videoEl = { play: () => Promise.resolve(), srcObject: null };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const URL = 'http://127.0.0.1:8889/cam/whep';
const freshReceiver = () => ({ playoutDelayHint: undefined, jitterBufferTarget: 123 });

beforeEach(() => {
  instances = [];
  vi.useFakeTimers();
  global.RTCPeerConnection = FakePC;
  global.fetch = vi.fn(async () => ({ ok: true, text: async () => 'v=0 answer' }));
});
afterEach(() => {
  vi.useRealTimers();
  delete global.RTCPeerConnection;
  delete global.fetch;
});

describe('WHEP player knobs per profile (vision decision 7)', () => {
  it('DRIVE (and an untuned call) sets playoutDelayHint 0 and NEVER touches jitterBufferTarget', async () => {
    for (const opts of [{}, { player: VIDEO_PROFILES.drive.player }]) {
      instances = [];
      const receiver = freshReceiver();
      startWhep(videoEl, URL, opts);
      await flush();
      instances[0].ontrack({ receiver, streams: [{}] });
      expect(receiver.playoutDelayHint).toBe(0);
      expect(receiver.jitterBufferTarget).toBe(123); // pre-existing value untouched
    }
  });

  it('SHOWPIECE sets BOTH spellings of the 300 ms playout buffer', async () => {
    const receiver = freshReceiver();
    startWhep(videoEl, URL, { player: VIDEO_PROFILES.showpiece.player });
    await flush();
    instances[0].ontrack({ receiver, streams: [{}] });
    expect(receiver.playoutDelayHint).toBe(0.3);
    expect(receiver.jitterBufferTarget).toBe(300);
  });

  it('retry pacing comes from the profile (both profiles: the proven 1500 ms)', async () => {
    const onStatus = vi.fn();
    startWhep(videoEl, URL, { player: VIDEO_PROFILES.showpiece.player, onStatus });
    await flush();
    instances[0].emit('disconnected');
    // Just before the profile's retryMs: no second attempt yet.
    await vi.advanceTimersByTimeAsync(VIDEO_PROFILES.showpiece.player.retryMs - 1);
    expect(instances.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(instances.length).toBe(2);
  });

  it('a partial player override keeps the DRIVE defaults for unnamed knobs', async () => {
    const receiver = freshReceiver();
    startWhep(videoEl, URL, { player: { jitterBufferTargetMs: 250 } });
    await flush();
    instances[0].ontrack({ receiver, streams: [{}] });
    expect(receiver.playoutDelayHint).toBe(0); // default rode through
    expect(receiver.jitterBufferTarget).toBe(250);
  });
});
