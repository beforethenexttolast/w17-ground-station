// Maps the mapper's decoded Telemetry messages -> partial normalized Telemetry
// for the HUD (owner decision OD-4). The sibling of shared/crsfTelemetry.js:
// the SAME four car-side truths, off the mapper's read-only gRPC stream instead
// of a serial port the mapper already holds exclusively. Pure, no grpc, no IO —
// golden-testable, and the one place the unit reasoning below is written down.
//
// WHY THIS PATH EXISTS. The CRSF backchannel arrives on the FT232 port, and the
// drive program owns that port exclusively while it is driving the car, so the
// 'crsf-serial' source cannot be used at the same time as race day without a
// com0com-style splitter (a hobbyist install; docs/TELEMETRY.md). The mapper
// already decodes those frames for its own UI and publishes them on a read-only
// stream, so the gift build reads them from there. Nothing is sent to the
// mapper: this module is fed decoded messages and returns plain objects.
//
// UNITS — the two places the mapper's numbers are NOT already what the HUD
// wants. Both come from upstream elrs-joystick-control assuming a Betaflight
// flight controller; the W17 car is not one, and the firmware is the authority:
//
//  1. SPEED. w17-control-fw main.cpp:952 and its CRSF frame-builder header
//     (lib/crsf/include/crsf/, buildGpsFrame) encode the STANDARD CRSF
//     groundspeed unit, 0.1 km/h ("groundspeedKmhX10"). The mapper divides that
//     raw uint16 by 100 and documents the result as m/s
//     (w17-mapper/pkg/crossfire/telemetry/frame_gps.go:50-52). So the value on
//     the wire is km/h / 10, and the conversion back is x10 — NOT x3.6. The GS's
//     own serial reader divides the same raw field by 10 and calls it km/h
//     (shared/crsf.js decodeGps), which is the same number; a test pins the two
//     paths against one another so they can never disagree in silence.
//
//  2. SNR. The mapper reads the uplink SNR byte as UNSIGNED
//     (frame_linkstats.go:57-59, int32(uint8(...))), while CRSF carries it as a
//     signed int8 and the GS's serial reader treats it as signed
//     (shared/crsf.js decodeLinkStatistics). The mapper's conversion is lossless
//     — 0..255 with the sign bit intact — so the signed value is reconstructed
//     here rather than displaying -6 dB as 250 dB.
//
// RSSI needs no fix-up: CRSF carries the uplink RSSI as a positive magnitude and
// both sides negate it for display (75 -> -75 dBm), exactly as the serial path
// already does.

const { parseFlightMode } = require('./crsf.js');

// The mapper divides the raw CRSF groundspeed (0.1 km/h units) by 100, so the
// field is km/h / 10. See the UNITS note above.
const MAPPER_GROUND_SPEED_TO_KMH = 10;

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

// int8 from the mapper's unsigned read (see UNITS note 2). Values outside a byte
// are passed through unchanged — a future mapper that reports a real signed SNR
// must not be mangled by this.
function signedByte(value) {
    if (!isNum(value)) return null;
    if (value < 0 || value > 255 || !Number.isInteger(value)) return value;
    return value > 127 ? value - 256 : value;
}

// Given one decoded Telemetry message, return the partial Telemetry fields it
// carries, or null for a payload this viewer does not map (the designed-for
// case: the HUD keeps simulating what the car does not report).
//
// `msg` is proto-loader output with keepCase:true, so payload members are
// snake_case and the oneof selector is `msg.data`.
function mapperFrameToTelemetry(msg) {
    if (!msg || typeof msg !== 'object') return null;

    if (msg.battery) {
        const out = {};
        // Voltage is already volts on both sides (each divides the CRSF decivolt
        // field by 10). remaining is a percent byte.
        if (isNum(msg.battery.voltage)) out.batteryV = msg.battery.voltage;
        if (isNum(msg.battery.remaining)) out.batteryPct = msg.battery.remaining;
        return Object.keys(out).length ? out : null;
    }

    if (msg.gps) {
        if (!isNum(msg.gps.ground_speed)) return null;
        return { speedKmh: msg.gps.ground_speed * MAPPER_GROUND_SPEED_TO_KMH };
    }

    if (msg.flight_mode) {
        if (typeof msg.flight_mode.mode !== 'string') return null;
        // The car packs gear/drive-mode/ERS into the status string; the SAME
        // parser the serial path uses reads them back out, so the two sources
        // cannot disagree about what "G3 M2 E55" means.
        const f = parseFlightMode(msg.flight_mode.mode);
        return Object.keys(f).length ? f : null;
    }

    if (msg.link_stats) {
        const out = {};
        if (isNum(msg.link_stats.uplink_link_quality)) {
            out.linkQualityPct = msg.link_stats.uplink_link_quality;
        }
        if (isNum(msg.link_stats.uplink_rssi1)) out.rssiDbm = -msg.link_stats.uplink_rssi1;
        const snr = signedByte(msg.link_stats.uplink_snr);
        if (snr !== null) out.snrDb = snr;
        return Object.keys(out).length ? out : null;
    }

    return null;
}

// The mapper's LinkState -> the one boolean race day needs (review SYN-2): is
// this drive program actually TRANSMITTING? Both halves must hold — the link
// supervisor running AND the transmitter's serial port open. A started process
// with a closed port emits no CRSF frame at all, and "running" would be a lie.
//
// Enums arrive as their NAMES (enums:String), so an unknown/renamed value reads
// as not-up rather than as a coincidental number match.
function linkIsUp(state) {
    if (!state || typeof state !== 'object') return false;
    return state.supervisor_state === 'SupervisorActive'
        && state.port_state === 'PortConnected';
}

module.exports = {
    mapperFrameToTelemetry,
    linkIsUp,
    signedByte,
    MAPPER_GROUND_SPEED_TO_KMH,
};
