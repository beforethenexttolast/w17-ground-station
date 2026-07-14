// Pure UI wording for the reachability probe (audit B4). ESM (renderer +
// vitest), no IO. main/hostProbe.js classifies the ping into a stable status;
// this maps that status to an honest UI line and carries the approved
// path-only caveat.
//
// PRODUCT TRUTHFULNESS (non-negotiable): a positive reachability result proves
// the network PATH only. It must NEVER claim the iPhone app is receiving UDP,
// that iOS Local Network permission is granted, that W2 telemetry is visible,
// or that the HUD is working. The phone screen is the meaningful final
// evidence. PATH_ONLY_NOTE is the exact approved wording (decision C4) and
// accompanies every successful check.

export const PATH_ONLY_NOTE = 'Ping succeeded. This proves the network path only. Confirm live data on the iPhone; check iOS Local Network permission if it does not appear.';

// probe result (main/hostProbe.js) -> the concise status line for the check
// button. Reachable stays truthful ("network path only"); every other status
// is a clear red outcome. `rttMs` is appended when present.
export function probeStatusLine(res = {}) {
    const reachable = res.status === 'reachable' || (res.ok === true && !res.status);
    if (reachable) {
        return res.rttMs != null
            ? `REACHABLE ${res.rttMs}ms — network path only`
            : 'REACHABLE — network path only';
    }
    switch (res.status) {
        case 'timeout': return 'NO REPLY — timed out';
        case 'unreachable': return 'UNREACHABLE — no route to the phone';
        case 'invalid': return 'INVALID IP';
        case 'command-unavailable': return 'PING UNAVAILABLE ON THIS SYSTEM';
        case 'command-error': return 'CHECK FAILED — retry';
        default: return (res.error ? String(res.error) : 'NO REPLY').toUpperCase();
    }
}
