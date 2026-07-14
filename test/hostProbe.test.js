import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { HostProbe, IPV4_RE, classifyPing } = require('../main/hostProbe.js');

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
// A runCommand-shaped result; override per scenario.
const res = (over = {}) => ({ ok: true, code: 0, stdout: '', stderr: '', ...over });

// classifyPing keys on STABLE STRUCTURAL signals (audit B4): a genuine echo
// reply carries `TTL=` (locale-neutral) and is the ONLY green; exit code alone
// is never trusted (Windows returns 0 for a router "unreachable" reply).
describe('classifyPing — locale-robust ping classification', () => {
  it('an echo reply (TTL present) is reachable — English', () => {
    expect(classifyPing(res({ code: 0, stdout: fixture('ping_win_reachable_en.txt') }), 'win32'))
      .toEqual({ status: 'reachable' });
  });

  it('an echo reply is reachable in a localized (German) output too — TTL= survives', () => {
    expect(classifyPing(res({ code: 0, stdout: fixture('ping_win_reachable_de.txt') }), 'win32').status)
      .toBe('reachable');
  });

  it('"Destination host unreachable" with EXIT CODE 0 is NOT reachable (the audit L4 false-green)', () => {
    // Windows returns 0 for a router-originated ICMP error that carries no TTL.
    const c = classifyPing(res({ code: 0, stdout: fixture('ping_win_unreachable_en.txt') }), 'win32');
    expect(c.status).toBe('unreachable');
    expect(c.status).not.toBe('reachable');
  });

  it('unreachable is recognized by phrase even when the exit code is non-zero', () => {
    expect(classifyPing(res({ ok: false, code: 1, stdout: fixture('ping_win_unreachable_en.txt') }), 'win32').status)
      .toBe('unreachable');
  });

  it('a localized (German) unreachable reply is still unreachable', () => {
    expect(classifyPing(res({ code: 0, stdout: fixture('ping_win_unreachable_de.txt') }), 'win32').status)
      .toBe('unreachable');
  });

  it('a request that got no reply is a timeout', () => {
    expect(classifyPing(res({ ok: false, code: 1, stdout: fixture('ping_win_timeout_en.txt') }), 'win32').status)
      .toBe('timeout');
  });

  it('spawn failure (no exit code, not our timeout) is command-unavailable', () => {
    expect(classifyPing(res({ ok: false, code: null, stderr: 'spawn ping ENOENT' }), 'win32').status)
      .toBe('command-unavailable');
  });

  it('the wrapper timeout (code null + "timeout after Nms") is a command-error, not a network verdict', () => {
    expect(classifyPing(res({ ok: false, code: null, stderr: 'timeout after 4000ms' }), 'win32').status)
      .toBe('command-error');
  });

  it('unrecognized localized output with a non-zero exit stays a conservative unknown, never a green', () => {
    const c = classifyPing(res({ ok: false, code: 1, stdout: 'una respuesta que no reconocemos' }), 'win32');
    expect(c.status).toBe('unknown');
    expect(c.status).not.toBe('reachable');
  });

  it('does NOT treat a Windows exit 0 as reachable without an echo reply', () => {
    // Exit 0, some reply text, but no TTL -> a non-echo reply -> unreachable.
    expect(classifyPing(res({ code: 0, stdout: 'Reply from 10.0.0.1: something-not-an-echo' }), 'win32').status)
      .not.toBe('reachable');
  });

  it('non-Windows: a reply with ttl is reachable; no route is unreachable', () => {
    expect(classifyPing(res({ code: 0, stdout: '64 bytes from 1.2.3.4: icmp_seq=0 ttl=57 time=8 ms' }), 'darwin').status)
      .toBe('reachable');
    expect(classifyPing(res({ ok: false, code: 1, stdout: 'ping: sendto: No route to host' }), 'darwin').status)
      .toBe('unreachable');
  });
});

describe('HostProbe.probe — validation, shape, and injection resistance', () => {
  it('rejects a non-IPv4 address WITHOUT spawning a process (injection-proof)', async () => {
    const calls = [];
    const run = async (...a) => { calls.push(a); return res(); };
    const probe = new HostProbe({ run, platform: 'win32' });
    for (const bad of ['not-an-ip', '8.8.8.8; rm -rf /', '999.1.1.1', '', '1.2.3']) {
      const r = await probe.probe(bad);
      expect(r).toMatchObject({ ok: false, status: 'invalid' });
    }
    expect(calls).toHaveLength(0);
  });

  it('a valid address spawns ping with the address as an argv element and a bounded timeout', async () => {
    const calls = [];
    const run = async (cmd, args, opts) => { calls.push({ cmd, args, opts }); return res({ code: 0, stdout: fixture('ping_win_reachable_en.txt') }); };
    const probe = new HostProbe({ run, platform: 'win32' });
    const r = await probe.probe('192.168.1.9');
    expect(r).toMatchObject({ ok: true, status: 'reachable' });
    expect(typeof r.rttMs).toBe('number');
    expect(calls[0].cmd).toBe('ping');
    expect(calls[0].args).toContain('192.168.1.9'); // argv, never a shell string
    expect(calls[0].opts.timeoutMs).toBe(4000);      // bounded, and A1/N4 tree-kill on timeout
  });

  it('a false-green (exit 0, unreachable) surfaces as a red result to callers', async () => {
    const run = async () => res({ code: 0, stdout: fixture('ping_win_unreachable_en.txt') });
    const r = await new HostProbe({ run, platform: 'win32' }).probe('192.168.1.50');
    expect(r.ok).toBe(false);
    expect(r.status).toBe('unreachable');
  });

  it('a reachable probe returns ok:true with an rtt; a timeout returns ok:false + status', async () => {
    const okRun = async () => res({ code: 0, stdout: fixture('ping_win_reachable_en.txt') });
    expect(await new HostProbe({ run: okRun, platform: 'win32' }).probe('1.2.3.4'))
      .toMatchObject({ ok: true, status: 'reachable' });
    const toRun = async () => res({ ok: false, code: 1, stdout: fixture('ping_win_timeout_en.txt') });
    expect(await new HostProbe({ run: toRun, platform: 'win32' }).probe('1.2.3.4'))
      .toMatchObject({ ok: false, status: 'timeout' });
  });

  it('IPV4_RE accepts dotted quads and rejects the rest', () => {
    expect(IPV4_RE.test('192.168.1.9')).toBe(true);
    expect(IPV4_RE.test('255.255.255.255')).toBe(true);
    expect(IPV4_RE.test('256.1.1.1')).toBe(false);
    expect(IPV4_RE.test('1.2.3')).toBe(false);
  });
});
