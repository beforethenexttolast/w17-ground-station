// Telemetry link-state model for the HUD (audit R01, option A: link loss is
// DERIVED on the ground from link quality + staleness -- the car does not
// transmit an armed/failsafe field over the CRSF backchannel).
//
// Four states:
//   'sim'            -- no telemetry source has EVER produced data; the HUD is
//                       an honest gamepad-driven simulation ("Telemetry: sim").
//   'live'           -- fresh telemetry, link healthy.
//   'link-lost'      -- fresh telemetry but uplink LQ == 0: the ground TX
//                       module still feeds us LINK_STATISTICS, and it says the
//                       radio link to the car is gone. (`failsafe` is kept as
//                       an OR-trigger for the demo/replay source only -- the
//                       real path never sets it.)
//   'telemetry-lost' -- the source WAS live and then went silent (serial
//                       unplugged, forwarder died, ...). Deliberately sticky:
//                       once a source has ever been live the HUD must never
//                       silently fall back to simulated values.
//
// Pure and clock-injected so it unit-tests without a DOM or timers. ESM (.mjs)
// because its consumers are the renderer (an ES module) and vitest; the
// Electron main process does not use it.

// Matches the HUD's previous 1 s freshness window.
export const TELEMETRY_FRESH_MS = 1000;

export function linkState({ nowMs, lastTelemetryMs, everLive, linkQualityPct, failsafe }) {
  if (!everLive) return 'sim';
  if (nowMs - lastTelemetryMs >= TELEMETRY_FRESH_MS) return 'telemetry-lost';
  if (failsafe || linkQualityPct === 0) return 'link-lost';
  return 'live';
}
