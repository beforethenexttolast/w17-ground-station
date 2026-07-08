// iPhone -> Windows head-tracking intent: pure validator + diagnostics monitor.
//
// LOG-ONLY BY DESIGN (docs/windows_bridge_contract.md section 3, first bridge
// milestone): packets are validated, counted, and summarized for logs -- and
// nothing else. No output of any kind is derived from them: no CRSF, no servo,
// no pan/tilt, no telemetry mutation, no IPC. The module exposes read-only
// diagnostics; test/noControlPath.test.js pins this structurally. Mapping
// intent to camera pan/tilt is a SEPARATE, later, safety-gated milestone.
//
// Validation mirrors the iPhone repo's reference implementation
// (iPhone_rc/scripts/reference_iphone_bridge.py) and
// schemas/head_tracking_packet.schema.json:
//   required: seq, timestamp_ms, yaw_deg, pitch_deg, roll_deg, tracking_enabled
//   optional: protocol_version (missing => version 1), centered, timeout_ms
//   ranges:   yaw +/-360, pitch/roll +/-180 (finite), timeout_ms 1..5000,
//             seq/timestamp_ms non-negative integers (booleans are NOT ints)
// `calibrated` is not in the schema; the app's Center/Calibrate action is
// carried by `centered`. We tolerate `calibrated` as an optional boolean
// diagnostic and gate on it conservatively (false => treated as not centered).
//
// Pure CommonJS: no sockets, no clock of its own (callers pass nowMs), fully
// unit-testable -- the repo's standard seam.

const PROTOCOL_VERSION = 1;

// Windows owns the configured receiver staleness (contract "Stale Timeout"):
// no valid packet for > ~300 ms => stale. The packet's own timeout_ms is a
// diagnostic hint only.
const DEFAULT_STALE_MS = 300;

// Reject absurd datagrams before JSON.parse (unauthenticated input; real
// packets are ~200 bytes).
const MAX_PACKET_BYTES = 2048;

function isInt(v) {
    // JSON booleans must not pass integer checks (reference parity).
    return typeof v === 'number' && Number.isInteger(v);
}

function isFiniteNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

// Validate one datagram (Buffer, string, or already-parsed object).
// Returns { ok: true, packet } with the normalized packet, or
// { ok: false, reason } with a machine-readable reason. Never throws.
function validateHeadTrackingPacket(raw) {
    let obj = raw;
    if (typeof raw === 'string' || Buffer.isBuffer(raw)) {
        if (Buffer.isBuffer(raw) && raw.length > MAX_PACKET_BYTES) {
            return { ok: false, reason: 'oversized' };
        }
        if (typeof raw === 'string' && raw.length > MAX_PACKET_BYTES) {
            return { ok: false, reason: 'oversized' };
        }
        try {
            obj = JSON.parse(raw.toString());
        } catch {
            return { ok: false, reason: 'malformed-json' };
        }
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
        return { ok: false, reason: 'not-object' };
    }

    // protocol_version: optional; missing/null means version 1 (bench phase).
    let version = PROTOCOL_VERSION;
    if (obj.protocol_version !== undefined && obj.protocol_version !== null) {
        if (!isInt(obj.protocol_version) || obj.protocol_version !== PROTOCOL_VERSION) {
            return { ok: false, reason: 'bad-version' };
        }
        version = obj.protocol_version;
    }

    if (!isInt(obj.seq) || obj.seq < 0) return { ok: false, reason: 'bad-seq' };
    if (!isInt(obj.timestamp_ms) || obj.timestamp_ms < 0) {
        return { ok: false, reason: 'bad-timestamp' };
    }

    for (const key of ['yaw_deg', 'pitch_deg', 'roll_deg']) {
        if (!isFiniteNum(obj[key])) return { ok: false, reason: 'bad-angles' };
    }
    if (Math.abs(obj.yaw_deg) > 360 || Math.abs(obj.pitch_deg) > 180 || Math.abs(obj.roll_deg) > 180) {
        return { ok: false, reason: 'out-of-range' };
    }

    if (typeof obj.tracking_enabled !== 'boolean') {
        return { ok: false, reason: 'bad-tracking-enabled' };
    }
    for (const key of ['centered', 'calibrated']) {
        if (obj[key] !== undefined && obj[key] !== null && typeof obj[key] !== 'boolean') {
            return { ok: false, reason: `bad-${key}` };
        }
    }

    let timeoutMs = null;
    if (obj.timeout_ms !== undefined && obj.timeout_ms !== null) {
        if (!isInt(obj.timeout_ms) || obj.timeout_ms < 1 || obj.timeout_ms > 5000) {
            return { ok: false, reason: 'bad-timeout' };
        }
        timeoutMs = obj.timeout_ms;
    }

    return {
        ok: true,
        packet: {
            protocol_version: version,
            seq: obj.seq,
            timestamp_ms: obj.timestamp_ms,
            yaw_deg: obj.yaw_deg,
            pitch_deg: obj.pitch_deg,
            roll_deg: obj.roll_deg,
            tracking_enabled: obj.tracking_enabled,
            centered: typeof obj.centered === 'boolean' ? obj.centered : null,
            calibrated: typeof obj.calibrated === 'boolean' ? obj.calibrated : null,
            timeout_ms: timeoutMs,
        },
    };
}

