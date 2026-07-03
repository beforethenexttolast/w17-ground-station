// Maps decoded CRSF telemetry frames -> partial normalized Telemetry for the
// HUD. Battery (0x08) comes from the car; LinkStatistics (0x14) is reported by
// the ground TX module itself. Everything else on the HUD (speed/gear/ers)
// stays gamepad-simulated -- a partial Telemetry is the designed-for case.
// CommonJS; pure (no serialport). Reuses the shared CRSF decoders.

const {
  FRAME_TYPE_BATTERY,
  FRAME_TYPE_LINK_STATISTICS,
  decodeBattery,
  decodeLinkStatistics,
} = require('./crsf.js');

// Given a decoded frame ({type, payload} from the assembler), return the
// partial Telemetry fields it carries, or null if it's a type we don't map.
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
  return null; // unmapped telemetry type -> HUD keeps simulating
}

module.exports = { frameToTelemetry };
