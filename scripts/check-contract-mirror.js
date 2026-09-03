#!/usr/bin/env node
// Cross-repo drift guard for the iPhone<->Windows bridge contract mirror
// (grand verdict cluster-5(e)). docs/windows_bridge_contract.md reproduces
// sections 1-7 of the CANONICAL contract, which lives with the iPhone app at
// iPhone_rc/docs/windows_bridge_contract.md — today that reproduction is
// verbatim only because someone kept it so by hand.
//
// Same two-half shape as the proto drift guard (scripts/check-canonical-proto.js
// + test/protoDrift.test.js):
//
//   HERMETIC half (default, and what CI runs): re-derive the SHA-256 of the
//   mirrored region of THIS repo's copy and compare it to the record in
//   docs/canonical/windows_bridge_contract.mirror.json. Needs no sibling
//   checkout, so an edit to the mirror is a red CI step on every push.
//
//   SIBLING half (--sibling): additionally read the canonical file from a local
//   iPhone_rc checkout AT THE RECORDED SYNC HASH and compare it verbatim. This
//   is what proves the recorded digest really describes the canonical text and
//   not just whatever this repo happens to contain.
//
// The record can only be (re)generated FROM the canonical (--write requires the
// sibling), so the digest can never be rubber-stamped from the mirror itself.
//
// Usage:
//   node scripts/check-contract-mirror.js             # hermetic
//   node scripts/check-contract-mirror.js --sibling   # + compare to iPhone_rc
//   node scripts/check-contract-mirror.js --write     # re-record from iPhone_rc's
//                                                      #   main tip (see --sync-hash)
//   node scripts/check-contract-mirror.js --write --sync-hash <sha>
//                                                      # re-record from that
//                                                      #   exact iPhone_rc commit
//   W17_IPHONE_REPO=/path/to/iPhone_rc node scripts/check-contract-mirror.js --sibling
//
// The re-sync workflow (a canonical edit landed in iPhone_rc):
//   1. Copy sections 1-7 of iPhone_rc/docs/windows_bridge_contract.md verbatim
//      into this repo's docs/windows_bridge_contract.md.
//   2. Run `npm run contract:sync` (== --write). With no --sync-hash it reads
//      the sibling's CURRENT `main` tip — not the stale hash already in the
//      record — so a newly-landed canonical commit is picked up with no hand
//      edit. Pass --sync-hash <sha> to pin to a specific historical commit
//      instead (e.g. to verify against a tag, or before the sibling's main has
//      advanced past the commit you actually copied from).
//   3. `npm run contract:sync` fails (exit 2) if what it just recorded does not
//      match this repo's copy — that means step 1 was incomplete or mis-copied.
//
// Order of checks (review item 4): the HERMETIC half always runs first, before
// any --sibling/--write attempt to reach a checkout. A --sibling run on a
// machine with no iPhone_rc checkout used to short-circuit straight to the
// SKIP exit, silently passing over local drift the hermetic half would have
// caught; now local drift is reported (exit 2) even when the sibling half
// cannot run at all.
//
// Exit codes: 0 = in sync (or written); 2 = drift; 3 = --sibling/--write asked
// for but no iPhone_rc checkout found (skipped, not a failure — the hermetic
// half still guards this repo, and always runs).

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const MIRROR_PATH = path.join(REPO_ROOT, 'docs', 'windows_bridge_contract.md');
const RECORD_PATH = path.join(REPO_ROOT, 'docs', 'canonical', 'windows_bridge_contract.mirror.json');

// The mirrored region: the canonical document itself. It starts at the contract
// title and ends where THIS repo's own, non-normative appendix begins (the
// canonical has no appendix, so there the region simply runs to the end).
const REGION_START = '# W17 iPhone <-> Windows Bridge Contract';
const REGION_END = '# Appendix: Windows implementation notes';

// Pure: pull the mirrored region out of either document. Trailing whitespace and
// the horizontal rule that introduces the appendix are normalized away, so the
// two files' region text is comparable byte for byte. Line endings are normalized
// to LF first: a Windows checkout with core.autocrlf rewrites the mirror to CRLF,
// and the digest must describe the CONTENT, not the checkout (the windows-latest
// package-smoke job went red on exactly this on 2026-09-03).
function mirroredRegion(rawText) {
    const text = rawText.replace(/\r\n?/g, '\n');
    const start = text.indexOf(REGION_START);
    if (start === -1) throw new Error(`contract title not found ("${REGION_START}")`);
    const end = text.indexOf(REGION_END);
    let body = (end === -1 ? text.slice(start) : text.slice(start, end)).replace(/\s+$/, '');
    if (body.endsWith('---')) body = body.slice(0, -3).replace(/\s+$/, '');
    return `${body}\n`;
}

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function resolveSiblingRepo() {
    return process.env.W17_IPHONE_REPO || path.join(REPO_ROOT, '..', 'iPhone_rc');
}

// --sync-hash <sha> from argv, or null if not given.
function argSyncHash() {
    const idx = process.argv.indexOf('--sync-hash');
    if (idx === -1) return null;
    const sha = process.argv[idx + 1];
    if (!sha || sha.startsWith('--')) {
        throw new Error('--sync-hash requires a commit hash argument');
    }
    return sha;
}

