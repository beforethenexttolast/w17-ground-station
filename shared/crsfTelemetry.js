// Maps decoded CRSF telemetry frames -> partial normalized Telemetry for the
// HUD. Battery (0x08) comes from the car; LinkStatistics (0x14) is reported by
// the ground TX module itself. Everything else on the HUD (speed/gear/ers)
// stays gamepad-simulated -- a partial Telemetry is the designed-for case.
// CommonJS; pure (no serialport). Reuses the shared CRSF decoders.

const {
  FRAME_TYPE_BATTERY,
  FRAME_TYPE_LINK_STATISTICS,
  FRAME_TYPE_GPS,
  FRAME_TYPE_FLIGHT_MODE,
  decodeBattery,
  decodeLinkStatistics,
  decodeGps,
  decodeFlightMode,
  parseFlightMode,
} = require('./crsf.js');

// Given a decoded frame ({type, payload} from the assembler), return the
// partial Telemetry fields it carries, or null if it's a type we don't map.
// The car sends four telemetry types: battery (0x08), GPS-groundspeed as real
// speed (0x02), and a FLIGHTMODE status string (0x21) carrying car-authoritative
// gear/drive-mode/ERS; LinkStatistics (0x14) is reported by the ground TX itself.
function frameToTelemetry(frame) {
  if (!frame) return null;
  if (frame.type === FRAME_TYPE_BATTERY) {
    const b = decodeBattery(frame.payload);
    return { batteryV: b.voltageV, batteryPct: b.remainingPct };
  }
  if (frame.type === FRAME_TYPE_LINK_STATISTICS) {
    const s = decodeLinkStatistics(frame.payload);
    return { linkQualityPct: s.uplinkLinkQuality };
  }
  if (frame.type === FRAME_TYPE_GPS) {
    const g = decodeGps(frame.payload);
    return { speedKmh: g.speedKmh };
  }
  if (frame.type === FRAME_TYPE_FLIGHT_MODE) {
    const f = parseFlightMode(decodeFlightMode(frame.payload));
    return Object.keys(f).length ? f : null; // {gear, driveMode, ersPct}
  }
  return null; // unmapped telemetry type -> HUD keeps simulating
}

module.exports = { frameToTelemetry };
