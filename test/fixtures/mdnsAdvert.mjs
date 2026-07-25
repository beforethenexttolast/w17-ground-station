// Builder for mDNS advertisement fixtures (CB4). Produces the wire bytes an
// iPhone HUD responder would emit per docs/windows_bridge_contract.md
// "Discovery", with a knob for each way a real or forged advertisement can
// deviate. Shared by the policy tests and the transport tests.
//
// test/dnsWire.test.js deliberately does NOT use this builder: it decodes a
// hand-written packet instead, so an encode/decode bug cannot cancel itself out.
import { encodeName, TYPE } from '../../shared/dnsWire.js';
import { SERVICE_TYPE } from '../../shared/hudDiscovery.js';

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n, 0); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n, 0); return b; };

export const rr = (name, type, rdata, ttl = 120) => Buffer.concat([
    encodeName(name), u16(type), u16(1), u32(ttl), u16(rdata.length), rdata,
]);
export const srvRdata = (port, target) => Buffer.concat([u16(0), u16(0), u16(port), encodeName(target)]);
export const txtRdata = (strings) => Buffer.concat(strings.map((s) => {
    const b = Buffer.from(s, 'utf8');
    return Buffer.concat([Buffer.from([b.length]), b]);
}));
export const aRdata = (addr) => Buffer.from(addr.split('.').map(Number));

export const message = (records, { isResponse = true } = {}) => {
    const head = Buffer.alloc(12);
    head.writeUInt16BE(isResponse ? 0x8400 : 0x0000, 2);
    head.writeUInt16BE(records.length, isResponse ? 6 : 4);
    return Buffer.concat([head, ...records]);
};

// A complete, contract-shaped advertisement. `txt: null` omits the TXT record;
// ptr/srv/a: false omit their records.
export function advert({
    instance = 'W17 HUD (Test)',
    port = 5601,
    host = 'iphone.local',
    addr = '192.168.4.7',
    txt = ['v=1', 'role=hud', 'tport=5601', 'feat=w2,w3', 'dev=Test iPhone'],
    ptr = true,
    srv = true,
    a = true,
    service = SERVICE_TYPE,
    ttl = 120,
} = {}) {
    const full = `${instance}.${service}`;
    const records = [];
    if (ptr) records.push(rr(service, TYPE.PTR, encodeName(full), ttl));
    if (srv) records.push(rr(full, TYPE.SRV, srvRdata(port, host), ttl));
    if (txt) records.push(rr(full, TYPE.TXT, txtRdata(txt), ttl));
    if (a) records.push(rr(host, TYPE.A, aRdata(addr), ttl));
    return message(records);
}

// The RFC 6762 section 10.1 withdrawal: the same advertisement re-announced
// with TTL 0, which the HUD sends when it stops listening.
export const goodbye = (opts = {}) => advert({ ...opts, ttl: 0 });
