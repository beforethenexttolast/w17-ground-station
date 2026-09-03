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
    telemetry: 'CAR READINGS',
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
            // Already broadcasting under the saved name when race day looked —
            // very often this app's own network from the last run. Nothing to
            // switch on, nothing to stop: the phone's network is up (OD-7).
            external: 'already on — using it',
            '*': 'on',
        },
        skipped: {
            'own-wifi': 'using your own Wi-Fi — nothing to switch on',
            '*': 'not needed this time',
        },
        fail: {
            'start-failed': 'the car Wi-Fi did not switch on — open PIT WALL to see why, or use your home Wi-Fi',
            // A hotspot is up, but not the saved one: the phone cannot join it,
            // and this app must not stop a network it did not start (OD-7).
            'other-hotspot': 'a different Wi-Fi hotspot is already on — switch it off in Windows settings, then press RACE DAY again',
            'already-on-unknown': 'a Wi-Fi hotspot is already on and this computer cannot tell which one — switch it off in Windows settings, then press RACE DAY again',
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
            // Review SYN-2: started, but this computer could not check whether
            // the radio is actually transmitting. Honest partial success, the
            // same shape as the hotspot's 'unverified' line.
            'link-unknown': 'started (could not double-check the radio on this computer)',
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
            // Review SYN-2 / OD-5: the program is up but its radio is not, so
            // NOTHING reaches the car. This is the line that used to read
            // "running" while no signal left the computer at all.
            'link-down': 'started, but the radio is not transmitting — check the cable to the little radio box, then press RACE DAY again',
            exited: 'stopped on its own — press RACE DAY to bring it back',
            // It died AND told us why (the drive program prints one plain
            // sentence and stops when the saved controller setup has not been
            // matched to this computer yet). Pressing RACE DAY again could
            // never fix that, so this line points at the message instead.
            'exited-with-message': 'stopped on its own and said why — read the line below, then fix it in ⚙ (RACE DAY)',
            // The stop was asked for, forced, and did not take: the program is
            // STILL RUNNING. Never draw a stopped card over a live one.
            'stop-failed': 'it would not stop when asked and is still running — close the app and open it again',
            '*': 'something went wrong here — press RACE DAY to try again',
        },
    },
    // Owner decision OD-4. This step never fails: it selects where the car's
    // readings come from and then says, honestly, whether any have arrived.
    // Whether the car is switched on is not race day's business.
    telemetry: {
        running: {
            selecting: 'switching them on…',
            waiting: 'listening for the car…',
            '*': 'working…',
        },
        ok: {
            live: 'on — the car is sending its battery and speed',
            waiting: 'on — nothing from the car yet (switch the car on)',
            '*': 'on',
        },
        skipped: {
            'own-source': 'a different source is chosen in ⚙ — leaving it alone',
            'held-off': 'held off by a developer setting on this computer — ask whoever set the computer up',
            unavailable: 'could not be switched on — the battery number stays blank',
            '*': 'not needed this time',
        },
        fail: { '*': 'something went wrong here — press RACE DAY to try again' },
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

// The drive program's OWN last words, for the row under the step lines. The
// main process already cleaned and capped the string (main/mapperRunner.js
// _lastLine); this view only decides whether to show it and how it is
// introduced. Shown ONLY for a death the program explained itself — a stop we
// asked for carries no message, and there is nothing to explain about it.
//
// This is the one line on the card that is NOT our copy: it is quoted from the
// program, so the giftee-vocabulary bar cannot apply to it. That is deliberate
// — the alternative is inventing a cause we do not know. The label frames it
// as a quotation so it never reads as the ground station's own instruction.
export function raceDayMapperMessage(snap) {
    const msg = snap && snap.mapper && snap.mapper.exitMessage;
    if (typeof msg !== 'string' || !msg.trim()) return null;
    return { label: 'IT SAID', text: msg.trim(), tone: 'fail' };
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
