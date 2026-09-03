import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  mirroredRegion, sha256, REGION_END, resolveSyncHash,
} = require('../scripts/check-contract-mirror.js');
const record = require('../docs/canonical/windows_bridge_contract.mirror.json');
// fileURLToPath, not .pathname: on Windows .pathname is '/D:/a/...' and joining it
// produced 'D:\D:\a\...' (windows-latest run 33810043436).
const SCRIPT_PATH = fileURLToPath(new URL('../scripts/check-contract-mirror.js', import.meta.url));

// Grand verdict cluster-5(e): docs/windows_bridge_contract.md reproduces the
// canonical contract (iPhone_rc/docs/windows_bridge_contract.md) verbatim, and
// until now that was true only because someone kept it so by hand. This is the
// HERMETIC half of the guard — it needs no sibling checkout, so it runs in every
// CI and an edit to the mirror is a red step on the push that makes it.
//
// The recorded digest can only be produced by
// `node scripts/check-contract-mirror.js --write`, which reads the CANONICAL out
// of an iPhone_rc checkout at the recorded hash — so it cannot be rubber-stamped
// from this repo's own copy.

const mirrorText = readFileSync(new URL('../docs/windows_bridge_contract.md', import.meta.url), 'utf8');

describe('windows_bridge_contract mirror (cluster-5(e))', () => {
  it('the mirrored region still matches the recorded canonical, byte for byte', () => {
    const region = mirroredRegion(mirrorText);
    expect(sha256(region)).toBe(record.sha256);
    expect(Buffer.byteLength(region, 'utf8')).toBe(record.bytes);
  });

  it('the record and the document agree on WHICH canonical revision was mirrored', () => {
    expect(record.syncHash).toMatch(/^[0-9a-f]{40}$/);
    // The banner the reader sees must name the same revision the digest is from.
    expect(mirrorText).toContain(record.syncHash);
    expect(record.canonicalRepo).toBe('iPhone_rc');
    expect(record.canonicalPath).toBe('docs/windows_bridge_contract.md');
  });

  it('a CRLF checkout (Windows core.autocrlf) yields the same digest as LF', () => {
    // windows-latest checks the repo out with CRLF line endings; the digest pins
    // content, so the region hash must not depend on the checkout's line endings.
    // Build BOTH variants explicitly — the file on disk is already CRLF on a
    // Windows checkout, so "convert and compare to the original" proves nothing there.
    const lf = mirrorText.replace(/\r\n/g, '\n');
    const crlf = lf.replace(/\n/g, '\r\n');
    expect(crlf).not.toBe(lf);
    expect(sha256(mirroredRegion(lf))).toBe(record.sha256);
    expect(sha256(mirroredRegion(crlf))).toBe(record.sha256);
    expect(Buffer.byteLength(mirroredRegion(crlf), 'utf8')).toBe(record.bytes);
  });

  it("this repo's own appendix is OUTSIDE the mirrored region — it may evolve freely", () => {
    expect(mirrorText).toContain(REGION_END); // the appendix exists…
    const region = mirroredRegion(mirrorText);
    expect(region).not.toContain(REGION_END); // …and is not part of what is pinned
    expect(region).not.toContain('W17_IPHONE_BRIDGE'); // an appendix-only detail
    // Editing the appendix must not move the digest.
    const edited = `${mirrorText}\n\n## A new appendix section\n\nAnything.\n`;
    expect(sha256(mirroredRegion(edited))).toBe(record.sha256);
  });

  it('an edit INSIDE the region does move the digest (the mechanism, not a tautology)', () => {
    const tampered = mirrorText.replace(
      'The Windows ground station remains the control authority.',
      'The Windows ground station is basically the control authority.',
    );
    expect(tampered).not.toBe(mirrorText); // the sentence is really there
    expect(sha256(mirroredRegion(tampered))).not.toBe(record.sha256);
  });

  it('the banner still tells the reader the canonical lives with the iPhone app', () => {
    const banner = mirrorText.slice(0, mirrorText.indexOf('# W17 iPhone'));
    expect(banner).toContain('iPhone_rc/docs/windows_bridge_contract.md');
    expect(banner).toMatch(/verbatim/i);
  });

  it('mirroredRegion refuses a document that is not the contract', () => {
    expect(() => mirroredRegion('# Something else\n\nnope\n')).toThrow(/contract title not found/);
  });
});

