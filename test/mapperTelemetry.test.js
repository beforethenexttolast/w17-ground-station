// The mapper telemetry mapping (owner decision OD-4) and the read-only stream
// consumers built on it. Pure mapping first — the units are the whole risk —
// then the two subscriber clients against fake calls: no grpc, no mapper, no
// socket anywhere in this file.
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  mapperFrameToTelemetry, linkIsUp, signedByte, MAPPER_GROUND_SPEED_TO_KMH,
} = require('../shared/mapperTelemetry.js');
const { frameToTelemetry } = require('../shared/crsfTelemetry.js');
const { MapperTelemetrySource } = require('../main/MapperTelemetrySource.js');
const { MapperLinkStateClient } = require('../main/MapperLinkStateClient.js');

describe('mapperFrameToTelemetry — the car-side truths, off the mapper stream', () => {
  it('battery: volts and percent pass through (both sides already divide by 10)', () => {
    expect(mapperFrameToTelemetry({ battery: { voltage: 7.4, current: 3.1, fuel: 0, remaining: 62 } }))
      .toEqual({ batteryV: 7.4, batteryPct: 62 });
  });

  it('flight mode: the SAME parser the serial path uses reads gear / mode / ERS', () => {
    expect(mapperFrameToTelemetry({ flight_mode: { mode: 'G3 M2 E55' } }))
      .toEqual({ gear: 3, driveMode: 2, ersPct: 55 });
    // A string with nothing in it maps to nothing, not to zeros.
    expect(mapperFrameToTelemetry({ flight_mode: { mode: 'BOOT' } })).toBeNull();
  });

  it('link stats: LQ as-is, RSSI negated, SNR read back as SIGNED (the mapper reads it unsigned)', () => {
    expect(mapperFrameToTelemetry({
      link_stats: { uplink_link_quality: 96, uplink_rssi1: 75, uplink_snr: 250 },
    })).toEqual({ linkQualityPct: 96, rssiDbm: -75, snrDb: -6 });
    // A positive SNR is untouched.
    expect(mapperFrameToTelemetry({ link_stats: { uplink_snr: 8 } })).toEqual({ snrDb: 8 });
  });

  it('signedByte only reinterprets a BYTE — an already-signed value passes through', () => {
    expect(signedByte(0)).toBe(0);
    expect(signedByte(127)).toBe(127);
    expect(signedByte(128)).toBe(-128);
    expect(signedByte(255)).toBe(-1);
    expect(signedByte(-6)).toBe(-6);   // a future mapper that reports signed
    expect(signedByte(300)).toBe(300); // out of byte range: not ours to mangle
    expect(signedByte(undefined)).toBeNull();
  });

  // THE units risk. The mapper divides the raw CRSF groundspeed by 100 and
  // documents the result as m/s (an upstream Betaflight assumption); the W17 car
  // encodes the standard CRSF 0.1 km/h unit. If this conversion were the
  // "obvious" m/s -> km/h x3.6, every speed on the HUD would be wrong by 2.8x.
  it('speed: the mapper field is km/h / 10, so the conversion is x10 — NOT x3.6', () => {
    expect(MAPPER_GROUND_SPEED_TO_KMH).toBe(10);
    expect(mapperFrameToTelemetry({ gps: { ground_speed: 1.8 } })).toEqual({ speedKmh: 18 });
  });

  it('speed agrees with the SERIAL path on the same wire bytes (the two sources cannot drift)', () => {
    // One CRSF GPS payload carrying 18.0 km/h as the firmware encodes it
    // (groundspeedKmhX10 = 180), fed to the existing serial mapper…
    const raw = 180;
    const payload = Buffer.alloc(15);
    payload[8] = (raw >> 8) & 0xff;
    payload[9] = raw & 0xff;
    const viaSerial = frameToTelemetry({ type: 0x02, payload });
    // …and the same value as the mapper publishes it (raw / 100).
    const viaMapper = mapperFrameToTelemetry({ gps: { ground_speed: raw / 100 } });
    expect(viaSerial.speedKmh).toBeCloseTo(18, 6);
    expect(viaMapper.speedKmh).toBeCloseTo(viaSerial.speedKmh, 6);
  });

  it('an unmapped payload, a missing number, or a non-object is null (the HUD keeps simulating)', () => {
    expect(mapperFrameToTelemetry({ attitude: { pitch: 1 } })).toBeNull();
    expect(mapperFrameToTelemetry({ gps: { latitude: 1 } })).toBeNull();
    expect(mapperFrameToTelemetry({ battery: {} })).toBeNull();
    expect(mapperFrameToTelemetry({ flight_mode: { mode: 42 } })).toBeNull();
    expect(mapperFrameToTelemetry(null)).toBeNull();
    expect(mapperFrameToTelemetry('nope')).toBeNull();
  });

  it('a NaN or infinite number is dropped, never rendered', () => {
    expect(mapperFrameToTelemetry({ battery: { voltage: NaN, remaining: Infinity } })).toBeNull();
    expect(mapperFrameToTelemetry({ gps: { ground_speed: NaN } })).toBeNull();
  });
});