// The commit to read the canonical from. Explicit --sync-hash always wins.
// Otherwise: --write defaults to the sibling's CURRENT main tip (review item
// 3 — without this, --write could only ever re-copy the digest at whatever
// hash was already in the record, which is the one thing it can never
// advance); a bare --sibling verify defaults to the RECORDED hash, because its
// job is to confirm that specific, already-recorded commit still matches.
function resolveSyncHash(repo, { forWrite, record }) {
    const explicit = argSyncHash();
    if (explicit) return explicit;
    if (!forWrite) return record.syncHash;
    const res = spawnSync('git', ['-C', repo, 'rev-parse', 'main'], { encoding: 'utf8' });
    if (res.status !== 0) {
        throw new Error(`git rev-parse main failed in ${repo}: ${(res.stderr || '').trim()}`);
    }
    return res.stdout.trim();
}

// Read the canonical file out of the sibling repo's HISTORY at a given
// hash — never its working tree, which may be mid-edit or on another branch.
function canonicalAt(repo, hash, relPath) {
    const res = spawnSync('git', ['-C', repo, 'show', `${hash}:${relPath}`], { encoding: 'utf8' });
    if (res.status !== 0) {
        throw new Error(`git show ${hash}:${relPath} failed in ${repo}: ${(res.stderr || '').trim()}`);
    }
    return res.stdout;
}

function loadRecord() {
    return JSON.parse(fs.readFileSync(RECORD_PATH, 'utf8'));
}

function main() {
    const wantSibling = process.argv.includes('--sibling');
    const write = process.argv.includes('--write');
    const record = loadRecord();
    const mirrorText = fs.readFileSync(MIRROR_PATH, 'utf8');
    const region = mirroredRegion(mirrorText);
    const digest = sha256(region);

    // HERMETIC half FIRST (review item 4), unconditionally — except for --write,
    // whose entire job is to move the record, so a mismatch against the OLD
    // record is not an error there. Running this before any sibling-checkout
    // attempt means a --sibling invocation on a machine with no iPhone_rc
    // checkout still reports real local drift (exit 2) instead of a bare SKIP
    // that silently passes over it.
    if (!write && digest !== record.sha256) {
        console.error('[contract-mirror] DRIFT: the mirrored region no longer matches the recorded canonical.');
        console.error(`  recorded ${record.sha256} (${record.bytes} bytes, ${record.canonicalRepo} @ ${record.syncHash})`);
        console.error(`  found    ${digest} (${Buffer.byteLength(region, 'utf8')} bytes)`);
        console.error('  Sections 1-7 are a VERBATIM reproduction — edit the canonical in iPhone_rc,');
        console.error('  re-mirror, then re-run this script with --write.');
        process.exit(2);
    }

    if (write || wantSibling) {
        const repo = resolveSiblingRepo();
        if (!fs.existsSync(path.join(repo, '.git'))) {
            console.error(`[contract-mirror] SKIP: no iPhone_rc checkout at ${repo}`);
            console.error('[contract-mirror] Set W17_IPHONE_REPO or place iPhone_rc beside this repo.');
            console.error('[contract-mirror] The hermetic check (npm test) still guards this repo.');
            process.exit(3);
        }
        let syncHash;
        let canonRegion;
        try {
            syncHash = resolveSyncHash(repo, { forWrite: write, record });
            canonRegion = mirroredRegion(canonicalAt(repo, syncHash, record.canonicalPath));
        } catch (err) {
            console.error(`[contract-mirror] FAILED to read the canonical: ${err.message}`);
            process.exit(2);
        }
        const canonDigest = sha256(canonRegion);
        if (write) {
            const next = {
                ...record,
                syncHash,
                sha256: canonDigest,
                bytes: Buffer.byteLength(canonRegion, 'utf8'),
                recordedAt: new Date().toISOString().slice(0, 10),
            };
            fs.mkdirSync(path.dirname(RECORD_PATH), { recursive: true });
            fs.writeFileSync(RECORD_PATH, `${JSON.stringify(next, null, 2)}\n`);
            console.log(`[contract-mirror] recorded ${canonDigest} from ${repo} @ ${syncHash}`);
            if (canonDigest !== digest) {
                console.error('[contract-mirror] NOTE: this repo\'s mirror does NOT match what was just recorded — re-sync sections 1-7.');
                process.exit(2);
            }
            process.exit(0);
        }
        if (canonDigest !== digest) {
            console.error(`[contract-mirror] DRIFT against ${repo} @ ${syncHash}`);
            console.error(`  canonical sha256 ${canonDigest}`);
            console.error(`  this repo        ${digest}`);
            console.error('  Re-sync sections 1-7 verbatim, then re-run with --write.');
            process.exit(2);
        }
        console.log(`[contract-mirror] verbatim against ${repo} @ ${syncHash}`);
    }

    console.log(`[contract-mirror] in sync: ${digest} (${record.bytes} bytes, canonical @ ${record.syncHash})`);
}

module.exports = {
    mirroredRegion, sha256, MIRROR_PATH, RECORD_PATH, REGION_START, REGION_END,
    resolveSyncHash, resolveSiblingRepo,
};

if (require.main === module) main();
