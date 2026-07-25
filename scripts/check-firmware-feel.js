#!/usr/bin/env node
// Cross-repo feel-drift check: the NON-HERMETIC half of the guard on
// shared/feelConstants.js. It reaches into a local w17-control-fw checkout, parses
// the REAL firmware headers, and proves the checked-in canonical snapshot
// (shared/canonical/firmware_feel.json) still matches them.
//
// WHY THIS EXISTS. shared/feelConstants.js claimed "A test guards these against
// drift", but test/replay.test.js only compared the JS constants against hardcoded
// literals (26/11/1.18) — it proved they had not drifted from THEMSELVES. It never
// read ErsSystem.hpp, and this is the one place a firmware feel change would
// silently desync the HUD's ERS bar from the car. Built like `proto:check`, the
// two-half pattern this repo already trusts:
//
//   HERMETIC   test/feelConstantsDrift.test.js — feelConstants.js vs the snapshot.
//              Runs in every CI, needs no sibling checkout.
//   THIS FILE  the snapshot vs the live firmware. Needs a w17-control-fw checkout,
//              so it is a local/handoff step, not a CI gate.
//
// This script NEVER writes to w17-control-fw. With --write it rewrites only this
// repo's snapshot.
//
// Usage:
//   node scripts/check-firmware-feel.js                 # verify snapshot == live firmware
//   node scripts/check-firmware-feel.js --write          # regenerate the snapshot
//   node scripts/check-firmware-feel.js --strict         # absent sibling is a FAILURE
//   node scripts/check-firmware-feel.js --sibling PATH   # point at the checkout
//   W17_CONTROL_FW_DIR=/path/to/w17-control-fw node scripts/check-firmware-feel.js
//   W17_FEEL_CHECK_STRICT=1 …                            # same as --strict
//
// EXIT CODES — deliberately matching w17-control-fw's tools/link2_copy_check.sh,
// the twin of this guard on the firmware side, because "drifted" and "couldn't
// check" are different failures and a caller must be able to tell them apart:
//   0  in sync (or written); or the sibling is absent in NON-strict mode (skipped)
//   1  DRIFT: the snapshot no longer matches the firmware headers
//   2  COULD NOT CHECK: sibling absent/unreadable in --strict mode, or a header /
//      member could not be parsed (a rename must never silently pass)
//   3  usage error
//
// NOTE these differ from scripts/check-canonical-proto.js (which uses 2=drift,
// 3=skip). That is deliberate and load-bearing: the prompt of record asks this
// guard to match the firmware-side script it pairs with, so anyone wiring both
// into one CI job reads one set of codes. Do not "harmonize" them silently.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
    FEEL_BINDINGS,
    SNAPSHOT_REL,
    extractFirmwareFeel,
    serializeSnapshot,
} = require('./firmwareFeelSnapshot.js');

const REPO_ROOT = path.join(__dirname, '..');
const SNAPSHOT_PATH = path.join(REPO_ROOT, SNAPSHOT_REL);

const EXIT_OK = 0;
const EXIT_DRIFT = 1;
const EXIT_CANNOT_CHECK = 2;
const EXIT_USAGE = 3;