describe('linkIsUp — both halves, by NAME (review SYN-2)', () => {
  it('is up only when the supervisor is active AND the port is connected', () => {
    expect(linkIsUp({ supervisor_state: 'SupervisorActive', port_state: 'PortConnected' })).toBe(true);
    expect(linkIsUp({ supervisor_state: 'SupervisorActive', port_state: 'PortDisconnected' })).toBe(false);
    expect(linkIsUp({ supervisor_state: 'SupervisorInactive', port_state: 'PortConnected' })).toBe(false);
    expect(linkIsUp({ supervisor_state: 'SupervisorUnknown', port_state: 'PortUnknown' })).toBe(false);
  });

  it('an unknown or renamed enum reads as NOT up — never as a coincidental match', () => {
    expect(linkIsUp({ supervisor_state: 2, port_state: 2 })).toBe(false);
    expect(linkIsUp({})).toBe(false);
    expect(linkIsUp(null)).toBe(false);
  });
});

// A fake server-streaming call: .on(event, cb) + .cancel(), which is the entire
// surface both consumers use.
function fakeCall() {
  const call = new EventEmitter();
  call.cancel = vi.fn(() => call.emit('error', { code: 1 })); // CANCELLED
  return call;
}

function streamHarness(Ctor, extra = {}) {
  const calls = [];
  const timers = [];
  let nextId = 1;
  const client = new Ctor({
    connect: () => { const c = fakeCall(); calls.push(c); return c; },
    schedule: (fn, ms) => { const id = nextId++; timers.push({ id, fn, ms }); return id; },
    cancelTimer: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    ...extra,
  });
  const fire = () => { const due = timers.splice(0, timers.length); for (const t of due) t.fn(); };
  return { client, calls, timers, fire, last: () => calls[calls.length - 1] };
}

