// iPhone HUD discovery policy (CB4): what a decoded mDNS response is allowed
// to become. Everything here is a CANDIDATE the operator confirms by hand —
// these tests pin which advertisements we will offer, which we decline and
// why, and that network-authored text is bounded before it reaches a log line
// or the setup UI. The canonical rules are docs/windows_bridge_contract.md
// "Discovery" (mirrored at rev 9d0d8d7).
import { describe, it, expect } from 'vitest';
import { encodeName, TYPE } from '../shared/dnsWire.js';
import { advert, goodbye, message, rr, srvRdata, txtRdata, aRdata } from './fixtures/mdnsAdvert.mjs';
import {
  SERVICE_TYPE, MAX_DEV_CHARS, MAX_CANDIDATES,
  isUsableUnicastIpv4, sanitizeDev, parseFeatures, hudsFromDatagram,
} from '../shared/hudDiscovery.js';

const only = (bytes) => {
  const res = hudsFromDatagram(bytes);
  expect(res.ok, res.reason).toBe(true);
  return res;
};
const reasonFor = (bytes) => only(bytes).rejected.map((r) => r.reason);

describe('hudsFromDatagram — the advertisement we accept', () => {
  it('turns a contract-shaped advertisement into one confirmable candidate', () => {
    const { huds, rejected } = only(advert());
    expect(rejected).toEqual([]);
    expect(huds).toHaveLength(1);
    expect(huds[0]).toMatchObject({
      addr: '192.168.4.7',
      port: 5601,
      dev: 'Test iPhone',
      feat: ['w2', 'w3'],
      v: '1',
    });
  });

  it('accepts a HUD that advertises W2 only', () => {
    const { huds } = only(advert({ txt: ['v=1', 'role=hud', 'tport=5601', 'feat=w2'] }));
    expect(huds[0].feat).toEqual(['w2']);
    expect(huds[0].dev).toBe('');   // dev is optional
  });

  it('accepts a non-default telemetry port when SRV and tport agree', () => {
    const { huds } = only(advert({ port: 5699, txt: ['v=1', 'tport=5699'] }));
    expect(huds[0].port).toBe(5699);
  });

  it('finds an instance from SRV/TXT alone when the response carries no PTR', () => {
    // A targeted answer, or a responder trimming what it already announced.
    const { huds } = only(advert({ ptr: false }));
    expect(huds.map((h) => h.addr)).toEqual(['192.168.4.7']);
  });

  it('accepts the Simulator on loopback — a supported W2 destination', () => {
    const { huds } = only(advert({ addr: '127.0.0.1' }));
    expect(huds[0].addr).toBe('127.0.0.1');
  });
});

describe('hudsFromDatagram — what we decline, and why', () => {
  it('declines an advertisement with no version (v is the one required key)', () => {
    expect(reasonFor(advert({ txt: ['role=hud', 'tport=5601'] }))).toEqual(['missing-version']);
  });

  it('declines a version we do not speak rather than guessing at its semantics', () => {
    expect(reasonFor(advert({ txt: ['v=2', 'role=hud'] }))).toEqual(['unsupported-version']);
  });

  it('declines a non-HUD role, tolerates an absent one', () => {
    expect(reasonFor(advert({ txt: ['v=1', 'role=printer'] }))).toEqual(['not-a-hud']);
    expect(only(advert({ txt: ['v=1'] })).huds).toHaveLength(1);
  });

  it('declines when tport contradicts the SRV port — we cannot tell which is real', () => {
    expect(reasonFor(advert({ port: 5601, txt: ['v=1', 'tport=9999'] }))).toEqual(['port-mismatch']);
  });

  it('declines an instance with no SRV (no port, no host to resolve)', () => {
    expect(reasonFor(advert({ srv: false, ptr: true }))).toEqual(['no-srv']);
  });

  it('declines an instance whose host has no A record', () => {
    expect(reasonFor(advert({ a: false }))).toEqual(['no-address']);
  });

  it('declines addresses a HUD cannot be reachable at', () => {
    for (const addr of ['0.0.0.0', '224.0.0.251', '239.1.2.3', '255.255.255.255']) {
      expect(reasonFor(advert({ addr })), addr).toEqual(['bad-address']);
    }
  });

  it('declines port 0', () => {
    expect(reasonFor(advert({ port: 0, txt: ['v=1', 'tport=0'] }))).toEqual(['bad-port']);
  });

  it('ignores a different service entirely — no candidate, no rejection noise', () => {
    const res = only(advert({ service: '_airplay._tcp.local' }));
    expect(res.huds).toEqual([]);
    expect(res.rejected).toEqual([]);
  });

  it('ignores our own outbound QUERY coming back on a shared socket', () => {
    const q = message([], { isResponse: false });
    expect(hudsFromDatagram(q)).toEqual({ ok: false, reason: 'not-a-response' });
  });

  it('passes a wire-level failure straight through as a reason', () => {
    expect(hudsFromDatagram(Buffer.alloc(4))).toEqual({ ok: false, reason: 'truncated-header' });
    expect(hudsFromDatagram('nope')).toEqual({ ok: false, reason: 'not-bytes' });
  });
});

