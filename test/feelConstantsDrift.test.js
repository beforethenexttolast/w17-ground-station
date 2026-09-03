// Feel-constant drift guard — the HERMETIC half (2026-07-25).
//
// WHY: shared/feelConstants.js said "A test guards these against drift", but the
// only test was test/replay.test.js asserting the JS constants against HARDCODED
// LITERALS (26/11/1.18). That proves they have not drifted from THEMSELVES — it
// never reads the firmware, so a firmware feel change would silently desync the
// HUD's ERS bar from the car. This is the live instance of the `crsf.js`
// overstatement pattern, and the ERS constants are the one place that desync is
// invisible: the bar just drains at the wrong rate.
//
// Built like proto:check, the two-half pattern this repo already trusts:
//   THIS FILE (hermetic)  shared/feelConstants.js vs the checked-in canonical
//                         snapshot shared/canonical/firmware_feel.json. Runs in
//                         every CI, needs no w17-control-fw checkout.
//   npm run feel:check    the snapshot vs the LIVE firmware headers in a local
//                         w17-control-fw checkout (scripts/check-firmware-feel.js).
// The snapshot is the single point of coupling. Neither half substitutes for the
// other: this one cannot see the firmware, and that one does not run in CI.
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const FEEL = require('../shared/feelConstants.js');
const {
    FEEL_BINDINGS,
    UNBOUND_FEEL_KEYS,
    SNAPSHOT_REL,
    parseMemberInitializer,
    feelFromMembers,
} = require('../scripts/firmwareFeelSnapshot.js');

const snapshot = JSON.parse(readFileSync(new URL('../shared/canonical/firmware_feel.json', import.meta.url), 'utf8'));

describe('feel constants vs the canonical firmware snapshot (hermetic)', () => {
    it('every firmware-derived constant equals the snapshot value', () => {
        // The actual guard. A firmware change reaches this test as a snapshot
        // refresh (npm run feel:sync), and this fails until feelConstants.js is
        // updated to match — which is the point: the desync becomes loud.
        for (const b of FEEL_BINDINGS) {
            expect(FEEL[b.js], `${b.js} (from ${b.header} ${b.member})`).toBeCloseTo(snapshot.feel[b.js], 9);
        }
    });

    it('the snapshot\'s JS values are the correct conversion of its raw firmware members', () => {
        // Guards the CONVERSION, not just the numbers: without this a wrong
        // per-mille -> percent mapping could be baked into the snapshot by
        // feel:sync and this file would happily agree with it.
        expect(feelFromMembers(snapshot.members)).toEqual(snapshot.feel);
        // And spot-check the unit contract in the open, so the intent is readable
        // without chasing the binding table: per-mille/1000 of the store per
        // second is percent/10; a +180 per-mille bonus is a x1.18 ceiling.
        expect(snapshot.members.deployRatePermille / 10).toBe(snapshot.feel.ERS_DEPLOY_PCT_PER_SEC);
        expect(snapshot.members.harvestBrakeRatePermille / 10).toBe(snapshot.feel.ERS_HARVEST_PCT_PER_SEC);
        expect(1 + snapshot.members.boostBonusPermille / 1000).toBeCloseTo(snapshot.feel.ERS_BOOST_MULTIPLIER, 9);
        expect(snapshot.members.numGears).toBe(snapshot.feel.GEARS);
    });

    it('EVERY feelConstants key is either bound to the firmware or explicitly unbound', () => {
        // The completeness rule that stops this guard rotting: a NEW constant added
        // to feelConstants.js fails here until someone decides whether it is a
        // firmware value (add a binding) or themed (add it to UNBOUND_FEEL_KEYS).
        // No third option, so nothing can arrive silently unguarded.
        const bound = FEEL_BINDINGS.map((b) => b.js);
        expect([...bound, ...UNBOUND_FEEL_KEYS].sort()).toEqual(Object.keys(FEEL).sort());
    });

    it('TOP_SPEED_KMH stays UNBOUND — it is themed, not a firmware value', () => {
        // Asserted positively so the exclusion is a recorded decision, not an
        // oversight someone later "fixes" by inventing a firmware source for it.
        expect(UNBOUND_FEEL_KEYS).toContain('TOP_SPEED_KMH');
        expect(FEEL_BINDINGS.map((b) => b.js)).not.toContain('TOP_SPEED_KMH');
        expect(typeof FEEL.TOP_SPEED_KMH).toBe('number');
    });

    it('the snapshot names the headers it came from, so a reader can go check', () => {
        expect(snapshot.source).toBe('w17-control-fw');
        expect(snapshot.headers).toContain('lib/ers/include/ers/ErsSystem.hpp');
        expect(snapshot.headers).toContain('lib/gearbox/include/gearbox/Gearbox.hpp');
        // Every binding's header is listed (the snapshot cannot under-report its
        // own coupling surface).
        for (const b of FEEL_BINDINGS) expect(snapshot.headers).toContain(b.header);
    });

    it('feelConstants.js points at the snapshot and BOTH halves, not a vague claim', () => {
        // The comment that started this: "A test guards these against drift" was
        // true of nothing. Require the file to name the actual mechanism, so the
        // claim cannot decay back into an unfalsifiable one.
        const src = readFileSync(new URL('../shared/feelConstants.js', import.meta.url), 'utf8');
        expect(src).toContain(SNAPSHOT_REL.split('\\').join('/')); // shared/canonical/firmware_feel.json
        expect(src).toContain('feel:check');
        expect(src).toContain('test/feelConstantsDrift.test.js');
        // …and the header path it cites must be the real one (the old comment said
        // lib/ers/ErsSystem.hpp, which has not existed for a while).
        expect(src).toContain('lib/ers/include/ers/ErsSystem.hpp');
    });
});

