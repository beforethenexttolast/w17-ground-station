// DNS/mDNS wire codec (CB4). These bytes come from unauthenticated local
// multicast, so the decoder's contract is: bounded work, no throw, and an
// honest { ok: false, reason } for anything malformed. The adversarial block
// is the point of this file — a hostile packet must be a non-event, never a
// crashed main process or an unbounded loop.
import { describe, it, expect } from 'vitest';
import {
  TYPE, MAX_MESSAGE_BYTES, MAX_NAME_BYTES,
  readName, encodeName, buildQuery, decodeMessage,
} from '../shared/dnsWire.js';

const hex = (s) => Buffer.from(s.replace(/[\s|]/g, ''), 'hex');

// A realistic advertisement written out BY HAND in wire bytes — deliberately
// not built with this module's own encoder, so a bug that is symmetric between
// encode and decode cannot hide. It exercises name compression three ways:
// the PTR target compresses its service suffix, SRV/TXT compress their owner
// name into the PTR's rdata, and the A record's owner points INTO the SRV
// rdata. Cache-flush class bits are set on SRV/TXT/A as a real responder does.
//
//   _w17hud._udp.local  PTR   W17 HUD (Test)._w17hud._udp.local
//   <instance>          SRV   0 0 5601 iphone.local
//   <instance>          TXT   v=1 role=hud tport=5601 feat=w2,w3 dev=Test iPhone
//   iphone.local        A     192.168.4.7
const REAL_ADVERT = hex(`
  0000 8400 0000 0004 0000 0000
  07 5f7731376875 64 04 5f756470 05 6c6f63616c 00
  000c 0001 00000078 0011
     0e 5731372048554420285465737429
     c00c
  c02a 0021 8001 00000078 0014
     0000 0000 15e1 06 6970686f6e65 05 6c6f63616c 00
  c02a 0010 8001 00000078 0033
     03 763d31
     08 726f6c653d687564
     0a 74706f72743d35363031
     0a 666561743d77322c7733
     0f 6465763d54657374206950686f6e65
  c04d 0001 8001 00000078 0004 c0a80407
`);

describe('buildQuery', () => {
  it('is a well-formed one-question PTR query for the service', () => {
    const q = buildQuery('_w17hud._udp.local');
    expect(q.readUInt16BE(0)).toBe(0);        // ID ignored by mDNS
    expect(q.readUInt16BE(2)).toBe(0);        // standard query
    expect(q.readUInt16BE(4)).toBe(1);        // one question
    expect(q.readUInt16BE(6)).toBe(0);        // no answers
    const decoded = decodeMessage(q);
    expect(decoded.ok).toBe(true);
    expect(decoded.message.isResponse).toBe(false);
    expect(decoded.message.questions).toEqual([
      { name: '_w17hud._udp.local', type: TYPE.PTR, class: 1 },
    ]);
  });

  it('sets the unicast-response (QU) bit by default, and can be asked not to', () => {
    // The QU bit lives in the top bit of QCLASS: responders answer our
    // ephemeral source port instead of the multicast group.
    const qu = buildQuery('_w17hud._udp.local');
    expect(qu.readUInt16BE(qu.length - 2)).toBe(0x8001);
    const multicast = buildQuery('_w17hud._udp.local', { unicastResponse: false });
    expect(multicast.readUInt16BE(multicast.length - 2)).toBe(0x0001);
  });

  it('encodeName round-trips through readName', () => {
    const buf = encodeName('W17 HUD (Test)._w17hud._udp.local');
    const read = readName(buf, 0);
    expect(read.labels).toEqual(['W17 HUD (Test)', '_w17hud', '_udp', 'local']);
    expect(read.next).toBe(buf.length);
  });
});

