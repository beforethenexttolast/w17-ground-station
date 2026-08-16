// Video profiles (vision decision 7): the ONE shared definition of the two
// configurable presets through the camera -> mediamtx -> WebRTC/WHEP chain.
//   drive      — "RACING FEEL": lowest glass-to-glass latency; the profile the
//                car is DRIVEN on. Byte-for-byte today's tuning (the audit
//                finding "single fixed mediamtx path, WHEP pinned to min
//                latency" is exactly this profile) — pinned by
//                test/videoProfiles.test.js so DRIVE can never drift from the
//                proven pre-profile behavior.
//   showpiece  — "CINEMA LOOK": best/smoothest picture for spectators, paid
//                for with deliberate buffering latency. Every knob below is
//                justified inline; values marked BENCH-TBD (CB5) can only be
//                validated once the real camera exists on the bench — the
//                camera itself is NOT on the bench yet, so the camera's OWN
//                encoder knobs (bitrate / GOP / resolution) are deliberately
//                OUT of scope here (docs/video_profiles.md).
//
// ESM (renderer + vitest). main.js dynamic-imports this module the same way it
// loads shared/linkState.mjs; the CJS settings model (shared/settings.js)
// carries a LOCAL MIRROR of normalizeVideoSettings (the wheel/lowBattery
// construction) kept honest by the parity corpus in
// test/videoProfilePersist.test.js.
//
// Scope guard: these are VIEWER-side presets only. Nothing here touches
// control, CRSF, the gimbal, or any iPhone path — the profile changes how the
// already-published camera stream is relayed and rendered, never what the car
// does.

export const VIDEO_PROFILE_IDS = ['drive', 'showpiece'];
export const DEFAULT_VIDEO_PROFILE = 'drive';

export const DEFAULT_VIDEO_SETTINGS = Object.freeze({ profile: DEFAULT_VIDEO_PROFILE });

// Coerce a persisted (possibly partial, wrong-typed, or hostile) blob into a
// valid video-settings subtree. Never throws; unknown/garbage profile ids
// repair to DRIVE — the safe direction, because DRIVE is the proven tuning
// and the one the car is driven on.
export function normalizeVideoSettings(raw) {
    const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    return { profile: VIDEO_PROFILE_IDS.includes(r.profile) ? r.profile : DEFAULT_VIDEO_PROFILE };
}

// deepFreeze so a consumer can never quietly retune a profile at runtime —
// profile values change HERE, in review, or nowhere.
const freeze = (o) => {
    for (const v of Object.values(o)) if (v && typeof v === 'object') freeze(v);
    return Object.freeze(o);
};

export const VIDEO_PROFILES = freeze({
    drive: {
        id: 'drive',
        // Giftee wording (operator model: "user friendly af") — plain language,
        // no hobbyist jargon. Both switch surfaces (GARAGE chip + ⚙ row) render
        // THESE strings so the wording cannot fork.
        label: 'RACING FEEL',
        tagline: 'instant',
        blurb: 'the picture follows your hands with the least delay — best for driving',
        // mediamtx: NO overrides. The checked-in mediamtx/mediamtx.yml plus the
        // pinned v1.9.3 defaults ARE the current minimum-latency tuning; an
        // empty set here makes the supervisor spawn byte-identical to the
        // pre-profile app (proven by test/videoProfiles.test.js).
        mediamtxEnv: {},
        // Player: today's literals (renderer/whep.js defaults — the same test
        // pins the two against each other).
        //   playoutDelayHintS 0   — minimum playout delay: latency over smoothness.
        //   jitterBufferTargetMs  — null = NOT SET; the pre-profile client never
        //                           touched jitterBufferTarget, so DRIVE must not.
        //   retryMs 1500          — the proven reconnect pacing.
        player: { playoutDelayHintS: 0, jitterBufferTargetMs: null, retryMs: 1500 },
    },
    showpiece: {
        id: 'showpiece',
        label: 'CINEMA LOOK',
        tagline: 'smoother',
        blurb: 'the smoothest, cleanest picture for spectators — a moment behind your hands',
        // mediamtx overrides, applied as MTX_* environment variables to the
        // supervised process (mediamtx documents env-var precedence over the
        // config file; key names valid for the pinned v1.9.3):
        mediamtxEnv: {
            // Camera -> mediamtx RTSP ingest over TCP instead of the default
            // automatic/UDP: interleaved TCP cannot lose RTP packets on the
            // 5.8 GHz link, which is what smears/blocks the picture mid-GOP —
            // the single biggest IMAGE-QUALITY lever on the GS side. Cost: TCP
            // retransmit head-of-line blocking adds jitter/latency under loss,
            // which SHOWPIECE deliberately accepts (the player buffer below
            // absorbs it). BENCH-TBD (CB5): confirm the OpenIPC camera serves
            // RTSP interleaved-TCP alongside its other consumers.
            MTX_PATHS_CAM_RTSPTRANSPORT: 'tcp',
            // Outbound write queue 512 (v1.9.3 default) -> 1024 packets: room
            // for the large I-frame bursts a quality-tuned encoder emits, so
            // mediamtx queues instead of dropping toward the WHEP viewer.
            // Must be a power of two (mediamtx validates); memory cost is
            // bounded and trivial on the ground station. BENCH-TBD (CB5):
            // right-size against the camera's real bitrate/GOP once it exists.
            MTX_WRITEQUEUESIZE: '1024',
        },
        player: {
            // 300 ms of deliberate playout buffer: enough to iron out WiFi
            // jitter bursts + the TCP-ingest retransmit spikes accepted above,
            // small enough that a spectator view still tracks the car
            // believably. Expressed BOTH ways because Chromium moved APIs:
            //   playoutDelayHintS   — legacy receiver hint (seconds), what the
            //                         pre-profile client already used for 0;
            //   jitterBufferTargetMs — the current standard property (ms).
            // BENCH-TBD (CB5): tune against the measured link-jitter
            // distribution with the real camera; 300 is the defensible
            // starting point, not a measured optimum.
            playoutDelayHintS: 0.3,
            jitterBufferTargetMs: 300,
            // Deliberately IDENTICAL to DRIVE: reconnect pacing affects outage
            // recovery, not picture quality, and 1500 ms is the proven value —
            // a knob carried per-profile so a bench pass CAN split them, with
            // no invented difference today.
            retryMs: 1500,
        },
    },
});

// Resolve an id (from settings, possibly stale/garbage) to a profile
// definition. Unknown ids fall back to DRIVE — same safe direction as
// normalizeVideoSettings.
export function videoProfileFor(id) {
    return VIDEO_PROFILES[VIDEO_PROFILE_IDS.includes(id) ? id : DEFAULT_VIDEO_PROFILE];
}

// The honest restart note both switch surfaces show (decision 7 requires the
// UI to say when a switch cannot be seamless): a profile switch restarts
// mediamtx (new env) AND reconnects the WHEP player (new buffer targets).
export const VIDEO_PROFILE_RESTART_NOTE = 'switching restarts the video feed — the picture is back in a few seconds';
