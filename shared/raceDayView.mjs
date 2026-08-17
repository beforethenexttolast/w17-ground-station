// Pure display mapping for the GARAGE race-day card. ESM (renderer + vitest).
// No IO: the renderer feeds it the orchestrator's pushed snapshot; this module
// only decides the label, the sentence, and the tone for each step line plus
// the headline and control states. Machine kinds in, giftee sentences out.
//
// WORDING IS PLAIN LANGUAGE BY REQUIREMENT (vision operator model, the same
// bar the GRID hints hold — shared/checklist.mjs / audit defect 11): the
// operator is a non-hobbyist, so every failing line says what happened and
// what to DO in gift-manual vocabulary — never component names, stack pieces,
// ports, or repo paths. The mapper is only ever "the drive program" (the
// vocabulary the ELRS CONTROL hint established); the technical detail stays
// where technicians look (main-process log, the raceday:status diagnostics
// tail). test/raceDayView.test.js pins the exact strings AND the jargon ban.
// When editing a line, keep the failure shape "what's wrong — what to do".

export const RACE_DAY_STEP_LABELS = Object.freeze({
    hotspot: 'CAR WI-FI',
    mapper: 'DRIVE PROGRAM',
    bridge: 'PHONE LINK',
});

// tone -> renderer CSS class; 'muted' rows are informational (waiting/skips).
const TONES = Object.freeze(['ok', 'fail', 'run', 'muted']);

// text per step id -> status -> kind. `*` catches kinds this view does not
// know (a newer main process than renderer, mid-update): the honest generic
// line, never a blank row.
const TEXT = {
    hotspot: {
        running: {
            starting: 'switching on…',
            checking: 'switched on — checking it is ready…',
            '*': 'working…',
        },
        ok: {
            verified: 'on and ready',
            unverified: 'on (could not double-check on this computer)',
            '*': 'on',
        },
        skipped: {
            'own-wifi': 'using your own Wi-Fi — nothing to switch on',
            '*': 'not needed this time',
        },
        fail: {
            'start-failed': 'the car Wi-Fi did not switch on — open PIT WALL to see why, or use your home Wi-Fi',
            degraded: 'the Wi-Fi is on but not ready — wait a moment and press RACE DAY again',
            busy: 'the Wi-Fi is busy switching — wait a moment and press RACE DAY again',
            '*': 'something went wrong here — press RACE DAY to try again',
        },
    },
    mapper: {
        running: {
            starting: 'starting…',
            '*': 'working…',
        },
        ok: {
            running: 'running',
            'already-running': 'already running',
            // Detected running OUTSIDE race day (e.g. launched from the GRID):
            // honest no-op — race day neither adopted it nor will stop it.
            external: 'already running (started outside RACE DAY)',
            '*': 'running',
        },
        skipped: { '*': 'not needed this time' },
        fail: {
            'not-configured': 'its location is not set — set it once in ⚙ (RACE DAY)',
            'no-profile': 'the saved controller setup is not chosen — set it once in ⚙ (RACE DAY)',
            'bad-profile-path': 'the saved controller setup location looks wrong — fix it in ⚙ (RACE DAY)',
            'profile-not-found': 'the saved controller setup file is missing — fix it in ⚙ (RACE DAY)',
            'not-found': 'not found where ⚙ points — fix the location in ⚙ (RACE DAY)',
            'spawn-failed': 'could not start — check its location in ⚙, then press RACE DAY again',
            exited: 'stopped on its own — press RACE DAY to bring it back',
            '*': 'something went wrong here — press RACE DAY to try again',
        },
    },
    bridge: {
        running: {
            applying: 'connecting…',
            '*': 'working…',
        },
        ok: {
            on: 'on — pick up the phone',
            '*': 'on',
        },
        skipped: {
            'desktop-session': 'desktop session — the phone is not used',
            'off-by-choice': 'switched off in ⚙',
            '*': 'not needed this time',
        },
        fail: {
            'no-address': "the phone's address is not saved — run setup once with the phone connected",
            'forced-off': 'held off by a developer setting on this computer — ask whoever set the computer up',
            'apply-failed': 'did not switch on — press RACE DAY again',
            '*': 'something went wrong here — press RACE DAY to try again',
        },
    },
};

const toneFor = (status) => (status === 'ok' ? 'ok'
    : status === 'fail' ? 'fail'
    : status === 'running' ? 'run'
    : 'muted');

// One line per step, in the orchestrator's order. Unknown snapshots/steps
// degrade to muted 'waiting…' rows — the card never renders a blank or a lie.
export function raceDayStepLines(snap) {
    const steps = (snap && Array.isArray(snap.steps)) ? snap.steps : [];
    return steps.map(({ id, status, kind }) => {
        const label = RACE_DAY_STEP_LABELS[id] || String(id || '').toUpperCase();
        const byStatus = TEXT[id] && TEXT[id][status];
        const text = (status === 'idle' || status === 'pending')
            ? 'waiting…'
            : (byStatus && (byStatus[kind] || byStatus['*'])) || 'waiting…';
        return { id, label, text, tone: toneFor(status) };
    });
}

// The at-a-glance line above the step rows. null while the card is idle (the
// steps have never run this session) — the button alone tells the story.
export function raceDayHeadline(snap) {
    if (!snap || !Array.isArray(snap.steps)) return null;
    const statuses = snap.steps.map((s) => s.status);
    if (snap.running) return { text: 'BRINGING EVERYTHING UP…', tone: 'run' };
    if (statuses.includes('fail')) return { text: 'SOMETHING NEEDS ATTENTION — see below', tone: 'fail' };
    if (statuses.includes('ok')) return { text: 'EVERYTHING IS UP — STRAIGHT TO THE GRID when ready', tone: 'ok' };
    return null; // all idle/pending-never-run: no claim to make
}

// Button states. START disables only while a bring-up is in flight (a retry
// after failure is the normal path); STOP shows only when there is something
// race day exclusively owns to stop (the managed drive program).
export function raceDayControls(snap) {
    return {
        startDisabled: !!(snap && snap.running),
        stopVisible: !!(snap && !snap.running && snap.mapper && snap.mapper.running),
    };
}

export { TONES };
