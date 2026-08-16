// Race-day preparation settings (vision operator model: "one-action race day").
// ESM validator, renderer-loadable: the ⚙ RACE DAY fields and the GARAGE
// race-day card read the persisted subtree through this, so garbage on disk
// repairs to defaults instead of leaking into the UI or the orchestrator.
//
// The subtree is CONDITIONAL on disk (shared/settings.js admits it via the
// a04b07c conditional-spread pattern): an install that never touched race day
// keeps exactly the baseline settings keys, and every consumer falls back to
// DEFAULT_RACE_PREP through this normalizer. Like `lowBattery`, the subtree
// stays OUT of settingsStore's nested-merge list — callers that save it always
// write ALL fields (the saveWheel() rule), or a partial patch would silently
// reset the missing ones.
//
// Fields:
//  - mapperPath:  where the drive program (the mapper this app may START and
//                 STOP, but never talk to) lives. '' = not configured.
//  - profilePath: the saved controller profile the drive program loads at
//                 launch (the giftee never opens the mapper's own UI). '' =
//                 not configured; race day reports it honestly instead of
//                 launching an unconfigured mapper.
//  - autoBridge:  whether race day also switches on the phone telemetry link
//                 (W2, send-only) for an iPhone session. Default ON — the
//                 giftee-friendly choice; it only ever matters when the saved
//                 session mode is iphone-hud with a confirmed address.

export const DEFAULT_RACE_PREP = Object.freeze({
    mapperPath: '',
    profilePath: '',
    autoBridge: true,
});

const str = (v, fallback) => (typeof v === 'string' ? v : fallback);
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);

// Coerce a persisted (possibly partial, wrong-typed, or hostile) blob into a
// complete race-prep object. Never throws; field-by-field fallback so one
// corrupt entry never nukes the rest (the normalizeSettings contract).
export function normalizeRacePrepSettings(raw) {
    const r = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    return {
        mapperPath: str(r.mapperPath, DEFAULT_RACE_PREP.mapperPath),
        profilePath: str(r.profilePath, DEFAULT_RACE_PREP.profilePath),
        autoBridge: bool(r.autoBridge, DEFAULT_RACE_PREP.autoBridge),
    };
}