describe('hudsFromDatagram — record TTL (RFC 6762 withdrawal)', () => {
  it('carries the advertisement TTL through so the transport can act on it', () => {
    expect(only(advert()).huds[0].ttl).toBe(120);
  });

  it('reports TTL 0 for a goodbye — the phone saying it has stopped listening', () => {
    expect(only(goodbye()).huds[0].ttl).toBe(0);
  });

  it('takes the LOWEST TTL across the instance: one withdrawn record retires it', () => {
    // A responder that withdraws only its SRV must not look alive because its
    // PTR still carries a long TTL.
    const full = `W17 HUD (Test).${SERVICE_TYPE}`;
    const { huds } = only(message([
      rr(SERVICE_TYPE, TYPE.PTR, encodeName(full), 120),
      rr(full, TYPE.SRV, srvRdata(5601, 'iphone.local'), 0),
      rr(full, TYPE.TXT, txtRdata(['v=1', 'role=hud', 'tport=5601']), 120),
      rr('iphone.local', TYPE.A, aRdata('192.168.4.7'), 120),
    ]));
    expect(huds[0].ttl).toBe(0);
  });

  it('does not emit a truncated instance name (it was lowercased and cut mid-name)', () => {
    expect(only(advert()).huds[0]).not.toHaveProperty('instance');
  });
});

describe('hudsFromDatagram — bounded against a hostile responder', () => {
  it('offers each address once, however many instances claim it', () => {
    const a = advert({ instance: 'W17 HUD (One)' });
    const b = advert({ instance: 'W17 HUD (Two)' });
    const merged = Buffer.concat([a, b.subarray(12)]);
    merged.writeUInt16BE(8, 6);
    const { huds } = only(merged);
    expect(huds.map((h) => h.addr)).toEqual(['192.168.4.7']);
  });

  it('never offers more than MAX_CANDIDATES however many are advertised', () => {
    const records = [];
    for (let i = 0; i < MAX_CANDIDATES + 6; i += 1) {
      const instance = `W17 HUD (${i}).${SERVICE_TYPE}`;
      const host = `phone${i}.local`;
      records.push(rr(SERVICE_TYPE, TYPE.PTR, encodeName(instance)));
      records.push(rr(instance, TYPE.SRV, srvRdata(5601, host)));
      records.push(rr(instance, TYPE.TXT, txtRdata(['v=1', 'role=hud', 'tport=5601'])));
      records.push(rr(host, TYPE.A, aRdata(`192.168.4.${10 + i}`)));
    }
    const { huds } = only(message(records));
    expect(huds).toHaveLength(MAX_CANDIDATES);
  });

  it('strips control characters out of the device label — network text stays inert', () => {
    const { huds } = only(advert({ txt: ['v=1', 'dev=Bad\x07\x1b[31mLabel\n'] }));
    expect(huds[0].dev).toBe('Bad[31mLabel');
    expect([...huds[0].dev].every((c) => c.codePointAt(0) >= 0x20 && c.codePointAt(0) <= 0x7e)).toBe(true);
  });

  it('caps the device label length', () => {
    const { huds } = only(advert({ txt: ['v=1', `dev=${'X'.repeat(200)}`] }));
    expect(huds[0].dev.length).toBe(MAX_DEV_CHARS);
  });
});

describe('policy helpers', () => {
  it('isUsableUnicastIpv4 accepts routable + loopback, rejects the rest', () => {
    for (const ok of ['192.168.4.7', '10.0.0.2', '172.16.9.9', '127.0.0.1', '169.254.3.4']) {
      expect(isUsableUnicastIpv4(ok), ok).toBe(true);
    }
    for (const bad of ['0.0.0.0', '0.1.2.3', '224.0.0.251', '255.255.255.255', '256.1.1.1', '1.2.3', '', null, 42]) {
      expect(isUsableUnicastIpv4(bad), String(bad)).toBe(false);
    }
  });

  it('sanitizeDev keeps printable ASCII, trims, and bounds', () => {
    expect(sanitizeDev('  Vitaliy iPhone  ')).toBe('Vitaliy iPhone');
    expect(sanitizeDev('café 你好')).toBe('caf');   // non-ASCII dropped per contract
    expect(sanitizeDev(undefined)).toBe('');
    expect(sanitizeDev('Y'.repeat(99)).length).toBe(MAX_DEV_CHARS);
  });

  it('parseFeatures keeps known tokens in a stable order and drops the rest', () => {
    expect(parseFeatures('w2,w3')).toEqual(['w2', 'w3']);
    expect(parseFeatures('w3, w2')).toEqual(['w2', 'w3']);   // order-normalized
    expect(parseFeatures('W2')).toEqual(['w2']);             // case-insensitive
    expect(parseFeatures('w2,rocket,w9')).toEqual(['w2']);   // unknown dropped, not fatal
    expect(parseFeatures('')).toEqual([]);
    expect(parseFeatures(undefined)).toEqual([]);
  });
});
