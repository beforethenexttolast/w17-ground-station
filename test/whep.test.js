import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startWhep } from '../renderer/whep.js';

// The WHEP client's transport signals feed the video-state model (audit C1):
// 'connecting' at each (re)connect attempt, 'dropped' when an ESTABLISHED peer
// connection fails/disconnects (the <video> may freeze silently), 'stopped' on
// teardown. A stale callback from a superseded reconnect attempt must never
// report a drop for the live one — the pc-identity guard in whep.js. Real
// RTCPeerConnection + fetch are mocked so the transport logic runs headless.

let instances;
class FakePC {
  constructor() {
    this.connectionState = 'new';
    this.ontrack = null;
    this.onconnectionstatechange = null;
    this.closed = false;
    instances.push(this);
  }
  addTransceiver() {}
  async createOffer() { return { sdp: 'v=0 offer' }; }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  // Real close() sets state to 'closed' but does NOT dispatch a statechange
  // event — matching that keeps whep's cleanup non-recursive.
  close() { this.closed = true; this.connectionState = 'closed'; }
  // Drive a connection-state transition as the browser would (async event).
  emit(state) { this.connectionState = state; if (this.onconnectionstatechange) this.onconnectionstatechange(); }
}

const videoEl = { play: () => Promise.resolve(), srcObject: null };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const URL = 'http://127.0.0.1:8889/cam/whep';

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

describe('WHEP transport signals (audit C1)', () => {
  it("reports 'connecting' at the first attempt", async () => {
    const onStatus = vi.fn();
    startWhep(videoEl, URL, { onStatus });
    // Emitted synchronously at the top of connect(), before any await.
    expect(onStatus).toHaveBeenCalledWith('connecting');
    await flush();
    expect(instances.length).toBe(1);
  });

  it("an established connection dropping reports 'dropped' then reconnects ('connecting')", async () => {
    const onStatus = vi.fn();
    startWhep(videoEl, URL, { onStatus });
    await flush();
    const pc0 = instances[0];
    pc0.emit('connected'); // benign: whep only reacts to failed/disconnected/closed
    expect(onStatus).not.toHaveBeenCalledWith('dropped');
    pc0.emit('disconnected');
    expect(onStatus).toHaveBeenCalledWith('dropped');
    // The 1.5 s retry spins up a fresh attempt.
    await vi.advanceTimersByTimeAsync(1500);
    await flush();
    expect(instances.length).toBe(2);
    expect(onStatus.mock.calls.filter((c) => c[0] === 'connecting').length).toBe(2);
  });

  it('a stale drop from a SUPERSEDED peer connection is ignored (race guard)', async () => {
    const onStatus = vi.fn();
    startWhep(videoEl, URL, { onStatus });
    await flush();
    const pc0 = instances[0];
    pc0.emit('disconnected');          // established attempt drops
    await vi.advanceTimersByTimeAsync(1500);
    await flush();
    expect(instances.length).toBe(2);  // reconnected to pc1
    const pc1 = instances[1];
    onStatus.mockClear();
    // The OLD pc fires a late 'failed' AFTER the swap — must NOT report a drop.
    pc0.emit('failed');
    expect(onStatus).not.toHaveBeenCalledWith('dropped');
    // …while the LIVE pc dropping is still honored.
    pc1.emit('disconnected');
    expect(onStatus).toHaveBeenCalledWith('dropped');
  });

  it("stop() reports 'stopped' and silences later drops", async () => {
    const onStatus = vi.fn();
    const handle = startWhep(videoEl, URL, { onStatus });
    await flush();
    handle.stop();
    expect(onStatus).toHaveBeenCalledWith('stopped');
    onStatus.mockClear();
    instances[0].emit('disconnected'); // after stop: ignored
    expect(onStatus).not.toHaveBeenCalled();
  });

  it("a failed connect (HTTP error) retries as 'connecting' without a false 'dropped'", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 503 }));
    const onStatus = vi.fn();
    startWhep(videoEl, URL, { onStatus });
    await flush();
    expect(onStatus).toHaveBeenCalledWith('connecting');
    expect(onStatus).not.toHaveBeenCalledWith('dropped'); // never established, no drop
    await vi.advanceTimersByTimeAsync(1500);
    await flush();
    expect(onStatus.mock.calls.filter((c) => c[0] === 'connecting').length).toBe(2);
  });
});
