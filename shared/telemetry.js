// Normalized telemetry the HUD consumes, independent of transport. The car
// only needs to deliver the CAR-SIDE TRUTHS the ground can't already know
// from the gamepad: real speed, battery, arm/failsafe confirmation, link
// quality. Everything else on the HUD (throttle/brake/steer/DRS/boost/
// overtake, and the simulated gear/rpm/ers) comes from the gamepad + display
// model on the ground.
//
// A TelemetrySource emits these objects (partial is fine — the HUD overlays
// whatever fields are present and falls back to simulated for the rest).

/**
 * @typedef {Object} Telemetry
 * @property {number} [speedKmh]        real ground speed from the Hall sensor
 * @property {number} [batteryV]        pack voltage
 * @property {number} [batteryPct]      remaining %
 * @property {boolean} [armed]          arm-gate confirmation from the car
 * @property {boolean} [failsafe]       car-side failsafe active
 * @property {number} [linkQualityPct]  ELRS uplink LQ (0..100)
 * @property {number} [gear]            1-based, if the car reports it
 * @property {number} [ersPct]          ERS store, if the car reports it
 */

// Base class / interface. Implementations: ReplaySource (now, demo+test),
// WebSocketSource (future: car publishes JSON over the OpenIPC WiFi AP -- the
// clean path, no serial contention), CrsfSerialSource (fallback: only if
// elrs-joystick-control forwards telemetry off the shared FT232 port).
export class TelemetrySource {
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
