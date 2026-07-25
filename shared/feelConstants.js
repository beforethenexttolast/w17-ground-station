// The tuning NUMBERS shared with the firmware ErsConfig
// (w17-control-fw/lib/ers/include/ers/ErsSystem.hpp) and GearboxConfig
// (lib/gearbox/include/gearbox/Gearbox.hpp). NOT the algorithm — the firmware's
// ERS is an energy integrator that drives an ESC, while the HUD's model is a
// display-only speed/energy animation. Only the constants are meant to match,
// so the on-screen ERS bar drains/fills at the same rate the car does.
//
// HOW THE DRIFT GUARD ACTUALLY WORKS (2026-07-25). This comment used to say only
// "A test guards these against drift", which was an overstatement: the test
// compared these values against hardcoded literals and never read the firmware, so
// it proved they had not drifted from THEMSELVES. Replaced by the two-half
// proto:check pattern, with `shared/canonical/firmware_feel.json` — a checked-in
// snapshot of the firmware values — as the single point of coupling:
//
//   HERMETIC, runs in every CI:  test/feelConstantsDrift.test.js
//       these constants vs the snapshot, plus the per-mille -> percent conversion
//       and a completeness rule (every key below is bound to a firmware member or
//       explicitly listed as unbound — a new constant cannot arrive unguarded).
//   NON-HERMETIC, needs a sibling checkout:  `npm run feel:check`
//       the snapshot vs the LIVE headers (scripts/check-firmware-feel.js). Exit
//       1 = drifted, 2 = could-not-check, matching w17-control-fw's own
//       tools/link2_copy_check.sh, so `--strict` makes an absent sibling fail
//       instead of silently passing. Adopt a firmware change with
//       `npm run feel:sync`, then update the numbers here until the hermetic test
//       goes green.
//
// The mapping (which value comes from which header member, and its unit
// conversion) lives in scripts/firmwareFeelSnapshot.js. CommonJS.
module.exports = {
  ERS_DEPLOY_PCT_PER_SEC: 26, // ErsConfig deployRatePermille 260
  ERS_HARVEST_PCT_PER_SEC: 11, // harvestBrakeRatePermille 110
  ERS_BOOST_MULTIPLIER: 1.18, // boostBonusPermille 180 -> 1 + 180/1000
  GEARS: 4, // matches the firmware gearbox numGears=4 (audit R05: one canonical gear count)
  TOP_SPEED_KMH: 320, // themed, NOT a firmware value — deliberately unguarded
                      // (UNBOUND_FEEL_KEYS); set to real measured top speed later
};
