// Pure mapping of the env-lockable ⚙ settings to their locking environment
// variable + accessible wording. ESM (renderer + vitest), no IO.
//
// WHY (audit C3/D3/Q8): an env var that is SET wins for its subsystem
// (shared/settings.js `resolveEffective`), so the persisted value is ignored.
// The ⚙ menu used to show the persisted value and stay editable — a silent
// loser to env. Instead each locked control shows the EFFECTIVE value, is
// disabled/readonly, and carries an amber ENV badge whose tooltip names the
// exact variable and states that environment configuration takes precedence.
//
// SECRETS: none of these variables carry a credential (a source name, a port,
// an on/off flag), and only the variable NAME is ever placed in the tooltip —
// never its value — so nothing sensitive is exposed.

// key -> the env var whose being-set locks that ⚙ control. Keys match the
// flags `resolveEffective` reports in `envOverridden`.
export const ENV_LOCKS = {
    telemetrySource: { var: 'W17_TELEMETRY_SOURCE', label: 'Telemetry source' },
    telemetryPort: { var: 'W17_TELEMETRY_PORT', label: 'Telemetry port' },
    w3: { var: 'W17_HEADTRACK', label: 'Head-track logging' },
};

// Whether a ⚙ field is env-locked, plus the badge + accessible tooltip text.
//   envOverridden: the { telemetrySource, telemetryPort, iphoneBridge, w3 }
//                  flags from resolveEffective (renderer gets them via
//                  settings:get).
export function envLockState(key, envOverridden = {}) {
    const spec = ENV_LOCKS[key];
    const locked = !!(spec && envOverridden[key]);
    if (!locked) return { locked: false, varName: '', badge: '', title: '' };
    return {
        locked: true,
        varName: spec.var,
        badge: 'ENV',
        title: `${spec.label} is set by the ${spec.var} environment variable, which takes precedence over this setting.`,
    };
}
