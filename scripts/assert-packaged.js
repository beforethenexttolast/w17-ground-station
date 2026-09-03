#!/usr/bin/env node
// Packaging assertion (review boundaries-1 + boundaries-6, owner ruling
// OD-15(a)). Runs after `electron-builder --dir` and FAILS the build when the
// packaged app is missing something the gift kit cannot work without:
//
//   1. resources/mediamtx/<mediamtx executable>  — without it there is no video
//      relay at all, which is exactly what shipped: CI never ran
//      scripts/fetch-mediamtx.js, .gitignore keeps the binary out of git, and
//      electron-builder.yml's extraResources copied an empty mediamtx/. CI was
//      green the whole time, which is why nobody noticed.
//   2. resources/mediamtx/mediamtx.yml — the checked-in config the supervisor
//      spawns mediamtx with (an absolute path into resources at runtime).
//   3. proto/head_intent_diagnostics.proto INSIDE the app bundle —
//      main/headIntentGrpcConnect.js:23 loads ../proto at RUNTIME, so a
//      packaged build without it throws the moment that consumer is used.
//
// The point of this script is that these are asserted by CI, not by prose: a
// silent packaging regression must be loud. It reads only the built output —
// nothing is spawned, nothing is executed.
//
// Usage:
//   node scripts/assert-packaged.js                  # auto-detect dist/<...>
//   node scripts/assert-packaged.js dist/win-unpacked
//
// Exit codes: 0 = every check passed; 1 = a check failed or no build was found.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
// electron-builder's --dir output directory per platform.
const CANDIDATE_DIRS = ['win-unpacked', 'linux-unpacked', 'mac', 'mac-arm64'];
// The runtime-loaded proto the gRPC consumer needs (boundaries-6).
const REQUIRED_APP_FILES = ['proto/head_intent_diagnostics.proto'];

// --- asar reading -----------------------------------------------------------
// Format (electron's asar, pickle-framed):
//   bytes  0..4   uint32  payload size of the "size" pickle (always 4)
//   bytes  4..8   uint32  headerSize
//   bytes  8..12  uint32  payload size of the header pickle
//   bytes 12..16  uint32  length of the header JSON string
//   bytes 16..    the header JSON (a directory tree), then the packed files
// Anything that does not parse is an ERROR, never a silent pass: a build whose
// contents cannot be read has not been proven to contain anything.
function parseAsarHeader(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 16) throw new Error('asar too short to contain a header');
    const headerSize = buf.readUInt32LE(4);
    if (!Number.isFinite(headerSize) || headerSize + 8 > buf.length) throw new Error('asar header size out of range');
    const strLen = buf.readUInt32LE(12);
    if (!Number.isFinite(strLen) || 16 + strLen > buf.length) throw new Error('asar header string out of range');
    const json = buf.toString('utf8', 16, 16 + strLen);
    const header = JSON.parse(json);
    if (!header || typeof header !== 'object' || !header.files) throw new Error('asar header has no file tree');
    return header;
}

// Does the archive contain this "/"-separated path as a FILE (not a directory)?
function asarHasFile(header, relPath) {
    let node = header;
    for (const seg of relPath.split('/')) {
        if (!node || !node.files || !Object.prototype.hasOwnProperty.call(node.files, seg)) return false;
        node = node.files[seg];
    }
    return !!node && !node.files; // a leaf, i.e. a file entry
}

// --- the checks -------------------------------------------------------------

function findBuildDir(explicit) {
    if (explicit) {
        const abs = path.isAbsolute(explicit) ? explicit : path.join(REPO_ROOT, explicit);
        return fs.existsSync(abs) ? abs : null;
    }
    for (const d of CANDIDATE_DIRS) {
        const abs = path.join(REPO_ROOT, 'dist', d);
        if (fs.existsSync(abs)) return abs;
    }
    return null;
}

// macOS puts resources inside the .app bundle; every other target puts it beside
// the executable.
function resourcesDirFor(buildDir) {
    const direct = path.join(buildDir, 'resources');
    if (fs.existsSync(direct)) return direct;
    const apps = fs.existsSync(buildDir)
        ? fs.readdirSync(buildDir).filter((f) => f.endsWith('.app'))
        : [];
    for (const app of apps) {
        const inside = path.join(buildDir, app, 'Contents', 'Resources');
        if (fs.existsSync(inside)) return inside;
    }
    return direct; // report the expected location in the failure message
}

