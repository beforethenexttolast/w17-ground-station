// The tuning NUMBERS shared with the firmware ErsConfig
// (w17-control-fw/lib/ers/ErsSystem.hpp). NOT the algorithm — the firmware's
// ERS is an energy integrator that drives an ESC, while the HUD's model is a
// display-only speed/energy animation. Only the constants are meant to match,
// so the on-screen ERS bar drains/fills at the same rate the car does. A test
// guards these against drift.
export const ERS_DEPLOY_PCT_PER_SEC = 26; // ErsConfig deployRatePermille 260
export const ERS_HARVEST_PCT_PER_SEC = 11; // harvestBrakeRatePermille ~110
export const ERS_BOOST_MULTIPLIER = 1.18; // boostBonusPermille 180

// Display-only tuning for the HUD (not shared with firmware).
export const GEARS = 8; // display gears on the HUD dial
export const TOP_SPEED_KMH = 320; // themed; set to real measured top speed later