// Review adffe40ca3aaab56c.md item 3: --write used to read the canonical at
// the EXISTING record.syncHash and copy it forward unchanged, so a newly
// landed canonical commit could never be picked up without a hand-edit of the
// record first — nothing documented that edit. resolveSyncHash() is the fix:
// an explicit --sync-hash always wins; otherwise --write defaults to the
// sibling's CURRENT main tip (so it can actually advance the record) and a
// bare --sibling verify keeps defaulting to the recorded hash (its job is to
// confirm THAT commit still matches, not to silently move the goalposts).
describe('resolveSyncHash (review item 3 — --write must be able to advance the record)', () => {
  const origArgv = process.argv;
  afterEach(() => { process.argv = origArgv; });

  function gitRepo() {
    const dir = mkdtempSync(join(tmpdir(), 'w17-mirror-repo-'));
    spawnSync('git', ['init', '-q', '-b', 'main', dir]);
    spawnSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
    spawnSync('git', ['-C', dir, 'config', 'user.name', 'test']);
    writeFileSync(join(dir, 'f.txt'), 'one\n');
    spawnSync('git', ['-C', dir, 'add', 'f.txt']);
    spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'first']);
    return dir;
  }

  it('an explicit --sync-hash always wins, for --write AND for a bare --sibling verify', () => {
    process.argv = [...origArgv, '--sync-hash', 'deadbeef00000000000000000000000000000001'];
    const repo = gitRepo();
    const record = { syncHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
    expect(resolveSyncHash(repo, { forWrite: true, record })).toBe('deadbeef00000000000000000000000000000001');
    expect(resolveSyncHash(repo, { forWrite: false, record })).toBe('deadbeef00000000000000000000000000000001');
  });

  it('--write with no --sync-hash defaults to the SIBLING\'S CURRENT main tip, not the stale recorded hash', () => {
    process.argv = origArgv; // no --sync-hash on the command line
    const repo = gitRepo();
    const realTip = spawnSync('git', ['-C', repo, 'rev-parse', 'main'], { encoding: 'utf8' }).stdout.trim();
    const record = { syncHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }; // deliberately stale/unrelated
    const resolved = resolveSyncHash(repo, { forWrite: true, record });
    expect(resolved).toBe(realTip);
    expect(resolved).not.toBe(record.syncHash);
  });

  it('a bare --sibling verify (no --write, no --sync-hash) keeps using the RECORDED hash', () => {
    process.argv = origArgv;
    const repo = gitRepo();
    const record = { syncHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };
    // Verify mode must not silently jump to whatever the sibling's main has
    // become — it confirms the ALREADY-RECORDED commit still matches.
    expect(resolveSyncHash(repo, { forWrite: false, record })).toBe(record.syncHash);
  });

  it('--sync-hash with no value, or followed by another flag, is a usage error', () => {
    process.argv = [...origArgv, '--sync-hash'];
    expect(() => resolveSyncHash('/irrelevant', { forWrite: true, record: {} }))
      .toThrow(/--sync-hash requires a commit hash/);
    process.argv = [...origArgv, '--sync-hash', '--write'];
    expect(() => resolveSyncHash('/irrelevant', { forWrite: true, record: {} }))
      .toThrow(/--sync-hash requires a commit hash/);
  });
});