// fsImpl defaults to the real fs so every call site works unchanged when no
// fake is injected; a test that injects {fsImpl} controls EVERY check below,
// not just the asar branch (review item 6 — before this, nonEmptyFile() closed
// over the module-level `fs` directly, so an injected fs silently had no
// effect on the mediamtx executable, mediamtx.yml, or the plain app/ checks).
function nonEmptyFile(p, fsImpl = fs) {
    try {
        const st = fsImpl.statSync(p);
        return st.isFile() && st.size > 0;
    } catch {
        return false;
    }
}

// Every failure as a human-readable string; [] means the package is good.
function checkResources(resourcesDir, { fsImpl = fs } = {}) {
    const failures = [];
    const notes = [];

    const mediamtxDir = path.join(resourcesDir, 'mediamtx');
    const exeNames = ['mediamtx.exe', 'mediamtx'];
    const found = exeNames.find((n) => nonEmptyFile(path.join(mediamtxDir, n), fsImpl));
    if (!found) {
        failures.push(
            `no mediamtx executable in ${mediamtxDir} — the packaged app has NO video relay. `
            + 'Run `node scripts/fetch-mediamtx.js` BEFORE electron-builder (the binary is gitignored, '
            + 'and extraResources copies whatever is in mediamtx/, including nothing).',
        );
    } else {
        notes.push(`mediamtx: ${found} (${fsImpl.statSync(path.join(mediamtxDir, found)).size} bytes)`);
    }

    const yml = path.join(mediamtxDir, 'mediamtx.yml');
    if (!nonEmptyFile(yml, fsImpl)) failures.push(`no mediamtx.yml in ${mediamtxDir} — the supervisor spawns mediamtx with this config by absolute path`);
    else notes.push('mediamtx.yml: present');

    // The app bundle: asar (the default) or an unpacked app/ directory.
    const asar = path.join(resourcesDir, 'app.asar');
    const plain = path.join(resourcesDir, 'app');
    if (fsImpl.existsSync(asar)) {
        let header;
        try {
            header = parseAsarHeader(fsImpl.readFileSync(asar));
        } catch (err) {
            failures.push(`could not read ${asar} (${err.message}) — the package contents are unproven`);
            return { failures, notes };
        }
        for (const rel of REQUIRED_APP_FILES) {
            if (!asarHasFile(header, rel)) {
                failures.push(
                    `${rel} is not inside app.asar — add proto/** to electron-builder.yml's files: list `
                    + '(main/headIntentGrpcConnect.js loads ../proto at runtime and throws without it)',
                );
            } else notes.push(`app.asar: ${rel}`);
        }
    } else if (fsImpl.existsSync(plain)) {
        for (const rel of REQUIRED_APP_FILES) {
            if (!nonEmptyFile(path.join(plain, ...rel.split('/')), fsImpl)) failures.push(`${rel} missing from ${plain}`);
            else notes.push(`app/: ${rel}`);
        }
    } else {
        failures.push(`neither app.asar nor app/ in ${resourcesDir} — this does not look like an electron-builder output`);
    }

    return { failures, notes };
}

function main() {
    const explicit = process.argv.slice(2).find((a) => !a.startsWith('-'));
    const buildDir = findBuildDir(explicit);
    if (!buildDir) {
        console.error('[assert-packaged] no build found under dist/ '
            + `(looked for ${CANDIDATE_DIRS.join(', ')}) — run electron-builder --dir first`);
        process.exit(1);
    }
    const resourcesDir = resourcesDirFor(buildDir);
    console.log(`[assert-packaged] inspecting ${resourcesDir}`);
    const { failures, notes } = checkResources(resourcesDir);
    for (const n of notes) console.log(`[assert-packaged] ok   ${n}`);
    if (failures.length) {
        for (const f of failures) console.error(`[assert-packaged] FAIL ${f}`);
        process.exit(1);
    }
    console.log('[assert-packaged] the packaged app carries the video relay and the runtime proto');
}

module.exports = { parseAsarHeader, asarHasFile, checkResources, resourcesDirFor, REQUIRED_APP_FILES, CANDIDATE_DIRS };

if (require.main === module) main();
