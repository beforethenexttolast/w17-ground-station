#!/usr/bin/env node
// The ONE definition of which shared/feelConstants.js values come from the
// firmware, where each comes from, and how the units convert. Shared by both
// halves of the feel-drift guard so the two can never disagree about the mapping:
//
//   HERMETIC   test/feelConstantsDrift.test.js — compares shared/feelConstants.js
//              against the checked-in snapshot (shared/canonical/firmware_feel.json).
//              Runs in every CI, needs no w17-control-fw checkout.
//   NON-HERMETIC scripts/check-firmware-feel.js (`npm run feel:check`) — parses the
//              REAL firmware headers in a local w17-control-fw checkout and proves
//              the snapshot still matches them.
//
// The snapshot is the single point of coupling, exactly like
// proto/canonical/head_intent_canonical.descriptor.json for the mapper contract.
//
// CommonJS (feelConstants.js is CJS, and the script side is a plain node script).
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Every value in shared/feelConstants.js that CLAIMS to match the firmware, with
// the header + member declaration it must match and the unit conversion between
// them. The firmware works in per-mille; the HUD works in percent-per-second and a
// multiplier, so the conversion is part of the contract and is snapshotted too.
const FEEL_BINDINGS = Object.freeze([
    {
        js: 'ERS_DEPLOY_PCT_PER_SEC',
        header: 'lib/ers/include/ers/ErsSystem.hpp',
        member: 'deployRatePermille',
        note: 'per-mille of the full store per second -> percent per second',
        toJs: (v) => v / 10,
    },
    {
        js: 'ERS_HARVEST_PCT_PER_SEC',
        header: 'lib/ers/include/ers/ErsSystem.hpp',
        member: 'harvestBrakeRatePermille',
        note: 'brake-harvest per-mille per second -> percent per second',
        toJs: (v) => v / 10,
    },
    {
        js: 'ERS_BOOST_MULTIPLIER',
        header: 'lib/ers/include/ers/ErsSystem.hpp',
        member: 'boostBonusPermille',
        note: 'per-mille output bonus while deploying -> ceiling multiplier (1 + v/1000)',
        toJs: (v) => 1 + v / 1000,
    },
    {
        // Lives in a DIFFERENT header from the ERS values. Included because
        // feelConstants.js's own comment claims it "matches the firmware gearbox
        // numGears=4" (audit R05: one canonical gear count) — an unguarded claim is
        // exactly what this guard exists to eliminate, so every firmware-derived
        // constant is bound, not just the three ERS ones.
        js: 'GEARS',
        header: 'lib/gearbox/include/gearbox/Gearbox.hpp',
        member: 'numGears',
        note: 'canonical gear count (audit R05)',
        toJs: (v) => v,
    },
]);

// DELIBERATELY UNBOUND. TOP_SPEED_KMH is themed — there is no firmware value to
// match, and the constant's own comment says "set to real measured top speed
// later". Binding it would be a false claim of the kind this guard removes. Listed
// explicitly so the hermetic test can assert the bound + unbound sets together
// cover feelConstants.js exactly: a NEW constant is then a guard failure, not a
// silently unguarded value.
const UNBOUND_FEEL_KEYS = Object.freeze(['TOP_SPEED_KMH']);

const SNAPSHOT_REL = path.join('shared', 'canonical', 'firmware_feel.json');

// Parse ONE C++ member declaration-with-initializer, e.g.
//   uint16_t deployRatePermille = 260;
//   uint8_t numGears = 4;
// Requires an integer-type keyword on the same line so a comparison or a runtime
// assignment elsewhere in the header cannot be mistaken for the declaration, and
// requires EXACTLY ONE match: zero means the member was renamed/removed (the guard
// must not silently pass), more than one means the header grew an ambiguity the
// guard is no longer entitled to resolve on its own.
function parseMemberInitializer(src, member, where) {
    const re = new RegExp(
        String.raw`^[ \t]*(?:u?int(?:8|16|32|64)_t|unsigned\s+\w+|signed\s+\w+|int|short|long|size_t)` +
        String.raw`\s+${member}\s*=\s*(\d+)\s*;`,
        'gm',
    );
    const found = [...src.matchAll(re)];
    if (found.length === 0) {
        throw new Error(
            `${where}: no integer member declaration \`… ${member} = <number>;\` found. ` +
            'The member was renamed, moved, or changed type — resolve it deliberately ' +
            'rather than letting the drift guard skip it.',
        );
    }
    if (found.length > 1) {
        throw new Error(
            `${where}: ${found.length} declarations of \`${member}\` — ambiguous. ` +
            'Disambiguate the header or narrow this guard explicitly.',
        );
    }
    return Number(found[0][1]);
}

// Read the firmware values out of a w17-control-fw checkout at `fwRoot`.
// Throws (never returns partial data) if a header or a member is missing.
function extractFirmwareFeel(fwRoot) {
    const cache = new Map();
    const readHeader = (rel) => {
        if (!cache.has(rel)) {
            const abs = path.join(fwRoot, rel);
            if (!fs.existsSync(abs)) {
                throw new Error(`firmware header not found: ${abs}`);
            }
            cache.set(rel, fs.readFileSync(abs, 'utf8'));
        }
        return cache.get(rel);
    };

    const members = {};
    const feel = {};
    for (const b of FEEL_BINDINGS) {
        const raw = parseMemberInitializer(readHeader(b.header), b.member, b.header);
        members[b.member] = raw;
        feel[b.js] = b.toJs(raw);
    }
    return { members, feel };
}

// Recompute the JS-side values from a snapshot's raw firmware members. The
// hermetic test uses this so a WRONG conversion cannot hide inside the snapshot:
// snapshot.feel must be exactly what the bindings produce from snapshot.members.
function feelFromMembers(members) {
    const feel = {};
    for (const b of FEEL_BINDINGS) {
        if (!(b.member in members)) throw new Error(`snapshot is missing firmware member "${b.member}"`);
        feel[b.js] = b.toJs(members[b.member]);
    }
    return feel;
}

// Stable, diff-friendly serialization (keys in binding order, 4-space indent to
// match this repo's scripts/).
function serializeSnapshot({ members, feel }) {
    const ordered = {
        _comment: 'GENERATED — do not hand-edit. Canonical snapshot of the w17-control-fw '
            + 'feel values that shared/feelConstants.js must match. Refresh with '
            + '`npm run feel:sync` after `npm run feel:check` confirms (or deliberately '
            + 'adopts) a firmware change. See scripts/firmwareFeelSnapshot.js.',
        source: 'w17-control-fw',
        headers: [...new Set(FEEL_BINDINGS.map((b) => b.header))].sort(),
        members: {},
        feel: {},
    };
    for (const b of FEEL_BINDINGS) {
        ordered.members[b.member] = members[b.member];
        ordered.feel[b.js] = feel[b.js];
    }
    return `${JSON.stringify(ordered, null, 4)}\n`;
}

module.exports = {
    FEEL_BINDINGS,
    UNBOUND_FEEL_KEYS,
    SNAPSHOT_REL,
    parseMemberInitializer,
    extractFirmwareFeel,
    feelFromMembers,
    serializeSnapshot,
};