describe('decodeMessage — a real advertisement', () => {
  it('decodes all four records, following every compression pointer', () => {
    const res = decodeMessage(REAL_ADVERT);
    expect(res.ok, res.reason).toBe(true);
    const { records, isResponse } = res.message;
    expect(isResponse).toBe(true);
    expect(records).toHaveLength(4);

    const [ptr, srv, txt, a] = records;
    expect(ptr.name).toBe('_w17hud._udp.local');
    expect(ptr.type).toBe(TYPE.PTR);
    expect(ptr.data.target).toBe('W17 HUD (Test)._w17hud._udp.local');

    // Owner name recovered through a pointer into the PTR record's rdata.
    expect(srv.name).toBe('W17 HUD (Test)._w17hud._udp.local');
    expect(srv.type).toBe(TYPE.SRV);
    expect(srv.data).toMatchObject({ priority: 0, weight: 0, port: 5601, target: 'iphone.local' });

    expect(txt.type).toBe(TYPE.TXT);
    expect(txt.data.pairs).toEqual({
      v: '1', role: 'hud', tport: '5601', feat: 'w2,w3', dev: 'Test iPhone',
    });

    expect(a.name).toBe('iphone.local');
    expect(a.data.addr).toBe('192.168.4.7');
  });

  it('masks the cache-flush bit off the class rather than reporting class 32769', () => {
    const { message } = decodeMessage(REAL_ADVERT);
    const srv = message.records[1];
    expect(srv.class).toBe(1);
    expect(srv.cacheFlush).toBe(true);
    expect(message.records[0].cacheFlush).toBe(false); // PTR sent without it
  });
});

describe('decodeMessage — TXT quirks (RFC 6763)', () => {
  const txtMessage = (strings) => {
    const rdata = Buffer.concat(strings.map((s) => {
      const b = Buffer.from(s, 'utf8');
      return Buffer.concat([Buffer.from([b.length]), b]);
    }));
    const head = Buffer.alloc(12);
    head.writeUInt16BE(0x8400, 2);
    head.writeUInt16BE(1, 6);
    const rr = Buffer.concat([
      encodeName('x.local'),
      Buffer.from([0x00, 0x10, 0x00, 0x01, 0, 0, 0, 120]),
      Buffer.from([rdata.length >> 8, rdata.length & 0xff]),
      rdata,
    ]);
    return Buffer.concat([head, rr]);
  };

  it('lowercases keys, keeps values verbatim, and lets the FIRST duplicate win', () => {
    const res = decodeMessage(txtMessage(['V=1', 'DEV=Mixed Case Kept', 'v=9']));
    expect(res.message.records[0].data.pairs).toEqual({ v: '1', dev: 'Mixed Case Kept' });
  });

  it('treats a valueless string as a boolean attribute and drops an empty key', () => {
    const res = decodeMessage(txtMessage(['flag', '=orphan', 'k=']));
    expect(res.message.records[0].data.pairs).toEqual({ flag: '', k: '' });
  });

  it('rejects a TXT string whose length prefix runs past the record', () => {
    const good = txtMessage(['v=1']);
    const bad = Buffer.from(good);
    bad[bad.length - 4] = 0x40;   // claim a 64-byte string inside a 4-byte rdata
    const res = decodeMessage(bad);
    // The record survives with data null (honest counts); no throw, no read
    // past the rdata window.
    expect(res.ok).toBe(true);
    expect(res.message.records[0].data).toBeNull();
  });
});

