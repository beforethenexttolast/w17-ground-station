// Quit policy for an app-owned hotspot (audit B1, decision Q1). Quitting
// while a hotspot THIS APP started is still broadcasting asks the operator:
// STOP HOTSPOT AND QUIT / LEAVE HOTSPOT RUNNING / CANCEL. The dialog appears
// ONLY when the app owns the hotspot — never for an inactive one and never
// for an externally started one (ownership comes from the lifecycle/manager,
// not from any UI state). A quit issued during STARTING or STOPPING waits for
// the transition to settle and then judges the settled state, so the decision
// is deterministic: a start that failed quits silently; a start that ended
// LIVE gets the dialog; a stop that failed still owns the hotspot and gets
// the dialog too.
//
// Race-day honesty (micro-backlog 2026-08-20): quitting while race day still
// has its MANAGED drive-program child alive asks QUIT AND STOP / CANCEL —
// teardown ('will-quit') stops that child unconditionally, so quitting
// silently would kill the program driving the car without saying so. The
// prompt is pure honesty, not a new authority: the stop itself stays exactly
// where it was (teardown -> raceDay.dispose()), and nothing here can reach
// the mapper — the policy only reads an injected aliveness flag. It asks
// BEFORE the hotspot decision, because the hotspot branch acts immediately
// (its STOP runs inside the dialog flow) while the mapper stop only happens
// at teardown — this order keeps CANCEL side-effect-free at every stage.
// A mapper that is NOT race-day-managed (the GRID's detached convenience
// launch) never prompts: the app cannot and does not stop it.
//
// Every Electron surface (dialog, error box, quit) is injected, so unit tests
// exercise the whole policy without Electron. Re-entrancy rules:
//  - once a decision allows quitting, the next before-quit passes straight
//    through (no dialog loop, no recursive before-quit);
//  - repeated quit requests while the dialog/stop is pending are absorbed —
//    the first request's decision governs;
//  - CANCEL (or a failed stop) fully resets, so a LATER quit asks again.

const QUIT_BUTTONS = Object.freeze(['STOP HOTSPOT AND QUIT', 'LEAVE HOTSPOT RUNNING', 'CANCEL']);
const CHOICE_STOP = 0;
const CHOICE_LEAVE = 1;
const CHOICE_CANCEL = 2;

// Giftee vocabulary (shared/raceDayView.mjs wording bar): the mapper is only
// ever "the drive program". Two buttons, not three — there is no LEAVE
// RUNNING option because teardown always stops the managed child; offering
// one would be the exact dishonesty this prompt exists to remove.
const MAPPER_QUIT_BUTTONS = Object.freeze(['QUIT AND STOP THE DRIVE PROGRAM', 'CANCEL']);
const MAPPER_CHOICE_QUIT = 0;
const MAPPER_CHOICE_CANCEL = 1;

function createQuitPolicy({ lifecycle, mapperAlive = () => false, showDialog, showError, quit, log = () => {} }) {
    let allowQuit = false; // a decision (or nothing owned) cleared this quit
    let deciding = false;  // dialog/stop in flight: further quits are absorbed

    // Fail-open like the broken-dialog guard below: a throwing aliveness seam
    // must not make the app unquittable, so it reads as "not alive".
    const mapperIsAlive = () => {
        try { return !!mapperAlive(); } catch { return false; }
    };

    // The race-day-managed drive program. Re-checked at decision time (not
    // just in before-quit): a child that exited while the quit was in flight
    // must not raise a stale prompt about stopping a program already gone.
    async function decideMapper() {
        if (!mapperIsAlive()) return 'quit';
        const { response } = await showDialog({
            type: 'warning',
            title: 'W17 Ground Station',
            message: 'The drive program is still running.',
            detail: 'Race day started the drive program on this computer. Quitting stops it,'
                + ' and the controller will stop driving the car.',
            buttons: [...MAPPER_QUIT_BUTTONS],
            defaultId: MAPPER_CHOICE_QUIT,
            cancelId: MAPPER_CHOICE_CANCEL,
            noLink: true,
        });
        if (response !== MAPPER_CHOICE_QUIT) return 'stay';
        // The stop itself is teardown's ('will-quit' -> raceDay.dispose()),
        // unchanged — this decision only made it honest.
        log('[quit] quitting with the race-day drive program alive by user choice; teardown stops it');
        return 'quit';
    }

    async function decideHotspot() {
        await lifecycle.whenSettled();
        const snap = lifecycle.snapshot();
        if (!snap.owned) return 'quit'; // settled un-owned (e.g. the start failed)
        const { response } = await showDialog({
            type: 'warning',
            title: 'W17 Ground Station',
            message: 'The W17 hotspot is still running.',
            detail: `This app started the hotspot${snap.ssid ? ` "${snap.ssid}"` : ''}`
                + `${snap.backend ? ` (${snap.backend} backend)` : ''}.`
                + ' Stop it before quitting, or leave it broadcasting?',
            buttons: [...QUIT_BUTTONS],
            defaultId: CHOICE_STOP,
            cancelId: CHOICE_CANCEL,
            noLink: true,
        });
        if (response === CHOICE_CANCEL) return 'stay';
        if (response === CHOICE_LEAVE) {
            log('[quit] leaving the app-owned hotspot running by user choice');
            return 'quit';
        }
        // STOP HOTSPOT AND QUIT: quit only after the stop actually succeeds.
        // If a renderer-driven transition raced the open dialog, settle it
        // first — stop() would otherwise report 'busy'.
        await lifecycle.whenSettled();
        const res = await lifecycle.stop();
        if (res.ok) return 'quit';
        showError(
            'W17 — hotspot stop failed',
            `The hotspot could not be stopped: ${res.error || 'unknown error'}\n\n`
            + 'The app stays open. Use STOP HOTSPOT on PIT WALL to retry, or stop the hotspot in Windows Settings.',
        );
        return 'stay';
    }

    // Side-effect-free prompts first, acting ones last (comment above): any
    // CANCEL along the way leaves hotspot and drive program exactly as found.
    // The settle comes before EITHER prompt (the B1 rule): both judge settled
    // state, and the async gap it opens is what lets the aliveness re-check
    // in decideMapper catch a child that died while the quit was in flight.
    async function decide() {
        await lifecycle.whenSettled();
        if ((await decideMapper()) === 'stay') return 'stay';
        return decideHotspot();
    }

    function onBeforeQuit(event) {
        if (allowQuit) return; // decision made: this quit proceeds, no dialog loop
        const snap = lifecycle.snapshot();
        const transitioning = snap.phase === 'starting' || snap.phase === 'stopping';
        // Nothing owned, nothing in transit, no managed drive program alive:
        // quit exactly as before — no dialog of any kind.
        if (!snap.owned && !transitioning && !mapperIsAlive()) return;
        event.preventDefault();
        if (deciding) return; // repeated quit while pending: absorbed
        deciding = true;
        decide()
            .then((action) => {
                deciding = false;
                if (action === 'quit') {
                    allowQuit = true;
                    quit();
                }
            })
            .catch((err) => {
                // A broken dialog must not make the app unquittable.
                deciding = false;
                log(`[quit] quit policy failed (${err && err.message ? err.message : err}); allowing quit`);
                allowQuit = true;
                quit();
            });
    }

    return { onBeforeQuit };
}

module.exports = { createQuitPolicy, QUIT_BUTTONS, MAPPER_QUIT_BUTTONS };
