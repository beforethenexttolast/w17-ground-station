// Downloads a pinned mediamtx binary for the host platform into mediamtx/.
// The binary is NOT committed (it's in .gitignore); run `npm run fetch-mediamtx`
// (or `npm run setup`) after cloning, and CI runs it before packaging so the
// installer actually contains the video relay (review boundaries-1). CommonJS.
//
// TWO pins, both load-bearing:
//   1. VERSION  — mediamtx.yml's config keys are release-specific, so the tag is
//      fixed here and mediamtx/mediamtx.yml points back at this file.
//   2. SHA-256  — owner ruling OD-15(a). scripts/mediamtx-pin.json records the
//      digest of the EXTRACTED executable (the artifact the installer ships,
//      which is a stronger thing to pin than the archive). A recorded digest is
//      ENFORCED: a mismatch deletes the binary and fails, so a compromised or
//      swapped release cannot ride into the gift kit unnoticed.
//
// Honest limits of that pin: bluenviron/mediamtx publishes no checksum file for
// v1.9.3 and the GitHub API returns no asset digest for it, so the recorded
// values are trust-on-first-use — recorded once from a verified copy, enforced
// forever after. A platform whose digest is not recorded yet prints a loud
// RECORD line with the observed value instead of silently accepting it; pass
// --require-pin to make that a hard failure (do that once every platform this
// project ships has a recorded digest).
//
// Usage:
//   node scripts/fetch-mediamtx.js                 # fetch + verify
//   node scripts/fetch-mediamtx.js --require-pin   # also fail when unrecorded
//
// Exit codes: 0 = installed and verified (or installed with a RECORD notice);
// 1 = download/extract failure, digest MISMATCH, or an unrecorded digest under
// --require-pin.

'use strict';

const { mkdirSync, existsSync, createWriteStream, chmodSync, createReadStream, rmSync } = require('node:fs');
const { rm } = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const MEDIAMTX_VERSION = 'v1.9.3'; // PIN: verify WHEP config keys match this release
const outDir = path.join(__dirname, '..', 'mediamtx');
const PIN_PATH = path.join(__dirname, 'mediamtx-pin.json');

// Release asset naming, exactly as bluenviron/mediamtx publishes it. NOTE the
// linux/arm64 spelling: the asset is `linux_arm64v8`, not `linux_arm64` — the
// plain spelling this script used before the pin landed 404s.
function assetFor(platform, arch, version = MEDIAMTX_VERSION) {
    const osName = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : 'linux';
    let archName;
    if (arch === 'x64') archName = 'amd64';
    else if (arch === 'arm64') archName = osName === 'linux' ? 'arm64v8' : 'arm64';
    else archName = arch;
    const ext = osName === 'windows' ? 'zip' : 'tar.gz';
    const binName = osName === 'windows' ? 'mediamtx.exe' : 'mediamtx';
    return {
        key: `${osName}_${archName}`,
        file: `mediamtx_${version}_${osName}_${archName}.${ext}`,
        osName,
        ext,
        binName,
    };
}

// The digest decision, as a pure function so it is testable without a network
// or a 15 MB download. Returns { ok, state, message }.
//   state 'match'      — recorded digest and the file agree; install it.
//   state 'mismatch'   — recorded digest and the file DISAGREE; never install.
//   state 'unrecorded' — nothing recorded for this platform yet.
function checkDigest({ key, digest, pin, requirePin = false }) {
    const entry = (pin && pin.binaries && pin.binaries[key]) || null;
    const expected = entry && typeof entry.sha256 === 'string' && entry.sha256 ? entry.sha256.toLowerCase() : null;
    const got = String(digest || '').toLowerCase();
    if (expected) {
        if (expected === got) return { ok: true, state: 'match', message: `sha256 ${got} matches the pin` };
        return {
            ok: false,
            state: 'mismatch',
            message: `SHA-256 MISMATCH for ${key}\n  expected ${expected}\n  got      ${got}\n`
                + '  The download does NOT match the recorded pin. Nothing was installed. '
                + 'Do not ship this binary; re-run on a clean network, and if it still differs, '
                + 'treat scripts/mediamtx-pin.json as the truth and investigate upstream.',
        };
    }
    const record = `RECORD THIS in scripts/mediamtx-pin.json -> binaries["${key}"].sha256 = "${got}"`;
    if (requirePin) {
        return { ok: false, state: 'unrecorded', message: `no SHA-256 recorded for ${key} and --require-pin was given.\n  ${record}` };
    }
    return {
        ok: true,
        state: 'unrecorded',
        message: `NO SHA-256 PIN for ${key} — installed UNVERIFIED (owner ruling OD-15(a) is not yet closed for this platform).\n  ${record}`,
    };
}

function sha256File(file) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const rs = createReadStream(file);
        rs.on('error', reject);
        rs.on('data', (d) => hash.update(d));
        rs.on('end', () => resolve(hash.digest('hex')));
    });
}

function loadPin() {
    // eslint-disable-next-line global-require
    return require(PIN_PATH);
}

async function main() {
    const requirePin = process.argv.includes('--require-pin');
    mkdirSync(outDir, { recursive: true });
    const { key, file, osName, ext, binName } = assetFor(process.platform, process.arch);
    const url = `https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VERSION}/${file}`;
    const archive = path.join(outDir, file);
    const binary = path.join(outDir, binName);

    console.log(`[fetch-mediamtx] ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await new Promise((resolve, reject) => {
        const ws = createWriteStream(archive);
        ws.on('error', reject);
        ws.on('finish', resolve);
        ws.end(buf);
    });

    // Extract just the binary (release archives also ship a sample yml we don't
    // use -- our mediamtx.yml is authoritative).
    if (ext === 'zip') {
        spawnSync('tar', ['-xf', archive, '-C', outDir, binName], { stdio: 'inherit' });
    } else {
        spawnSync('tar', ['-xzf', archive, '-C', outDir, binName], { stdio: 'inherit' });
        if (existsSync(binary)) chmodSync(binary, 0o755);
    }
    await rm(archive);
    if (!existsSync(binary)) throw new Error(`extraction produced no ${binName} in ${outDir}`);

    // Verify BEFORE declaring success. A mismatched binary is removed, not left
    // on disk where the next packaging run would happily bundle it.
    const digest = await sha256File(binary);
    const verdict = checkDigest({ key, digest, pin: loadPin(), requirePin });
    if (!verdict.ok) {
        rmSync(binary, { force: true });
        throw new Error(verdict.message);
    }
    console.log(`[fetch-mediamtx] ${verdict.state === 'match' ? '' : 'WARNING: '}${verdict.message}`);
    console.log(`[fetch-mediamtx] done (${osName}, ${key})`);
}

module.exports = { assetFor, checkDigest, sha256File, MEDIAMTX_VERSION, PIN_PATH };

if (require.main === module) {
    main().catch((e) => {
        console.error(`[fetch-mediamtx] ${e.message}`);
        process.exit(1);
    });
}
