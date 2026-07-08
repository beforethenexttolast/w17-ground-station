// Pure builder for the Windows -> iPhone telemetry snapshot packet.
//
// CANONICAL CONTRACT: docs/windows_bridge_contract.md (the Windows copy of the
// iPhone app's own bridge contract). The iPhone app is the client; this builder
// must emit exactly the packet shape its parser expects: snake_case fields,
// drive_mode as an enum STRING, and unknown/unavailable fields OMITTED (the
// iPhone parser tolerates partial packets and merges them; it must never be
// fed a fake value).
//
// Honesty rules (contract "Nullable And Unknown Values"):
//  - a field Windows has no real datum for is OMITTED, never faked as 0/null;
//  - stale car data is never re-sent as fresh: when the car-side source goes
//    stale the car fields are omitted and `stale_data_warnings` marks it;
//  - demo-only `armed`/`failsafe` are never read, so they can never leak;
//  - raw CRSF never crosses the bridge -- only these normalized fields.
//
// The throttle/brake/steering/camera fields are a READ-ONLY DISPLAY MIRROR of
// the operator's gamepad + camera state (contract "Existing control/mixer
// state"). They flow Windows -> iPhone only; nothing the iPhone sends can ever
// influence them (there is no reverse path -- see test/noControlPath.test.js).
//
// No I/O, no clock, no socket: golden-testable. CommonJS.

const PROTOCOL_VERSION = 1;

// driveMode number (firmware ChannelDecoder: 0=TRAINING 1=RACE/gearbox
// 2=ERS/gearbox+ERS) -> the iPhone contract's enum strings.
const DRIVE_MODE_ENUM = ['TRAINING', 'GEARBOX', 'GEARBOX_ERS'];

// Full camera-stick deflection (normalized 1.0) rendered as degrees for the
// mirror. The firmware maps full deflection to full MG90S throw (~90 deg each
// side); this is a DISPLAY convention, not a measured gimbal angle.
const CAMERA_FULL_DEFLECTION_DEG = 90;

// Windows' four-state link derivation -> the contract's optional diagnostic
// `link_state` enum. 'sim' maps to nothing (no telemetry source at all -- the
// car fields are simply absent).
const LINK_STATE_DIAG = {
    live: 'connected',
    'link-lost': 'degraded',
    'telemetry-lost': 'disconnected',
};

function isFiniteNum(x) {
    return typeof x === 'number' && Number.isFinite(x);
}

// Assign snake_case key only when the source value is a real finite number.
function putNum(out, key, value) {
    if (isFiniteNum(value)) out[key] = value;
}

// Build one snapshot packet.
//   tMs        timestamp_ms (sender clock, ms)
//   telem      merged car-side Telemetry (shared/telemetry.js) or null
//   linkState  'sim' | 'live' | 'link-lost' | 'telemetry-lost' (shared/linkState.mjs)
//   mirror     fresh read-only command mirror or null:
//              { throttle 0..1, brake 0..1, steering -1..1,
//                camPan -1..1, camTilt -1..1, videoPlaying bool }
//              (the caller nulls it when stale -- stale mirrors are omitted too)
//   mode       optional 'demo' | 'udp' diagnostic source tag
function buildTelemetrySnapshot({ tMs, telem, linkState, mirror, mode }) {
    const out = {
        protocol_version: PROTOCOL_VERSION,
        timestamp_ms: tMs,
    };

    // --- Car-side truth: only while the source is FRESH ('live' or
    // 'link-lost' -- LQ 0 is real data). 'telemetry-lost' means the source
    // went silent: omit everything car-side and flag it, per the contract
    // ("do not keep publishing old values as fresh"). 'sim' means no source
    // has ever produced data: nothing car-side to send at all.
    const telemFresh = linkState === 'live' || linkState === 'link-lost';
    if (telemFresh && telem) {
        putNum(out, 'battery_v', telem.batteryV);
        putNum(out, 'link_quality', telem.linkQualityPct);
        putNum(out, 'rssi_dbm', telem.rssiDbm);
        putNum(out, 'snr_db', telem.snrDb);
        putNum(out, 'speed_kmh', telem.speedKmh);
        putNum(out, 'gear', telem.gear);
        putNum(out, 'ers_percent', telem.ersPct);
        out.drive_mode = DRIVE_MODE_ENUM[telem.driveMode] ?? 'UNKNOWN';
    }
    if (linkState === 'telemetry-lost') {
        out.stale_data_warnings = ['telemetry'];
    }
    if (linkState === 'link-lost') {
        out.warning = 'LINK LOST';
    }
    const diag = LINK_STATE_DIAG[linkState];
    if (diag) out.link_state = diag;

    // --- Read-only command/camera mirror (display only; see header note).
    if (mirror) {
        putNum(out, 'throttle', mirror.throttle);
        putNum(out, 'brake', mirror.brake);
        putNum(out, 'steering', mirror.steering);
        if (isFiniteNum(mirror.camPan)) {
            out.camera_yaw_deg = mirror.camPan * CAMERA_FULL_DEFLECTION_DEG;
        }
        if (isFiniteNum(mirror.camTilt)) {
            // Stick up (negative axis) = camera up = positive pitch.
            out.camera_pitch_deg = -mirror.camTilt * CAMERA_FULL_DEFLECTION_DEG;
        }
        // The camera is aimed by the DualShock right stick in this phase; head
        // tracking does not exist on Windows yet.
        out.head_tracking_mode = 'DS4';
        if (typeof mirror.videoPlaying === 'boolean') {
            out.video_lock = mirror.videoPlaying;
        }
    }

    if (mode === 'demo' || mode === 'udp') out.mode = mode;

    return out;
}

module.exports = {
    buildTelemetrySnapshot,
    PROTOCOL_VERSION,
    DRIVE_MODE_ENUM,
    CAMERA_FULL_DEFLECTION_DEG,
};
