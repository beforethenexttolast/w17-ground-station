// Pure video-state model over the WHEP <video> media events plus the WHEP
// client's transport signals. ESM (renderer + vitest), no DOM, no IO — a
// deterministic reducer so GRID / HUD / the outbound W2 `video_lock` all read
// ONE authority.
//
// WHY (audit L3): the old model was a single `videoPlaying` boolean set true on
// the media 'playing' event and cleared ONLY on 'emptied'. A dying FPV stream
// does not fire 'emptied' — it fires 'waiting'/'stalled', or the WebRTC peer
// connection silently goes 'disconnected'/'failed' while the <video> freezes on
// its last frame. So VIDEO LOCK (and W2 `video_lock`) stayed confidently green
// between stream death and the WHEP reconnect. This model makes 'playing' the
// ONLY confident-green state and drops it on any stall, buffer, transport drop,
// or error — so a frozen/reconnecting stream can never report video_lock:true.
//
// The reducer is order-based and idempotent (a repeat of the current event
// returns the SAME object, so consumers can cheaply skip re-render). Media
// events arrive in order from a single <video> element; the WHEP client guards
// its transport callbacks by peer-connection identity (renderer/whep.js), so a
// stale callback from an earlier reconnect attempt can never fire here — there
// is no cross-source reordering to defend against in a single renderer process.

// Phases, worst-to-best is not meaningful — these are distinct honest states.
export const VIDEO_PHASES = ['idle', 'connecting', 'live', 'buffering', 'stalled', 'error'];

export function initialVideoState() {
    return { phase: 'idle' };
}

// Reduce one event into the next state.
//   event: a string, or { type } — either
//     media (from the <video> element): 'playing' | 'waiting' | 'stalled'
//       | 'emptied' | 'ended' | 'error'
//     transport (from the WHEP client): 'connecting' | 'dropped' | 'stopped'
// Unknown events are ignored (returns the same state — idempotent).
export function reduceVideoState(state, event) {
    const type = typeof event === 'string' ? event : event && event.type;
    const phase = (state && state.phase) || 'idle';
    switch (type) {
        case 'playing':
            // Frames are actually flowing — the ONLY confident-green state. It
            // is ground truth and overrides any prior "stalled"/"buffering".
            return phase === 'live' ? state : { phase: 'live' };
        case 'connecting':
            // A (re)connect attempt is underway: not confidently live until
            // frames arrive. Never override real frames (a spurious connecting
            // while genuinely playing keeps 'live').
            return phase === 'live' || phase === 'connecting' ? state : { phase: 'connecting' };
        case 'waiting':
            // Buffering: frames delayed but the transport is still up. A dropped
            // transport ('stalled') or a hard 'error' is the stronger truth —
            // don't let a late 'waiting' upgrade it toward almost-live.
            if (phase === 'stalled' || phase === 'error' || phase === 'idle') return state;
            return phase === 'buffering' ? state : { phase: 'buffering' };
        case 'stalled':
        case 'dropped':
            // Media stalled or the WebRTC connection dropped: reconnect pending,
            // never green. (From 'idle' there is no stream to stall.)
            return phase === 'idle' || phase === 'stalled' ? state : { phase: 'stalled' };
        case 'error':
            // Hard error — distinct from the recoverable buffering/stalled path.
            return phase === 'error' ? state : { phase: 'error' };
        case 'emptied':
        case 'ended':
        case 'stopped':
            // The stream was torn down / never (re)established: inactive.
            return phase === 'idle' ? state : { phase: 'idle' };
        default:
            return state;
    }
}

// The single view mapping GRID / HUD / W2 all read.
//   live         — confident-green; the ONLY state that reports video_lock:true
//   label        — compact operator wording for the HUD overlay
//   tone         — feed-note color class suffix (v-<tone>)
//   reconnecting — a temporary/recoverable state (vs a hard error / inactive)
const VIEW = {
    idle: { live: false, label: 'NO VIDEO', tone: 'idle', reconnecting: false },
    connecting: { live: false, label: 'CONNECTING', tone: 'wait', reconnecting: true },
    live: { live: true, label: 'VIDEO LIVE', tone: 'live', reconnecting: false },
    buffering: { live: false, label: 'BUFFERING', tone: 'wait', reconnecting: true },
    stalled: { live: false, label: 'STREAM STALLED', tone: 'warn', reconnecting: true },
    error: { live: false, label: 'VIDEO ERROR', tone: 'error', reconnecting: false },
};

export function videoStatus(state) {
    const phase = (state && state.phase) || 'idle';
    const v = VIEW[phase] || VIEW.idle;
    return { phase, ...v };
}

// Convenience for the W2 `video_lock` field + GRID VIDEO LOCK check: true ONLY
// while frames are confidently flowing.
export function videoLock(state) {
    return videoStatus(state).live;
}
