import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseAsarHeader, asarHasFile, checkResources, REQUIRED_APP_FILES,
} = require('../scripts/assert-packaged.js');

// Review boundaries-1 (the packaging assertion half, owner ruling OD-15(a)) and
// boundaries-6 (proto/ not packaged). CI was green for months while every
// installer it produced contained no mediamtx.exe at all: nothing asserted the
// CONTENTS of the build. This suite proves the assertion itself works — the
// windows-latest job proves the build.
//
// Nothing is spawned or executed here; the script only reads built output.

// A real asar, built by the same library electron-builder uses. Resolvable via
// electron-builder's dependency tree; if it ever is not, the hand-built
// fallback below keeps the suite meaningful.
let asarLib = null;
// W17_NO_ASAR_LIB=1 forces the hand-built path, so the fallback is exercised
// deliberately rather than only on a machine that happens to lack the library.
// Both were run green this session: the reader parses the real library's archive
// AND an independently constructed one, which is the cross-check that the framing
// constants above are right.
try { asarLib = process.env.W17_NO_ASAR_LIB ? null : require('@electron/asar'); } catch { asarLib = null; }

// Hand-built asar per the documented pickle framing, used when the library is
// unavailable. Layout: [uint32 4][uint32 headerSize][uint32 pickleSize]
// [uint32 jsonLen][json][files…].
function handBuiltAsar(header, payload = Buffer.alloc(0)) {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const padding = (4 - (json.length % 4)) % 4;
  const headerPickleSize = 4 + json.length + padding;
  const out = Buffer.alloc(16 + json.length + padding);
  out.writeUInt32LE(4, 0);
  out.writeUInt32LE(headerPickleSize + 4, 4);
  out.writeUInt32LE(headerPickleSize, 8);
  out.writeUInt32LE(json.length, 12);
  json.copy(out, 16);
  return Buffer.concat([out, payload]);
}

async function makeAsar(dest, files) {
  if (asarLib) {
    const src = mkdtempSync(join(tmpdir(), 'w17-asarsrc-'));
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(src, ...rel.split('/'));
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, body);
    }
    await asarLib.createPackage(src, dest);
    rmSync(src, { recursive: true, force: true });
    return;
  }
  const header = { files: {} };
  let offset = 0;
  const bodies = [];
  for (const [rel, body] of Object.entries(files)) {
    let node = header;
    const segs = rel.split('/');
    for (const seg of segs.slice(0, -1)) {
      node.files[seg] = node.files[seg] || { files: {} };
      node = node.files[seg];
    }
    const buf = Buffer.from(body);
    node.files[segs[segs.length - 1]] = { size: buf.length, offset: String(offset) };
    offset += buf.length;
    bodies.push(buf);
  }
  writeFileSync(dest, handBuiltAsar(header, Buffer.concat(bodies)));
}

// A complete, believable package; each test knocks one thing out of it.
async function makePackage({ mediamtx = 'mediamtx.exe', mediamtxBytes = 'MZ binary', yml = true, proto = true, layout = 'asar' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'w17-pkg-'));
  const res = join(dir, 'resources');
  mkdirSync(join(res, 'mediamtx'), { recursive: true });
  if (mediamtx) writeFileSync(join(res, 'mediamtx', mediamtx), mediamtxBytes);
  if (yml) writeFileSync(join(res, 'mediamtx', 'mediamtx.yml'), 'paths:\n  cam:\n');

  const appFiles = { 'package.json': '{"name":"w17"}', 'main/main.js': '// main' };
  if (proto) appFiles[REQUIRED_APP_FILES[0]] = 'syntax = "proto3";\n';
  if (layout === 'asar') {
    await makeAsar(join(res, 'app.asar'), appFiles);
  } else if (layout === 'plain') {
    for (const [rel, body] of Object.entries(appFiles)) {
      const abs = join(res, 'app', ...rel.split('/'));
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, body);
    }
  }
  return res;
}

describe('assert-packaged — a complete package passes', () => {
  it('mediamtx + its config + the runtime proto inside app.asar', async () => {
    const res = await makePackage();
    const { failures, notes } = checkResources(res);
    expect(failures).toEqual([]);
    expect(notes.join('\n')).toMatch(/mediamtx\.exe/);
    expect(notes.join('\n')).toMatch(/head_intent_diagnostics\.proto/);
  });

  it('the non-asar (app/ directory) layout is accepted too', async () => {
    const res = await makePackage({ layout: 'plain' });
    expect(checkResources(res).failures).toEqual([]);
  });
});