describe('MapperTelemetrySource — a read-only stream feeding the existing HUD path (OD-4)', () => {
  it('MERGES partial messages instead of replacing them (battery must not blank speed)', () => {
    const { client, last } = streamHarness(MapperTelemetrySource);
    const seen = [];
    client.onTelemetry((t) => seen.push({ ...t }));
    client.start();
    last().emit('data', { battery: { voltage: 7.4, remaining: 60 } });
    last().emit('data', { gps: { ground_speed: 2.5 } });
    last().emit('data', { flight_mode: { mode: 'G2 M1 E30' } });
    expect(seen).toHaveLength(3);
    expect(seen[2]).toEqual({
      batteryV: 7.4, batteryPct: 60, speedKmh: 25, gear: 2, driveMode: 1, ersPct: 30,
    });
  });

  it('an unmapped payload emits NOTHING (no empty snapshot churn)', () => {
    const { client, last } = streamHarness(MapperTelemetrySource);
    const seen = [];
    client.onTelemetry((t) => seen.push(t));
    client.start();
    last().emit('data', { attitude: { pitch: 1 } });
    expect(seen).toHaveLength(0);
  });

  it('a malformed message is skipped, and the stream keeps running', () => {
    const logs = [];
    const { client, last } = streamHarness(MapperTelemetrySource, { log: (m) => logs.push(m) });
    const seen = [];
    client.onTelemetry((t) => seen.push(t));
    client.start();
    // A getter that throws is the shape a hostile/garbled decode takes.
    last().emit('data', { get battery() { throw new Error('garbled'); } });
    last().emit('data', { battery: { voltage: 7.1 } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ batteryV: 7.1 });
    expect(logs.join(' ')).toMatch(/unreadable/);
  });

  it('reconnects on a dropped stream with bounded backoff, and resets it after data', () => {
    const { client, calls, timers, fire, last } = streamHarness(MapperTelemetrySource);
    client.start();
    expect(calls).toHaveLength(1);
    last().emit('error', { code: 14 }); // UNAVAILABLE — the mapper is not up yet
    expect(timers[0].ms).toBe(500);
    fire();
    expect(calls).toHaveLength(2);
    last().emit('error', { code: 14 });
    expect(timers[0].ms).toBe(1000); // doubling
    fire();
    last().emit('data', { battery: { voltage: 7.4 } }); // healthy: backoff resets
    last().emit('end');
    expect(timers[0].ms).toBe(500);
  });

  it('stop() cancels the call, stops reconnecting, and drops the merged snapshot', () => {
    const { client, calls, timers, last } = streamHarness(MapperTelemetrySource);
    client.start();
    const call = last();
    last().emit('data', { battery: { voltage: 7.4 } });
    client.stop();
    expect(call.cancel).toHaveBeenCalledTimes(1);
    expect(timers).toHaveLength(0); // the CANCELLED error scheduled nothing
    expect(calls).toHaveLength(1);
    // A fresh session must not inherit the last one's readings.
    const seen = [];
    client.onTelemetry((t) => seen.push({ ...t }));
    client.start();
    last().emit('data', { gps: { ground_speed: 1 } });
    expect(seen[0]).toEqual({ speedKmh: 10 });
  });

  it('a connect() that throws is just another dropped attempt, never an unhandled error', () => {
    const client = new MapperTelemetrySource({
      connect: () => { throw new Error('no channel'); },
      schedule: () => 1,
      cancelTimer: () => {},
    });
    expect(() => client.start()).not.toThrow();
  });

  it('refuses to be built without a transport (an unconfigured source must not look live)', () => {
    expect(() => new MapperTelemetrySource({})).toThrow(/connect/);
  });
});

describe('MapperLinkStateClient — is the drive program actually transmitting? (SYN-2)', () => {
  it('starts UNKNOWN, then reports the mapper answer; only changes emit', () => {
    const { client, last } = streamHarness(MapperLinkStateClient);
    const seen = [];
    client.onChange((s) => seen.push(s.up));
    expect(client.snapshot().up).toBeNull();
    client.start();
    last().emit('data', { supervisor_state: 'SupervisorActive', port_state: 'PortDisconnected' });
    expect(client.snapshot()).toEqual({
      up: false, supervisorState: 'SupervisorActive', portState: 'PortDisconnected',
    });
    // The mapper repeats itself every 500 ms; a repeat is not a change.
    last().emit('data', { supervisor_state: 'SupervisorActive', port_state: 'PortDisconnected' });
    last().emit('data', { supervisor_state: 'SupervisorActive', port_state: 'PortConnected' });
    expect(client.snapshot().up).toBe(true);
    expect(seen).toEqual([false, true]);
  });

  it('a dropped stream goes back to UNKNOWN — a lost answer is not a "still up"', () => {
    const { client, last } = streamHarness(MapperLinkStateClient);
    client.start();
    last().emit('data', { supervisor_state: 'SupervisorActive', port_state: 'PortConnected' });
    expect(client.snapshot().up).toBe(true);
    last().emit('error', { code: 14 });
    expect(client.snapshot()).toEqual({ up: null, supervisorState: null, portState: null });
  });

  it('stop() cancels, clears the answer, and schedules no reconnect', () => {
    const { client, timers, last } = streamHarness(MapperLinkStateClient);
    client.start();
    const call = last();
    last().emit('data', { supervisor_state: 'SupervisorActive', port_state: 'PortConnected' });
    client.stop();
    expect(call.cancel).toHaveBeenCalledTimes(1);
    expect(client.snapshot().up).toBeNull();
    expect(timers).toHaveLength(0);
  });

  it('a throwing listener cannot break the others', () => {
    const { client, last } = streamHarness(MapperLinkStateClient);
    const seen = [];
    client.onChange(() => { throw new Error('boom'); });
    client.onChange((s) => seen.push(s.up));
    client.start();
    last().emit('data', { supervisor_state: 'SupervisorActive', port_state: 'PortConnected' });
    expect(seen).toEqual([true]);
  });

  it('refuses to be built without a transport', () => {
    expect(() => new MapperLinkStateClient({})).toThrow(/connect/);
  });
});
