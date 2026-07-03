// Normalized telemetry the HUD consumes, independent of transport. The car
// only needs to deliver the CAR-SIDE TRUTHS the ground can't already know
// from the gamepad: real speed, battery, arm/failsafe confirmation, link
// quality. Everything else on the HUD (throttle/brake/steer/DRS/boost/
// overtake, and the simulated gear/rpm/ers) comes from the gamepad + display
// model on the ground. CommonJS.
//
// A TelemetrySource emits these objects (partial is fine — the HUD overlays
// whatever fields are present and falls back to simulated for the rest).

/**
 * @typedef {Object} Telemetry
 * @property {number} [speedKmh]
 * @property {number} [batteryV]
 * @property {number} [batteryPct]
 * @property {boolean} [armed]
 * @property {boolean} [failsafe]
 * @property {number} [linkQualityPct]
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