describe('decodeMessage — hostile input is a non-event', () => {
  it('refuses non-buffers, runts, and oversized packets by reason', () => {
    expect(decodeMessage('not a buffer')).toEqual({ ok: false, reason: 'not-bytes' });
    expect(decodeMessage(Buffer.alloc(11))).toEqual({ ok: false, reason: 'truncated-header' });
    expect(decodeMessage(Buffer.alloc(MAX_MESSAGE_BYTES + 1))).toEqual({ ok: false, reason: 'oversized' });
  });

  it('refuses an absurd record count before doing any per-record work', () => {
    const head = Buffer.alloc(12);
    head.writeUInt16BE(0x8400, 2);
    head.writeUInt16BE(0xffff, 6);   // 65535 answers in a 12-byte packet
    expect(decodeMessage(head)).toEqual({ ok: false, reason: 'too-many-records' });
  });

  it('terminates on a self-referential compression pointer instead of looping', () => {
    // A pointer at offset 12 aiming at offset 12: the classic decompression
    // bomb. Rejected because pointers must aim strictly BACKWARDS.
    const buf = Buffer.concat([Buffer.alloc(12), hex('c00c 000c 0001 00000078 0000')]);
    buf.writeUInt16BE(0x8400, 2);
    buf.writeUInt16BE(1, 6);
    expect(decodeMessage(buf)).toEqual({ ok: false, reason: 'bad-record-name' });
    expect(readName(buf, 12)).toBeNull();
  });

  it('rejects a FORWARD pointer (the two-pointer mutual loop)', () => {
    // 12 -> 14 -> 12 would ping-pong forever if forward jumps were allowed.
    const buf = Buffer.concat([Buffer.alloc(12), hex('c00e c00c')]);
    expect(readName(buf, 12)).toBeNull();
  });

  it('terminates a cycle whose every jump is legally BACKWARDS', () => {
    // The case the backwards rule does NOT catch: a label at 12 walks forward
    // to 17, and the pointer at 17 aims back at 12 — each jump is backwards,
    // yet the walk revisits. Only the jump/length caps stop this, so if this
    // test ever hangs instead of failing, a cap was deleted as "redundant".
    const buf = Buffer.concat([Buffer.alloc(12), hex('04 61616161 c00c')]);
    const started = Date.now();
    expect(readName(buf, 12)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('rejects reserved label types and out-of-bounds labels', () => {
    expect(readName(Buffer.from([0x80, 0x01, 0x00]), 0)).toBeNull();  // 0b10 reserved
    expect(readName(Buffer.from([0x40, 0x01, 0x00]), 0)).toBeNull();  // 0b01 reserved
    expect(readName(Buffer.from([0x05, 0x61]), 0)).toBeNull();        // label runs off the end
    expect(readName(Buffer.from([0x03, 0x61, 0x62, 0x63]), 0)).toBeNull(); // no terminator
    expect(readName(Buffer.alloc(0), 0)).toBeNull();
  });

  it('caps total decompressed name length', () => {
    // A chain of 4 backward pointers, each prepending 60 bytes of label, would
    // decompress past the 255-byte ceiling.
    const label = Buffer.concat([Buffer.from([60]), Buffer.alloc(60, 0x61)]);
    const parts = [Buffer.alloc(12)];
    let prev = 12;
    for (let i = 0; i < 5; i += 1) {
      const at = 12 + i * 63;
      parts.push(Buffer.concat([label, Buffer.from([0xc0, i === 0 ? 0 : prev])]));
      prev = at;
    }
    const buf = Buffer.concat(parts);
    const res = readName(buf, buf.length - 63);
    // Either the ceiling or the backwards rule stops it — never a huge string.
    expect(res === null || res.name.length <= MAX_NAME_BYTES).toBe(true);
  });

  it('rejects rdata that claims more bytes than the packet holds', () => {
    const bad = Buffer.from(REAL_ADVERT);
    bad.writeUInt16BE(0x0fff, 40);   // PTR rdlength
    expect(decodeMessage(bad)).toEqual({ ok: false, reason: 'truncated-rdata' });
  });

  it('rejects a truncated record header and a truncated question', () => {
    expect(decodeMessage(REAL_ADVERT.subarray(0, 38))).toEqual({ ok: false, reason: 'truncated-record' });
    const q = buildQuery('_w17hud._udp.local');
    expect(decodeMessage(q.subarray(0, q.length - 2))).toEqual({ ok: false, reason: 'truncated-question' });
  });

  it('survives every single-byte truncation of a real packet without throwing', () => {
    for (let n = 0; n <= REAL_ADVERT.length; n += 1) {
      const res = decodeMessage(REAL_ADVERT.subarray(0, n));
      expect(typeof res.ok, `length ${n}`).toBe('boolean');
    }
  });

  it('survives every single-byte corruption of a real packet without throwing', () => {
    for (let i = 0; i < REAL_ADVERT.length; i += 1) {
      for (const xor of [0xff, 0x01, 0xc0]) {
        const bad = Buffer.from(REAL_ADVERT);
        bad[i] ^= xor;
        const res = decodeMessage(bad);
        expect(typeof res.ok, `byte ${i} ^ ${xor}`).toBe('boolean');
      }
    }
  });

  it('an A record with a wrong-sized rdata yields no address rather than garbage', () => {
    const head = Buffer.alloc(12);
    head.writeUInt16BE(0x8400, 2);
    head.writeUInt16BE(1, 6);
    const rr = Buffer.concat([
      encodeName('x.local'),
      Buffer.from([0x00, 0x01, 0x00, 0x01, 0, 0, 0, 120, 0x00, 0x10]),
      Buffer.alloc(16, 0x0a),   // 16 bytes where A wants exactly 4 (an AAAA-sized lie)
    ]);
    const res = decodeMessage(Buffer.concat([head, rr]));
    expect(res.ok).toBe(true);
    expect(res.message.records[0].data).toBeNull();
  });
});