function parseArgs(argv) {
    const opts = {
        write: false,
        strict: process.env.W17_FEEL_CHECK_STRICT === '1',
        sibling: process.env.W17_CONTROL_FW_DIR || '',
        quiet: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--write') opts.write = true;
        else if (a === '--strict') opts.strict = true;
        else if (a === '-q' || a === '--quiet') opts.quiet = true;
        else if (a === '--sibling') {
            i += 1;
            if (i >= argv.length) {
                console.error('error: --sibling needs a PATH');
                process.exit(EXIT_USAGE);
            }
            opts.sibling = argv[i];
        } else if (a === '-h' || a === '--help') {
            console.log('usage: node scripts/check-firmware-feel.js [--write] [--strict] [--sibling PATH] [-q]');
            console.log('exit: 0 in sync/skipped · 1 drifted · 2 could not check · 3 usage');
            process.exit(EXIT_OK);
        } else {
            console.error(`error: unknown argument '${a}' (try --help)`);
            process.exit(EXIT_USAGE);
        }
    }
    if (!opts.sibling) opts.sibling = path.join(REPO_ROOT, '..', 'w17-control-fw');
    return opts;
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    const say = (...m) => { if (!opts.quiet) console.log(...m); };

    // --- sibling presence ---------------------------------------------------
    if (!fs.existsSync(opts.sibling)) {
        // --write with no firmware to read from is meaningless: refuse rather than
        // stamp a snapshot from nothing.
        if (opts.write) {
            console.error(`[feel-drift] CANNOT CHECK: --write needs the firmware, none at ${opts.sibling}`);
            return EXIT_CANNOT_CHECK;
        }
        if (opts.strict) {
            console.error(`[feel-drift] CANNOT CHECK: no w17-control-fw checkout at ${opts.sibling}`);
            console.error('[feel-drift] --strict was given, so this is a failure. Check out w17-control-fw');
            console.error('[feel-drift] beside this repo, or pass --sibling PATH / set W17_CONTROL_FW_DIR.');
            return EXIT_CANNOT_CHECK;
        }
        say(`[feel-drift] SKIPPED: no w17-control-fw checkout at ${opts.sibling}`);
        say('[feel-drift]   (non-strict: nothing to compare, not a failure. Use --strict where the');
        say('[feel-drift]    sibling must always be present, so an absent one cannot silently pass.)');
        say('[feel-drift]   The hermetic half (test/feelConstantsDrift.test.js) still guards this repo.');
        return EXIT_OK;
    }

    // --- read the live firmware --------------------------------------------
    let live;
    try {
        live = extractFirmwareFeel(opts.sibling);
    } catch (err) {
        // A renamed/removed member or a moved header lands here. That is
        // COULD-NOT-CHECK, not "in sync": the guard has lost its grip and must say so.
        console.error(`[feel-drift] CANNOT CHECK: ${err.message}`);
        return EXIT_CANNOT_CHECK;
    }
    const liveJson = serializeSnapshot(live);

    if (opts.write) {
        fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
        fs.writeFileSync(SNAPSHOT_PATH, liveJson);
        say(`[feel-drift] WROTE ${SNAPSHOT_REL} from ${opts.sibling}`);
        say('[feel-drift]   Now re-run the hermetic half: it will fail until');
        say('[feel-drift]   shared/feelConstants.js is updated to the new values.');
        return EXIT_OK;
    }

    if (!fs.existsSync(SNAPSHOT_PATH)) {
        console.error(`[feel-drift] CANNOT CHECK: no snapshot at ${SNAPSHOT_REL}`);
        console.error('[feel-drift] Generate it with: npm run feel:sync');
        return EXIT_CANNOT_CHECK;
    }
    const storedJson = fs.readFileSync(SNAPSHOT_PATH, 'utf8');

    if (storedJson === liveJson) {
        say('[feel-drift] OK: checked-in snapshot matches the live firmware headers');
        say(`[feel-drift]   firmware: ${opts.sibling}`);
        for (const b of FEEL_BINDINGS) {
            say(`[feel-drift]   ${b.member} = ${live.members[b.member]} -> ${b.js} = ${live.feel[b.js]}`);
        }
        return EXIT_OK;
    }

    // --- drift: name exactly what moved ------------------------------------
    console.error('[feel-drift] DRIFT: the firmware feel values no longer match the snapshot.');
    console.error(`[feel-drift]   firmware: ${opts.sibling}`);
    let stored;
    try {
        stored = JSON.parse(storedJson);
    } catch {
        console.error(`[feel-drift]   (snapshot ${SNAPSHOT_REL} is not valid JSON — regenerate it)`);
        return EXIT_DRIFT;
    }
    for (const b of FEEL_BINDINGS) {
        const was = stored.members ? stored.members[b.member] : undefined;
        const now = live.members[b.member];
        if (was !== now) {
            console.error(
                `[feel-drift]   ${b.header} ${b.member}: snapshot ${was} -> firmware ${now}` +
                `  (${b.js}: ${stored.feel ? stored.feel[b.js] : undefined} -> ${live.feel[b.js]})`,
            );
        }
    }
    console.error('[feel-drift] Decide deliberately:');
    console.error('[feel-drift]   - adopt the firmware change: npm run feel:sync, then update');
    console.error('[feel-drift]     shared/feelConstants.js until the hermetic test passes;');
    console.error('[feel-drift]   - or the firmware change was unintended: fix it there.');
    return EXIT_DRIFT;
}

process.exit(main());