describe('the firmware-header parser is strict enough to be trusted', () => {
    // The parser is the load-bearing part of the non-hermetic half. If it silently
    // returned nothing on a rename, `feel:check` would report "in sync" forever.
    it('reads a normal member declaration', () => {
        expect(parseMemberInitializer('    uint16_t deployRatePermille = 260;\n', 'deployRatePermille', 'x')).toBe(260);
        expect(parseMemberInitializer('    uint8_t numGears = 4;\n', 'numGears', 'x')).toBe(4);
    });

    it('THROWS when the member is absent — a rename must never pass as "in sync"', () => {
        expect(() => parseMemberInitializer('struct S { int other = 1; };', 'deployRatePermille', 'ErsSystem.hpp'))
            .toThrow(/no integer member declaration/);
    });

    it('ignores comparisons and other non-declaration uses of the same name', () => {
        // ErsSystem.hpp's valid() compares deployRatePermille against bounds; those
        // lines must not be mistaken for the declaration.
        const src = [
            '    uint16_t deployRatePermille = 260;',
            '        return deployRatePermille >= 1 && deployRatePermille <= 1000 &&',
        ].join('\n');
        expect(parseMemberInitializer(src, 'deployRatePermille', 'x')).toBe(260);
    });

    it('THROWS on an ambiguous duplicate declaration rather than picking one', () => {
        const src = 'uint16_t deployRatePermille = 260;\nuint16_t deployRatePermille = 250;\n';
        expect(() => parseMemberInitializer(src, 'deployRatePermille', 'x')).toThrow(/ambiguous/);
    });

    it('reads the REAL headers when a w17-control-fw checkout is present (skipped otherwise)', async () => {
        // Opportunistic: this is the hermetic file, so it must pass with no sibling
        // repo. When the sibling IS there — a dev machine, a handoff bench — take
        // the free end-to-end proof that the parser still grips the real files.
        const { existsSync } = await import('node:fs');
        const { extractFirmwareFeel } = require('../scripts/firmwareFeelSnapshot.js');
        const fw = process.env.W17_CONTROL_FW_DIR
            || fileURLToPath(new URL('../../w17-control-fw', import.meta.url));
        if (!existsSync(fw)) return; // no sibling: the snapshot comparison above still guards
        expect(extractFirmwareFeel(fw)).toEqual({ members: snapshot.members, feel: snapshot.feel });
    });
});
