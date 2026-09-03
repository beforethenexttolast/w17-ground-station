import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assetFor, checkDigest, sha256File, MEDIAMTX_VERSION } = require('../scripts/fetch-mediamtx.js');
const pin = require('../scripts/mediamtx-pin.json');

// Owner ruling OD-15(a) (review boundaries-1): the mediamtx binary is fetched at
// build time, so the fetch has to be pinned or the gift kit's video relay is
// whatever the network served that day. The digest logic is a pure function
// precisely so it can be proven here — nothing is downloaded in this suite.

describe('mediamtx release asset naming', () => {
  it('maps every platform this project builds on to the real published asset', () => {
    expect(assetFor('win32', 'x64')).toMatchObject({
      key: 'windows_amd64', file: `mediamtx_${MEDIAMTX_VERSION}_windows_amd64.zip`, ext: 'zip', binName: 'mediamtx.exe',
    });
    expect(assetFor('darwin', 'arm64')).toMatchObject({ key: 'darwin_arm64', binName: 'mediamtx', ext: 'tar.gz' });
    expect(assetFor('darwin', 'x64')).toMatchObject({ key: 'darwin_amd64' });
    expect(assetFor('linux', 'x64')).toMatchObject({ key: 'linux_amd64' });
  });

  it('linux/arm64 is arm64v8 — the plain spelling is not a published asset (it 404s)', () => {
    expect(assetFor('linux', 'arm64').file).toBe(`mediamtx_${MEDIAMTX_VERSION}_linux_arm64v8.tar.gz`);
    expect(assetFor('darwin', 'arm64').file).toBe(`mediamtx_${MEDIAMTX_VERSION}_darwin_arm64.tar.gz`);
  });

  it('the pin file covers exactly the keys the resolver can produce, at the pinned version', () => {
    const keys = ['win32:x64', 'darwin:arm64', 'darwin:x64', 'linux:x64', 'linux:arm64']
      .map((s) => s.split(':'))
      .map(([p, a]) => assetFor(p, a));
    expect(pin.version).toBe(MEDIAMTX_VERSION);
    expect(Object.keys(pin.binaries).sort()).toEqual([...new Set(keys.map((k) => k.key))].sort());
    for (const k of keys) {
      const entry = pin.binaries[k.key];
      // The pin file names the same asset and executable the fetcher will use —
      // a rename on either side must not drift silently.
      expect(entry.asset, `${k.key} asset name`).toBe(k.file);
      expect(entry.binary, `${k.key} binary name`).toBe(k.binName);
      expect(entry.sha256 === null || /^[0-9a-f]{64}$/.test(entry.sha256), `${k.key} digest shape`).toBe(true);
    }
  });

  it('every RECORDED digest carries its provenance — a bare hash nobody can trace is not a pin', () => {
    for (const [key, entry] of Object.entries(pin.binaries)) {
      if (entry.sha256) expect(typeof entry.recorded, `${key} provenance`).toBe('string');
    }
  });
});

describe('checkDigest — the enforcement decision (OD-15(a))', () => {
  const p = { binaries: { windows_amd64: { sha256: 'a'.repeat(64) }, linux_amd64: { sha256: null } } };

  it('a matching digest installs (case-insensitively — hex is hex)', () => {
    expect(checkDigest({ key: 'windows_amd64', digest: 'a'.repeat(64), pin: p })).toMatchObject({ ok: true, state: 'match' });
    expect(checkDigest({ key: 'windows_amd64', digest: 'A'.repeat(64), pin: p })).toMatchObject({ ok: true, state: 'match' });
  });

  it('a MISMATCH refuses, names both digests, and says nothing was installed', () => {
    const v = checkDigest({ key: 'windows_amd64', digest: 'b'.repeat(64), pin: p });
    expect(v.ok).toBe(false);
    expect(v.state).toBe('mismatch');
    expect(v.message).toContain('a'.repeat(64));
    expect(v.message).toContain('b'.repeat(64));
    expect(v.message).toMatch(/Nothing was installed/);
  });

  it('an UNRECORDED platform installs with a loud RECORD line naming the exact JSON path', () => {
    const v = checkDigest({ key: 'linux_amd64', digest: 'c'.repeat(64), pin: p });
    expect(v).toMatchObject({ ok: true, state: 'unrecorded' });
    expect(v.message).toContain('binaries["linux_amd64"].sha256');
    expect(v.message).toContain('c'.repeat(64));
  });

  it('--require-pin turns "unrecorded" into a refusal — the switch to flip once every platform is recorded', () => {
    expect(checkDigest({ key: 'linux_amd64', digest: 'c'.repeat(64), pin: p, requirePin: true }).ok).toBe(false);
    expect(checkDigest({ key: 'nope_arch', digest: 'c'.repeat(64), pin: p, requirePin: true }).ok).toBe(false);
    // …and a recorded platform is unaffected by the flag.
    expect(checkDigest({ key: 'windows_amd64', digest: 'a'.repeat(64), pin: p, requirePin: true }).ok).toBe(true);
  });

  it('an unknown key or an empty pin never silently passes as "match"', () => {
    expect(checkDigest({ key: 'plan9_sparc', digest: 'd'.repeat(64), pin: p }).state).toBe('unrecorded');
    expect(checkDigest({ key: 'windows_amd64', digest: 'd'.repeat(64), pin: {} }).state).toBe('unrecorded');
    expect(checkDigest({ key: 'windows_amd64', digest: '', pin: p }).state).toBe('mismatch');
  });
});

describe('sha256File', () => {
  it('hashes file bytes (the known-answer test for the digest the pin compares)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'w17-mtxpin-'));
    const f = join(dir, 'x.bin');
    writeFileSync(f, 'abc');
    // NIST's published SHA-256 of "abc".
    expect(await sha256File(f)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