describe('assert-packaged — every gap is loud (the regressions it exists to catch)', () => {
  it('NO mediamtx executable: the exact shipped defect, named with its cause', async () => {
    const res = await makePackage({ mediamtx: null });
    const { failures } = checkResources(res);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/NO video relay/);
    expect(failures[0]).toMatch(/fetch-mediamtx/);
  });

  it('a ZERO-BYTE mediamtx is not a relay either', async () => {
    const res = await makePackage({ mediamtxBytes: '' });
    expect(checkResources(res).failures.join('\n')).toMatch(/no mediamtx executable/);
  });

  it('a missing mediamtx.yml fails: the supervisor spawns mediamtx with it by absolute path', async () => {
    const res = await makePackage({ yml: false });
    expect(checkResources(res).failures.join('\n')).toMatch(/no mediamtx\.yml/);
  });

  it('proto/ missing from app.asar fails and names the electron-builder fix (boundaries-6)', async () => {
    const res = await makePackage({ proto: false });
    const { failures } = checkResources(res);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/head_intent_diagnostics\.proto is not inside app\.asar/);
    expect(failures[0]).toMatch(/proto\/\*\* to electron-builder\.yml/);
  });

  it('proto/ missing from an app/ directory build fails too', async () => {
    const res = await makePackage({ proto: false, layout: 'plain' });
    expect(checkResources(res).failures.join('\n')).toMatch(/missing from/);
  });

  it('an UNREADABLE asar fails closed — unproven contents are never a pass', async () => {
    const res = await makePackage();
    writeFileSync(join(res, 'app.asar'), Buffer.from('not an asar at all'));
    const { failures } = checkResources(res);
    expect(failures.join('\n')).toMatch(/could not read/);
    expect(failures.join('\n')).toMatch(/contents are unproven/);
  });

  it('neither app.asar nor app/ is not an electron-builder output', async () => {
    const res = await makePackage({ layout: 'none' });
    expect(checkResources(res).failures.join('\n')).toMatch(/does not look like an electron-builder output/);
  });
});

describe('asar header reader', () => {
  it('lists real archive entries and distinguishes files from directories', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'w17-asar-'));
    const dest = join(dir, 'app.asar');
    await makeAsar(dest, { 'package.json': '{}', 'proto/head_intent_diagnostics.proto': 'syntax="proto3";' });
    const header = parseAsarHeader(readFileSync(dest));
    expect(asarHasFile(header, 'proto/head_intent_diagnostics.proto')).toBe(true);
    expect(asarHasFile(header, 'package.json')).toBe(true);
    expect(asarHasFile(header, 'proto')).toBe(false);            // a directory is not a file
    expect(asarHasFile(header, 'proto/nope.proto')).toBe(false);
    expect(asarHasFile(header, 'renderer/hud.js')).toBe(false);
  });

  it('refuses malformed input instead of guessing', () => {
    expect(() => parseAsarHeader(Buffer.alloc(4))).toThrow(/too short/);
    const bad = Buffer.alloc(32);
    bad.writeUInt32LE(0xfffffff0, 4);
    expect(() => parseAsarHeader(bad)).toThrow(/out of range/);
  });
});

describe('the CI wiring itself (the assertion is worthless if nothing calls it)', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const builder = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8');

  it('CI fetches mediamtx BEFORE packaging, then asserts the package', () => {
    const fetchAt = ci.indexOf('node scripts/fetch-mediamtx.js');
    const dirAt = ci.indexOf('electron-builder --dir');
    const assertAt = ci.indexOf('node scripts/assert-packaged.js');
    const nsisAt = ci.indexOf('electron-builder --win nsis');
    expect(fetchAt, 'ci.yml must run the mediamtx fetch').toBeGreaterThan(-1);
    expect(assertAt, 'ci.yml must run the packaging assertion').toBeGreaterThan(-1);
    expect(fetchAt).toBeLessThan(dirAt);
    expect(dirAt).toBeLessThan(assertAt);
    // The installer is built AFTER the assertion, so a bad package never
    // becomes an uploaded artifact.
    expect(assertAt).toBeLessThan(nsisAt);
  });

  it('electron-builder packages proto/** (boundaries-6)', () => {
    expect(builder).toMatch(/^\s*-\s*proto\/\*\*\s*$/m);
  });

  it('the required runtime proto is actually in the repo at that path', () => {
    expect(existsSync(new URL(`../${REQUIRED_APP_FILES[0]}`, import.meta.url))).toBe(true);
  });
});
