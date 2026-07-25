// Normalized telemetry the HUD consumes, independent of transport. The car
// delivers the CAR-SIDE TRUTHS the ground can't already know from the
// gamepad: real speed, battery, gear/mode/ERS, link quality. Everything else
// on the HUD (throttle/brake/steer/DRS/boost/overtake, and the simulated
// gear/rpm/ers fallback) comes from the gamepad + display model. CommonJS.
//
// A TelemetrySource emits these objects (partial is fine — the HUD overlays
// whatever fields are present and falls back to simulated for the rest).
//
// HONEST CONTRACT NOTE (audit R01): `armed`/`failsafe` are DEMO-ONLY fields —
// the real CRSF backchannel does not carry them (the firmware transmits only
// battery 0x08, GPS 0x02, FLIGHTMODE 0x21; LINK_STATISTICS 0x14 comes from the
// ground TX module). The HUD derives link loss from linkQualityPct + staleness
// (shared/linkState.mjs); only shared/replaySource.js sets these two fields.
// The car does carry both over `link2`, but only to board #2 — there is no
// ground-bound carrier, and the handset only ever sees `M%u` (a number).
//
// LABELLED IN THE UI (owner decision 2026-07-25): being demo-only was true here
// in the comments but invisible on screen. renderer/hud.js now says so — the
// #armChip reads "ARM / FAILSAFE · NOT REPORTED BY CAR" (or "· SIMULATED" under
// replay), and a `failsafe`-triggered alarm reads "LINK LOST · SIMULATED" so it
// cannot be mistaken for a real LQ==0 radio drop. Pinned by
// test/armFailsafeLabel.test.js. Adding A/F to the FLIGHTMODE string was
// REJECTED (15-char budget exactly full, R13 unproven, per-field fallback only
// tested on clean ASCII — a truncation could surface a WRONG armed state);
// revisit only after R13 is proven on hardware.

/**
 * @typedef {Object} Telemetry
 * @property {number} [speedKmh]
 * @property {number} [batteryV]
 * @property {number} [batteryPct]
 * @property {boolean} [armed]    demo-only — never set by the real source
 * @property {boolean} [failsafe] demo-only — never set by the real source
 * @property {number} [linkQualityPct]
 * @property {number} [rssiDbm]  uplink RSSI, negative dBm (from LINK_STATISTICS)
 * @property {number} [snrDb]    uplink SNR, dB (from LINK_STATISTICS)
 * @property {number} [gear]
 * @property {number} [ersPct]
 * @property {number} [driveMode]
 */

// Base class / interface. Implementations: ReplaySource (now, demo+test),
// WebSocketSource/UdpSource (future: car over the OpenIPC WiFi AP -- the clean
// path, no serial contention), CrsfSerialSource (fallback: only if
// elrs-joystick-control forwards telemetry off the shared FT232 port).
class TelemetrySource {
  constructor() {
    this._listeners = new Set();
  }
  onTelemetry(cb) {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }
  _emit(telemetry) {
    for (const cb of this._listeners) cb(telemetry);
  }
  start() {}
  stop() {}
}

module.exports = { TelemetrySource };
