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

function createQuitPolicy({ lifecycle, showDialog, showError, quit, log = () => {} }) {
    let allowQuit = false; // a decision (or nothing owned) cleared this quit
    let deciding = false;  // dialog/stop in flight: further quits are absorbed

    async function decide() {
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

    function onBeforeQuit(event) {
        if (allowQuit) return; // decision made: this quit proceeds, no dialog loop
        const snap = lifecycle.snapshot();
        const transitioning = snap.phase === 'starting' || snap.phase === 'stopping';
        if (!snap.owned && !transitioning) return; // nothing owned: quit normally
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

module.exports = { createQuitPolicy, QUIT_BUTTONS };