// Diagnostics state machine over validated packets. States per the contract's
// "Invalid, Disabled, And Uncentered Behavior" (the receiver wrapper adds
// 'disabled' and 'fault'; this monitor derives the packet-driven states):
//   idle            -- no valid packet has ever been received
//   invalid         -- only invalid packets have ever been received
//   stale           -- had a valid packet, silent > staleMs (receive-time authority)
//   inactive        -- fresh valid packet, tracking_enabled=false
//   not_centered    -- fresh valid, enabled, but centered!=true (or calibrated=false)
//   active_log_only -- fresh valid, enabled, centered (STILL produces no output)
// Invalid packets never replace the last valid state (contract "Malformed
// Packet Rejection") -- they only bump counters.
class HeadTrackingMonitor {
    constructor({ staleMs = DEFAULT_STALE_MS } = {}) {
        this._staleMs = staleMs;
        this._counts = { total: 0, valid: 0, invalid: 0 };
        this._invalidByReason = {};
        this._lastValid = null;      // normalized packet
        this._lastValidRxMs = null;  // receive wall-clock of the last valid packet
        this._seqGaps = 0;
        this._seqRegressions = 0;
        this._seqRepeats = 0;
        this._rxTimestamps = [];     // recent valid receive times for the ~1s rate estimate
    }

    // Feed one raw datagram. Returns { accepted, reason?, state }.
    ingest(raw, nowMs) {
        this._counts.total += 1;
        const result = validateHeadTrackingPacket(raw);
        if (!result.ok) {
            this._counts.invalid += 1;
            this._invalidByReason[result.reason] = (this._invalidByReason[result.reason] || 0) + 1;
            return { accepted: false, reason: result.reason, state: this.state(nowMs) };
        }

        // Sequence diagnostics (contract: regressions are diagnostics, not
        // proof of unsafe input -- the app restarting resets seq).
        if (this._lastValid !== null) {
            const prev = this._lastValid.seq;
            const seq = result.packet.seq;
            if (seq === prev) this._seqRepeats += 1;
            else if (seq < prev) this._seqRegressions += 1;
            else if (seq > prev + 1) this._seqGaps += 1;
        }

        this._counts.valid += 1;
        this._lastValid = result.packet;
        this._lastValidRxMs = nowMs;
        this._rxTimestamps.push(nowMs);
        // Keep only the last ~1s for the rate estimate.
        while (this._rxTimestamps.length && this._rxTimestamps[0] < nowMs - 1000) {
            this._rxTimestamps.shift();
        }
        return { accepted: true, state: this.state(nowMs) };
    }

    // Packet-derived diagnostic state at time nowMs.
    state(nowMs) {
        if (this._lastValid === null) {
            return this._counts.invalid > 0 ? 'invalid' : 'idle';
        }
        if (nowMs - this._lastValidRxMs > this._staleMs) return 'stale';
        if (this._lastValid.tracking_enabled !== true) return 'inactive';
        if (this._lastValid.centered !== true || this._lastValid.calibrated === false) {
            return 'not_centered';
        }
        return 'active_log_only';
    }

    // Read-only snapshot for logs/tests. This is the module's ONLY output.
    diagnostics(nowMs) {
        return {
            state: this.state(nowMs),
            counts: { ...this._counts },
            invalidByReason: { ...this._invalidByReason },
            lastValid: this._lastValid ? { ...this._lastValid } : null,
            packetAgeMs: this._lastValidRxMs === null ? null : nowMs - this._lastValidRxMs,
            // Sender-clock delta is diagnostic only; receive time is the stale
            // authority (no clock sync required between iPhone and Windows).
            senderClockDeltaMs:
                this._lastValid === null ? null : this._lastValidRxMs - this._lastValid.timestamp_ms,
            seqGaps: this._seqGaps,
            seqRegressions: this._seqRegressions,
            seqRepeats: this._seqRepeats,
            ratePerSec: this._rxTimestamps.filter((t) => t >= nowMs - 1000).length,
            staleMs: this._staleMs,
        };
    }
}

module.exports = {
    validateHeadTrackingPacket,
    HeadTrackingMonitor,
    PROTOCOL_VERSION,
    DEFAULT_STALE_MS,
    MAX_PACKET_BYTES,
};
