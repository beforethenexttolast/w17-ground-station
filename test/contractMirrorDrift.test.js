import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mirroredRegion, sha256, REGION_END } = require('../scripts/check-contract-mirror.js');
const record = require('../docs/canonical/windows_bridge_contract.mirror.json');

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
