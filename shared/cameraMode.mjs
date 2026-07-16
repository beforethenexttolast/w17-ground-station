// Pure render model for the SEAT FIT "CAMERA MODE" section. Renderer-safe (no
// Node, no Electron); unit-tested standalone. DISPLAY-ONLY.
//
// The section keeps two ideas STRICTLY apart (task §4 / §1A):
//   AVAILABLE / REQUESTED MODE — what the operator asks THIS setup UI to show. It
//                                is the current setup DEFAULT, never proof of a
//                                live fact.
//   ACTIVE AUTHORITY           — who actually aims the camera right now. This app
//                                is a viewer; it does NOT observe the mapper's
//                                selection, so it CANNOT know this. It is shown
//                                only if a trusted mapper-diagnostics source
//                                reports it; otherwise it reads
//                                "NOT REPORTED BY MAPPER".
//
// This app is a viewer, never the mixer. The mapper (elrs-joystick-control) is the
// control authority; the right stick pans/tilts THROUGH the mapper. Crucially:
//   - the browser observing a right stick does NOT prove the mapper selected it;
//   - W3 head-tracking traffic is diagnostic log-only and never proves authority.
// So this model NEVER fabricates an active authority out of anything the viewer
// can see. It reports active authority only from an explicit trusted source.
//
// Head tracking is VISIBLE but LOCKED: active iPhone-derived pan/tilt has not
// passed its safety milestone (parent CLAUDE.md safety boundaries; W3 stays
// log-only). This model therefore exposes NO way to arm anything and NO outbound
// command — selecting a mode changes only what this pure object says is
// "requested", and only MANUAL is ever selectable. The renderer that consumes it
// must not, and structurally cannot, turn a click into a mapper request: there is
// no mode-request RPC in the preload surface (pinned by test/ipcSurface.test.js),
// and none is added by this slice.

export const DEFAULT_CAMERA_MODE = 'manual';

// The mode the setup UI offers as AVAILABLE / REQUESTED. It is the current setup
// DEFAULT — not verified active authority. The UI must present it as such.
export const AVAILABLE_MODE_LABEL = 'MANUAL · RIGHT STICK';

// Shown for ACTIVE AUTHORITY when no trusted mapper-diagnostics source reports it —
// the normal case for this viewer, which has no active-authority feed at all.
export const ACTIVE_AUTHORITY_UNREPORTED_LABEL = 'NOT REPORTED BY MAPPER';

// The two modes. `selectable` is the ONLY gate that lets a mode become the
// requested one; head tracking is permanently false in this slice.
export const CAMERA_MODES = Object.freeze([
    Object.freeze({
        key: 'manual',
        label: 'MANUAL · RIGHT STICK',
        selectable: true,
        // Per-card help is trimmed to what is UNIQUE to this card; the shared
        // mapper-authority / W3-log-only wording lives once in #camModeNote
        // (task Batch 2 §2).
        help: 'Right stick pans and tilts the camera through the mapper — the '
            + 'reviewed setup default.',
    }),
    Object.freeze({
        key: 'headtrack',
        label: 'HEAD TRACKING · IPHONE',
        selectable: false,
        lock: 'LOCKED · SAFETY GATE NOT COMPLETE',
        // Unique to this card: WHY it is locked. The W3-log-only fact is stated
        // once in #camModeNote, not repeated here (task Batch 2 §2).
        help: 'iPhone head tracking is not enabled — active head-driven pan/tilt '
            + 'has not passed its safety milestone.',
    }),
]);

const byKey = (key) => CAMERA_MODES.find((m) => m.key === key) || null;

// Resolve ACTIVE AUTHORITY strictly from a trusted external source. This viewer
// has no such feed, so callers normally pass nothing and it stays unreported. We
// NEVER infer active authority from the browser Gamepad API (a stick observed ≠
// the mapper having selected it) or from W3 (log-only). A future mapper-
// diagnostics source may pass { reported: true, key, label } to have it rendered;
// anything else is treated as "not reported".
function resolveActiveAuthority(src) {
    if (src && typeof src === 'object' && src.reported === true
        && typeof src.label === 'string' && src.label) {
        return { reported: true, key: typeof src.key === 'string' ? src.key : null, label: src.label };
    }
    return { reported: false, key: null, label: ACTIVE_AUTHORITY_UNREPORTED_LABEL };
}

// Build the render model from a REQUESTED key (and, optionally, a trusted active-
// authority report). An unknown or non-selectable request is coerced to the
// default (manual) — the UI can never land on a mode that has no safe control
// path. `activeAuthority` is independent of the request and, unless a real source
// reports it, is NOT REPORTED — never assumed.
export function cameraModeView({ requested = DEFAULT_CAMERA_MODE, activeAuthority = null } = {}) {
    const wanted = byKey(requested);
    const req = wanted && wanted.selectable ? wanted.key : DEFAULT_CAMERA_MODE;
    const active = resolveActiveAuthority(activeAuthority);
    return {
        requested: req,
        requestedLabel: byKey(req).label,
        // Explicit marker so the UI presents the requested value as the current
        // setup default, never as verified live authority (task §1A).
        requestedIsSetupDefault: true,
        // Who actually aims the camera. Unknown to this viewer unless a trusted
        // mapper-diagnostics source reports it — never inferred here.
        activeAuthorityReported: active.reported,
        activeAuthority: active.key,            // null when not reported
        activeAuthorityLabel: active.label,     // 'NOT REPORTED BY MAPPER' by default
        // Per-card view state for rendering.
        modes: CAMERA_MODES.map((m) => ({
            key: m.key,
            label: m.label,
            help: m.help,
            selectable: m.selectable,
            selected: m.key === req,
            locked: !m.selectable,
            lock: m.lock || '',
        })),
        // The invariant the UI (and its tests) rely on: this model never authorizes
        // a control emission. We deliberately do NOT expose a head-tracking "armed"
        // flag — the renderer cannot know the real arm state, and asserting one
        // would be exactly the fabricated live fact §1A bans. The locked card
        // already carries no arm path.
        canEmitControl: false,
    };
}
