import { describe, it, expect } from 'vitest';
import {
  initialVideoState,
  reduceVideoState,
  videoStatus,
  videoLock,
  VIDEO_PHASES,
} from '../shared/videoState.mjs';

// Pure video-state model (audit C1). The old boolean went green on 'playing'
// and cleared ONLY on 'emptied', so a dying stream (waiting/stalled, or a
// silent WebRTC drop) left VIDEO LOCK + W2 video_lock stale-green. These tests
// pin: 'playing' is the ONLY green; waiting/stalled/dropped/error all drop it;
// events are idempotent; and reconnect returns to green.

const run = (events, s = initialVideoState()) => events.reduce(reduceVideoState, s);

describe('video state model (audit C1)', () => {
  it('starts idle — NO VIDEO, not locked', () => {
    const s = initialVideoState();
    expect(s.phase).toBe('idle');
    expect(videoStatus(s)).toMatchObject({ phase: 'idle', live: false, label: 'NO VIDEO' });
    expect(videoLock(s)).toBe(false);
  });

  it('connecting is not green', () => {
    const s = run(['connecting']);
    expect(s.phase).toBe('connecting');
    expect(videoStatus(s).label).toBe('CONNECTING');
    expect(videoLock(s)).toBe(false);
  });

  it("'playing' is the only confident-green state", () => {
    const s = run(['connecting', 'playing']);
    expect(s.phase).toBe('live');
    expect(videoStatus(s)).toMatchObject({ live: true, label: 'VIDEO LIVE' });
    expect(videoLock(s)).toBe(true);
    // every OTHER phase is not green
    for (const phase of VIDEO_PHASES.filter((p) => p !== 'live')) {
      expect(videoLock({ phase })).toBe(false);
    }
  });

  it("'waiting' after playing drops green to BUFFERING", () => {
    const s = run(['connecting', 'playing', 'waiting']);
    expect(s.phase).toBe('buffering');
    expect(videoStatus(s).label).toBe('BUFFERING');
    expect(videoLock(s)).toBe(false);
    expect(videoStatus(s).reconnecting).toBe(true);
  });

  it("'stalled' after playing drops green to STREAM STALLED", () => {
    const s = run(['playing', 'stalled']);
    expect(s.phase).toBe('stalled');
    expect(videoStatus(s).label).toBe('STREAM STALLED');
    expect(videoLock(s)).toBe(false);
  });

  it("a transport 'dropped' (silent WebRTC drop) drops green even with no media event", () => {
    // The exact audit-L3 scenario: frames were live, the peer connection
    // dropped, and the <video> never fired a media event.
    const s = run(['playing', 'dropped']);
    expect(s.phase).toBe('stalled');
    expect(videoLock(s)).toBe(false);
  });

  it("a media 'error' is a distinct hard state (not reconnecting)", () => {
    const s = run(['playing', 'error']);
    expect(s.phase).toBe('error');
    expect(videoStatus(s)).toMatchObject({ live: false, label: 'VIDEO ERROR', reconnecting: false });
  });

  it("'emptied' returns to idle/NO VIDEO", () => {
    expect(run(['playing', 'emptied']).phase).toBe('idle');
    expect(run(['playing', 'ended']).phase).toBe('idle');
    expect(run(['connecting', 'stopped']).phase).toBe('idle');
  });

  it('reconnect after a drop returns to green', () => {
    const s = run(['playing', 'dropped', 'connecting', 'playing']);
    expect(s.phase).toBe('live');
    expect(videoLock(s)).toBe(true);
  });

  it('repeated events are idempotent (same object reference, no phantom re-render)', () => {
    const live = run(['playing']);
    expect(reduceVideoState(live, 'playing')).toBe(live); // identical reference
    const stalled = run(['playing', 'stalled']);
    expect(reduceVideoState(stalled, 'stalled')).toBe(stalled);
    const idle = initialVideoState();
    expect(reduceVideoState(idle, 'emptied')).toBe(idle);
  });

  it('unknown events are ignored', () => {
    const s = run(['playing']);
    expect(reduceVideoState(s, 'ratechange')).toBe(s);
    expect(reduceVideoState(s, { type: 'timeupdate' })).toBe(s);
  });

  it("real frames ('playing') override a prior stalled/buffering — frames are ground truth", () => {
    expect(run(['playing', 'stalled', 'playing']).phase).toBe('live');
    expect(run(['playing', 'waiting', 'playing']).phase).toBe('live');
  });

  it('a stalled transport is not upgraded toward almost-live by a late media waiting', () => {
    // 'stalled'/'dropped' is the stronger truth; a trailing 'waiting' must not
    // flap the label back to BUFFERING (which implies almost-live).
    const s = run(['playing', 'dropped', 'waiting']);
    expect(s.phase).toBe('stalled');
  });

  it("a spurious 'connecting' never overrides confirmed live frames", () => {
    expect(run(['playing', 'connecting']).phase).toBe('live');
  });

  it('accepts either a string event or a { type } object', () => {
    expect(run([{ type: 'connecting' }, { type: 'playing' }]).phase).toBe('live');
  });

  it('never reports video_lock:true outside the live phase (exhaustive)', () => {
    for (const phase of VIDEO_PHASES) {
      expect(videoLock({ phase })).toBe(phase === 'live');
    }
  });
});