// Review adffe40ca3aaab56c.md item 4: with no sibling checkout, --sibling used
// to exit(3) (SKIP) BEFORE the hermetic comparison ever ran, so real local
// drift went unreported — the operator sees "SKIP" and reasonably reads that
// as "nothing to worry about," when the mirror is actually broken. The fix
// runs the hermetic half first, unconditionally (except for --write, whose
// entire purpose is to move the record). These spawn the REAL CLI end to end
// against a throwaway fixture copy (not this repo's own docs), so the process
// exit code — the actual contract other tooling and CI depend on — is what's
// under test, not just the pure helpers.
describe('check-contract-mirror.js CLI ordering (review item 4)', () => {
  const fixtures = [];
  afterEach(() => {
    while (fixtures.length) rmSync(fixtures.pop(), { recursive: true, force: true });
  });

  // A standalone copy of the script plus its two data files, so the CLI can be
  // spawned with REPO_ROOT (== the copy's own __dirname/..) pointing somewhere
  // this test fully controls.
  function fixtureRepo({ mirrorMatchesRecord }) {
    const root = mkdtempSync(join(tmpdir(), 'w17-mirror-cli-'));
    fixtures.push(root);
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, 'docs', 'canonical'), { recursive: true });
    cpSync(SCRIPT_PATH, join(root, 'scripts', 'check-contract-mirror.js'));

    const mirrorText = [
      '# Fixture banner (verbatim, iPhone_rc/docs/windows_bridge_contract.md)',
      '',
      '# W17 iPhone <-> Windows Bridge Contract',
      '',
      'Fixture contract body.',
      '',
      '# Appendix: Windows implementation notes',
      '',
      'Fixture appendix.',
      '',
    ].join('\n');
    writeFileSync(join(root, 'docs', 'windows_bridge_contract.md'), mirrorText, 'utf8');

    const region = mirroredRegion(mirrorText);
    const trueDigest = sha256(region);
    const recordedDigest = mirrorMatchesRecord ? trueDigest : 'f'.repeat(64); // deliberately wrong
    writeFileSync(
      join(root, 'docs', 'canonical', 'windows_bridge_contract.mirror.json'),
      JSON.stringify({
        canonicalRepo: 'iPhone_rc',
        canonicalPath: 'docs/windows_bridge_contract.md',
        syncHash: 'a'.repeat(40),
        sha256: recordedDigest,
        bytes: Buffer.byteLength(region, 'utf8'),
        recordedAt: '2026-01-01',
      }, null, 2),
      'utf8',
    );
    return join(root, 'scripts', 'check-contract-mirror.js');
  }

  function run(scriptPath, args, env) {
    return spawnSync(process.execPath, [scriptPath, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
  }

  it('bare hermetic: in sync -> exit 0; drifted -> exit 2', () => {
    const okScript = fixtureRepo({ mirrorMatchesRecord: true });
    expect(run(okScript, [], {}).status).toBe(0);

    const badScript = fixtureRepo({ mirrorMatchesRecord: false });
    const bad = run(badScript, [], {});
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/DRIFT/);
  });

  it('THE FIX: --sibling with NO checkout AND local drift reports DRIFT (exit 2), never a bare SKIP', () => {
    const badScript = fixtureRepo({ mirrorMatchesRecord: false });
    const res = run(badScript, ['--sibling'], { W17_IPHONE_REPO: '/definitely/does/not/exist' });
    expect(res.status).toBe(2); // NOT 3 — this is the regression the finding named
    expect(res.stderr).toMatch(/DRIFT/);
    expect(res.stderr).not.toMatch(/SKIP/);
  });

  it('unchanged: --sibling with NO checkout but nothing locally wrong still SKIPs (exit 3)', () => {
    const okScript = fixtureRepo({ mirrorMatchesRecord: true });
    const res = run(okScript, ['--sibling'], { W17_IPHONE_REPO: '/definitely/does/not/exist' });
    expect(res.status).toBe(3);
    expect(res.stderr).toMatch(/SKIP/);
  });

  it('unchanged: --write is exempt from the pre-check even when the OLD record does not match', () => {
    // --write's whole job is to move the record; it must not refuse to run
    // just because the record it is about to overwrite is stale/wrong. With no
    // sibling checkout available it still SKIPs (exit 3), same as before.
    const badScript = fixtureRepo({ mirrorMatchesRecord: false });
    const res = run(badScript, ['--write'], { W17_IPHONE_REPO: '/definitely/does/not/exist' });
    expect(res.status).toBe(3);
    expect(res.stderr).toMatch(/SKIP/);
  });
});
