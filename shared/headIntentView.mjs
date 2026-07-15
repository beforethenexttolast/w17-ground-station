// Pure render model for the mapper's read-only head-intent diagnostics chip
// (CB8 slice 3B). Renderer-safe (no Node, no Electron); unit-tested standalone.
//
// DISPLAY-ONLY: this maps the snapshot the MAIN process pushes — the mapper's
// authoritative fields plus a transport connection label — into chip text/tone.
// It does NOT recompute freshness, does NOT reinterpret receive_age_ms, and does
// NOT implement a head-intent state machine. Every value shown comes straight
// from the mapper; the chip always carries the NO CONTROL wording so a snapshot
// can never be mistaken for an active-control display (there is no such state).

// Mapper enum name -> { short display label, tone }. Mirrors the proto's
// HeadIntentState; ACTIVE_LOG_ONLY is the "fully fresh" state that STILL
// produces no output. Tones map to the HUD's v-* note classes (idle/wait/warn/
// error/live), reused here for a consistent look.
export const HEAD_INTENT_STATE_LABELS = Object.freeze({
    HEAD_INTENT_STATE_UNSPECIFIED: { label: 'UNSPECIFIED', tone: 'idle' },
    HEAD_INTENT_STATE_DISABLED: { label: 'DISABLED', tone: 'idle' },
    HEAD_INTENT_STATE_FAULT: { label: 'FAULT', tone: 'error' },
    HEAD_INTENT_STATE_IDLE: { label: 'IDLE', tone: 'wait' },
    HEAD_INTENT_STATE_INVALID: { label: 'INVALID', tone: 'warn' },
    HEAD_INTENT_STATE_STALE: { label: 'STALE', tone: 'warn' },
    HEAD_INTENT_STATE_INACTIVE: { label: 'INACTIVE', tone: 'idle' },
    HEAD_INTENT_STATE_NOT_CENTERED: { label: 'NOT CENTERED', tone: 'wait' },
    HEAD_INTENT_STATE_ACTIVE_LOG_ONLY: { label: 'ACTIVE · LOG-ONLY', tone: 'live' },
});

// Transport connection label -> { display label, tone }. Describes the gRPC link
// to the mapper (not the head-intent state, which rides in `diagnostics`).
const CONN_LABELS = Object.freeze({
    connecting: { label: 'CONNECTING', tone: 'wait' },
    live: { label: 'LIVE', tone: 'live' },
    unavailable: { label: 'MAPPER OFFLINE / INGEST OFF', tone: 'idle' },
    exhausted: { label: 'STREAM BUSY · CAP 4', tone: 'warn' },
    'stream-error': { label: 'RECONNECTING', tone: 'warn' },
    stopped: { label: 'OFF', tone: 'idle' },
});

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const deg = (v) => { const n = num(v); return n === null ? '--' : n.toFixed(1); };

// Build the secondary detail line from the mapper's last-valid fields. Values are
// passed through verbatim (receive_age_ms is the mapper's server-computed value).
function detailFrom(d) {
    if (!d || !d.has_last_valid) return '';
    const age = num(d.receive_age_ms);
    const rate = num(d.rate_per_sec);
    const parts = [
        `yaw ${deg(d.yaw_deg)}°`,
        `pitch ${deg(d.pitch_deg)}°`,
        `roll ${deg(d.roll_deg)}°`,
    ];
    const meta = [];
    if (age !== null) meta.push(`age ${age}ms`);
    if (rate !== null) meta.push(`${rate}/s`);
    if (num(d.last_valid_seq) !== null) meta.push(`seq ${d.last_valid_seq}`);
    return `${parts.join(' · ')}${meta.length ? ` · ${meta.join(' · ')}` : ''}`;
}

// Map a pushed snapshot { connection, diagnostics } into a render model.
// `diagnostics` is the raw mapper message (snake_case fields) or null.
export function headIntentView(snapshot) {
    const snap = snapshot || {};
    const connection = typeof snap.connection === 'string' ? snap.connection : 'stopped';
    const conn = CONN_LABELS[connection] || CONN_LABELS.stopped;
    const d = snap.diagnostics || null;

    // 'stopped' means the consumer is intentionally off: hide the chip.
    if (connection === 'stopped') {
        return { visible: false, chip: '', detail: '', tone: 'idle', connection, stateLabel: '', connLabel: conn.label, noControl: true };
    }

    // Live with a snapshot: show the mapper's head-intent STATE. Otherwise show
    // the transport connection state (connecting / offline / busy / reconnecting).
    let inner;
    let tone;
    let stateLabel = '';
    if (connection === 'live' && d) {
        const st = HEAD_INTENT_STATE_LABELS[d.state] || HEAD_INTENT_STATE_LABELS.HEAD_INTENT_STATE_UNSPECIFIED;
        stateLabel = st.label;
        inner = st.label;
        tone = st.tone;
    } else {
        inner = conn.label;
        tone = conn.tone;
    }

    return {
        visible: true,
        // NO CONTROL is always present: this display can never imply active control.
        chip: `HEAD-INTENT · ${inner} · NO CONTROL`,
        detail: connection === 'live' ? detailFrom(d) : '',
        tone,
        connection,
        stateLabel,
        connLabel: conn.label,
        noControl: true,
    };
}
