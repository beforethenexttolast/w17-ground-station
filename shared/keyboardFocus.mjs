// Keyboard-focus policy for the renderer's GLOBAL key handlers (audit M1).
// The HUD mirrors driving keys and the setup flow advances on Enter from
// window-level listeners; both must yield to the browser whenever the user is
// actually typing. One pure module owns that decision so hud.js and
// setupFlow.js can never drift apart on which targets are protected.
//
// ESM, no DOM dependency at import time: predicates read only tagName /
// contenteditable off the event target, so they unit-test with plain objects
// and run identically in the renderer and jsdom.

const EDITABLE_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);
const ACTIVATION_TAGS = new Set(['BUTTON', 'A', 'SUMMARY']);

const tagOf = (target) =>
    target && typeof target.tagName === 'string' ? target.tagName.toUpperCase() : '';

// contenteditable="" / "true" / "plaintext-only" edit; only "false" opts out.
const editableAttr = (target) => {
    if (!target || typeof target.getAttribute !== 'function') return false;
    const attr = target.getAttribute('contenteditable');
    return attr !== null && String(attr).toLowerCase() !== 'false';
};

// True when the target is a text-entry/option control where native keyboard
// behavior (caret movement, space characters, arrow option selection) must
// win untouched: input/select/textarea, or anything inside a contenteditable
// region.
export function isEditableTarget(target) {
    if (!target) return false;
    if (EDITABLE_TAGS.has(tagOf(target))) return true;
    if (target.isContentEditable === true) return true;
    if (editableAttr(target)) return true;
    // Keydown targets inside a contenteditable region can be child elements.
    if (typeof target.closest === 'function') {
        const host = target.closest('[contenteditable]');
        if (host && editableAttr(host)) return true;
    }
    return false;
}

// Editable targets plus controls with native KEY ACTIVATION semantics
// (buttons: Space/Enter click them). Global shortcuts must not swallow or
// double up on those keys while such a control is focused.
export function isInteractiveTarget(target) {
    return isEditableTarget(target) || ACTIVATION_TAGS.has(tagOf(target));
}

// Keys the HUD claims on a non-interactive target (driving mirror + stopping
// page scroll). Space stays claimable on plain targets but is never taken
// from a focused button — Space IS the button's activation key.
const HUD_CLAIMED_KEYS = new Set(['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' ']);

// The HUD's window-level key mirror over a shared `keys` record.
//  keydown — typing in a field records nothing (the HUD must not shift gears
//    under a password field) and prevents nothing (spaces/arrows reach the
//    field). Elsewhere it records, and claims arrows/space unless a control
//    with native activation is focused.
//  keyup — ALWAYS clears: a key pressed while driving must never stick down
//    because it was released after focus moved into a field.
export function makeHudKeyHandlers(keys) {
    return {
        keydown(e) {
            if (isEditableTarget(e.target)) return;
            const k = e.key.toLowerCase();
            keys[k] = true;
            if (!HUD_CLAIMED_KEYS.has(k)) return;
            // Space is a focused button's native activation key — leave it.
            // Arrows mean nothing to activation controls, so they stay
            // claimed (drives the mirror, stops page scroll).
            if (k === ' ' && isInteractiveTarget(e.target)) return;
            e.preventDefault();
        },
        keyup(e) {
            keys[e.key.toLowerCase()] = false;
        },
    };
}

// The setup flow's window-level "Enter advances the step" handler. Enter
// while ANY interactive control is focused belongs to that control (typing a
// password, a focused button) — advancing then would discard the user's
// action (audit M1: Enter after a Wi-Fi password navigated away from the
// join).
export function makeEnterToAdvance({ canAdvance, advance }) {
    return (e) => {
        if (e.key !== 'Enter' || isInteractiveTarget(e.target)) return;
        if (canAdvance()) advance();
    };
}

// Field-level Enter-submits handler (e.g. Wi-Fi password -> JOIN). Attached
// directly to the field; preventDefault keeps Enter from doing anything else.
export function makeEnterToSubmit(submit) {
    return (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        submit();
    };
}
