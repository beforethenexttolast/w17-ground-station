import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createRemoteAddrHint } = require('../main/remoteAddrHint.js');
const { HeadTrackingReceiver } = require('../main/HeadTrackingReceiver.js');

describe('remoteAddrHint — transport metadata only', () => {
  it('null before any note; then addr + age from the injected clock', () => {
    let now = 10_000;
    const hint = createRemoteAddrHint(() => now);
    expect(hint.get()).toBeNull();
    hint.note('192.168.4.2');
    now += 1234;
    expect(hint.get()).toEqual({ addr: '192.168.4.2', ageMs: 1234 });
  });

  it('rejects non-strings, empties, and oversized values', () => {
    const hint = createRemoteAddrHint(() => 0);
    hint.note(42);
    hint.note('');
    hint.note('x'.repeat(46));
    expect(hint.get()).toBeNull();
  });
});

// The receiver-side seam: the sink fires with the SENDER IP of ACCEPTED
// datagrams only — a rejected packet must not update the suggestion.
describe('HeadTrackingReceiver noteRemoteAddr seam', () => {
  function harness() {
    const handlers = {};
    const socket = {
      on: (ev, cb) => { handlers[ev] = cb; },
      bind: vi.fn(),
      close: vi.fn(),
    };
    const noteRemoteAddr = vi.fn();
    const receiver = new HeadTrackingReceiver({
      socketFactory: () => socket,
      schedule: () => 1,
      cancel: () => {},
      clock: () => 5_000,
      noteRemoteAddr,
    });
    receiver.start();
    const deliver = (obj, addr) => handlers.message(
      Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)),
      { address: addr, port: 5602 },
    );
    return { deliver, noteRemoteAddr };
  }

  const valid = {
    seq: 1, timestamp_ms: 4_900, yaw_deg: 1.5, pitch_deg: -2, roll_deg: 0,
    tracking_enabled: true, centered: true,
  };

  it('accepted packet notes the sender IP string', () => {
    const { deliver, noteRemoteAddr } = harness();
    deliver(valid, '192.168.4.7');
    expect(noteRemoteAddr).toHaveBeenCalledTimes(1);
    expect(noteRemoteAddr).toHaveBeenCalledWith('192.168.4.7');
  });

  it('rejected packet does NOT note the sender', () => {
    const { deliver, noteRemoteAddr } = harness();
    deliver('{ not json', '192.168.4.66');
    deliver({ ...valid, yaw_deg: 'NaN-ish' }, '192.168.4.66');
    expect(noteRemoteAddr).not.toHaveBeenCalled();
  });

  it('default sink is a no-op (constructing without it stays safe)', () => {
    const handlers = {};
    const receiver = new HeadTrackingReceiver({
      socketFactory: () => ({ on: (ev, cb) => { handlers[ev] = cb; }, bind: () => {}, close: () => {} }),
      schedule: () => 1,
      cancel: () => {},
      clock: () => 5_000,
    });
    receiver.start();
    expect(() => handlers.message(Buffer.from(JSON.stringify(valid)), { address: '1.2.3.4' }))
      .not.toThrow();
  });
});
