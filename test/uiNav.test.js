// @vitest-environment jsdom
// Unit tests for the controller-driven UI-navigation module (Batch 9). Two
// layers: the PURE core (focusables / nextIndex / diffIntents) tested directly,
// and the stateful singleton (configure/pollOnce) driven with an injected pad
// against a synthetic DOM so the nav matrix, capture suspension, and settings
// toggle are exercised without booting the whole renderer (that integration
// lives in test/setupFlowDom.test.js). VIEWER-ONLY: every effect asserted here
// is a DOM focus/click — there is no control path to test.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  focusables, nextIndex, diffIntents, configure, pollOnce, clearFocusRing,
  focusedElement, NAV_BUTTON, DPAD,
} from '../renderer/uiNav.js';

// A standard-mapping pad snapshot: `down` is a set of pressed button indices,
// axes default to centre. 16 buttons so any nav index exists.
const pad = ({ down = [], axes = [0, 0, 0, 0] } = {}) => ({
  id: 'test-pad', index: 0, connected: true, mapping: 'standard',
  axes: axes.slice(),
  buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: down.includes(i), value: down.includes(i) ? 1 : 0 })),
});

describe('focusables — visible, enabled controls in document order (Tab parity)', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="root">
        <button id="b1">one</button>
        <button id="b2" class="hidden">hidden</button>
        <button id="b3" disabled>disabled</button>
        <input id="i1" />
        <span id="s1" tabindex="0">span</span>
        <span id="s2" tabindex="-1">not-tabbable</span>
        <section class="setup-screen" data-step="off"><button id="off">off-screen</button></section>
        <section class="setup-screen active" data-step="on"><button id="on">on-screen</button></section>
        <div hidden><button id="attr">attr-hidden</button></div>
      </div>`;
  });

  it('returns only navigable controls, in DOM order', () => {
    const ids = focusables(document.getElementById('root')).map((e) => e.id);
    expect(ids).toEqual(['b1', 'i1', 's1', 'on']);
  });

  it('excludes .hidden, [hidden], [disabled], tabindex="-1", and inactive .setup-screen', () => {
    const ids = focusables(document.getElementById('root')).map((e) => e.id);
    for (const gone of ['b2', 'b3', 's2', 'off', 'attr']) expect(ids).not.toContain(gone);
  });

  it('a control turning hidden drops out on the next scan (live, not cached)', () => {
    const root = document.getElementById('root');
    expect(focusables(root).map((e) => e.id)).toContain('b1');
    document.getElementById('b1').classList.add('hidden');
    expect(focusables(root).map((e) => e.id)).not.toContain('b1');
  });
});

describe('nextIndex — wrap-around with cold-start', () => {
  it('cold start (cur < 0) lands on first for next, last for prev', () => {
    expect(nextIndex(3, -1, 'next')).toBe(0);
    expect(nextIndex(3, -1, 'prev')).toBe(2);
  });
  it('wraps at both ends', () => {
    expect(nextIndex(3, 2, 'next')).toBe(0);
    expect(nextIndex(3, 0, 'prev')).toBe(2);
    expect(nextIndex(3, 1, 'next')).toBe(2);
  });
  it('empty list yields -1', () => {
    expect(nextIndex(0, -1, 'next')).toBe(-1);
  });
});

describe('diffIntents — edge/threshold detection', () => {
  const snap = (p) => ({
    buttons: p.buttons.map((b) => b.pressed),
    axes: p.axes.slice(),
  });

  it('a button fires only on the press edge, not while held', () => {
    const neutral = snap(pad());
    const pressed = snap(pad({ down: [NAV_BUTTON.confirm] }));
    expect(diffIntents(neutral, pressed).confirm).toBe(true);   // press edge
    expect(diffIntents(pressed, pressed).confirm).toBe(false);  // held: no repeat
    expect(diffIntents(pressed, neutral).confirm).toBe(false);  // release: no fire
  });

  it('back and settings map to buttons 1 and 9', () => {
    const neutral = snap(pad());
    expect(diffIntents(neutral, snap(pad({ down: [NAV_BUTTON.back] }))).back).toBe(true);
    expect(diffIntents(neutral, snap(pad({ down: [NAV_BUTTON.settings] }))).settings).toBe(true);
  });

  it('d-pad up/left move prev; down/right move next', () => {
    const neutral = snap(pad());
    expect(diffIntents(neutral, snap(pad({ down: [DPAD.up] }))).move).toBe('prev');
    expect(diffIntents(neutral, snap(pad({ down: [DPAD.left] }))).move).toBe('prev');
    expect(diffIntents(neutral, snap(pad({ down: [DPAD.down] }))).move).toBe('next');
    expect(diffIntents(neutral, snap(pad({ down: [DPAD.right] }))).move).toBe('next');
  });

  it('left stick fires once on threshold crossing, re-arms only after returning to centre', () => {
    const centre = snap(pad({ axes: [0, 0] }));
    const rightHeld = snap(pad({ axes: [0.9, 0] }));
    const downHeld = snap(pad({ axes: [0, 0.9] }));
    expect(diffIntents(centre, rightHeld).move).toBe('next');    // cross right -> next
    expect(diffIntents(rightHeld, rightHeld).move).toBe(null);   // still deflected: no repeat
    expect(diffIntents(rightHeld, centre).move).toBe(null);      // return to centre: no fire
    expect(diffIntents(centre, downHeld).move).toBe('next');     // cross down -> next
    expect(diffIntents(centre, snap(pad({ axes: [-0.9, 0] }))).move).toBe('prev'); // left -> prev
    expect(diffIntents(centre, snap(pad({ axes: [0, -0.9] }))).move).toBe('prev'); // up -> prev
  });

  it('a null previous snapshot treats the baseline as neutral', () => {
    expect(diffIntents(null, snap(pad({ down: [NAV_BUTTON.confirm] }))).confirm).toBe(true);
  });
});

describe('pollOnce — singleton navigation over a synthetic DOM', () => {
  let current;               // the pad getPad() returns this tick
  let toggled, backed, suspended;
  const press = (down, axes) => { current = pad({ down, axes }); pollOnce(); };
  const release = () => { current = pad(); pollOnce(); };

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="scope">
        <button id="a">A</button>
        <button id="b">B</button>
        <button id="c">C</button>
      </div>`;
    current = pad();
    toggled = 0; backed = 0; suspended = false;
    configure({
      getPad: () => current,
      getRoot: () => document.getElementById('scope'),
      isSuspended: () => suspended,
      toggleSettings: () => { toggled += 1; },
      back: () => { backed += 1; },
    });
    pollOnce(); // seed the edge baseline with the neutral pad (intents fire from the second poll)
  });

  it('a move focuses the first control and applies the visible focus ring', () => {
    press([DPAD.down]);
    expect(document.activeElement).toBe(document.getElementById('a'));
    expect(document.getElementById('a').classList.contains('uinav-focus')).toBe(true);
    expect(focusedElement()).toBe(document.getElementById('a'));
  });

  it('successive moves walk the Tab order and move the ring with them (only one ring at a time)', () => {
    press([DPAD.down]); release();
    press([DPAD.down]); release();
    expect(document.activeElement).toBe(document.getElementById('b'));
    expect(document.getElementById('a').classList.contains('uinav-focus')).toBe(false);
    expect(document.getElementById('b').classList.contains('uinav-focus')).toBe(true);
    // prev moves back to A
    press([DPAD.up]);
    expect(document.activeElement).toBe(document.getElementById('a'));
  });

  it('moves wrap around the ends', () => {
    press([DPAD.up]); // cold prev -> last
    expect(document.activeElement).toBe(document.getElementById('c'));
  });

  it('confirm activates (clicks) the focused control', () => {
    let clicks = 0;
    document.getElementById('b').addEventListener('click', () => { clicks += 1; });
    press([DPAD.down]); release();      // focus A
    press([DPAD.down]); release();      // focus B
    press([NAV_BUTTON.confirm]);        // confirm B
    expect(clicks).toBe(1);
  });

  it('a cold confirm (nothing focused yet) focuses the first control instead of doing nothing', () => {
    press([NAV_BUTTON.confirm]);
    expect(document.activeElement).toBe(document.getElementById('a'));
  });

  it('the settings button (index 9) toggles the settings menu; back (index 1) invokes close/back', () => {
    press([NAV_BUTTON.settings]);
    expect(toggled).toBe(1);
    release();
    press([NAV_BUTTON.back]);
    expect(backed).toBe(1);
  });

  it('capture suspension: no focus moves while suspended, and no stale edge fires on resume', () => {
    suspended = true;
    press([DPAD.down]);                 // would move if not suspended
    expect(focusedElement()).toBeNull();
    expect(document.getElementById('a').classList.contains('uinav-focus')).toBe(false);
    // Resume with the SAME held state — prevSnap advanced during suspension, so
    // the still-held d-pad does not replay as a fresh edge.
    suspended = false;
    pollOnce();                         // d-pad still down, but no crossing edge
    expect(focusedElement()).toBeNull();
    // A fresh press after release navigates normally again.
    release();
    press([DPAD.down]);
    expect(document.activeElement).toBe(document.getElementById('a'));
  });

  it('clearFocusRing drops the ring (mouse/Tab handoff)', () => {
    press([DPAD.down]);
    expect(focusedElement()).not.toBeNull();
    clearFocusRing();
    expect(focusedElement()).toBeNull();
    expect(document.getElementById('a').classList.contains('uinav-focus')).toBe(false);
  });

  it('seeding: a button already held at configure time never fires a phantom intent', () => {
    // Re-configure (resets to unseeded) with the settings button ALREADY down.
    current = pad({ down: [NAV_BUTTON.settings] });
    configure({
      getPad: () => current,
      getRoot: () => document.getElementById('scope'),
      isSuspended: () => false,
      toggleSettings: () => { toggled += 1; },
      back: () => { backed += 1; },
    });
    pollOnce();                          // first poll only seeds
    pollOnce();                          // still held: no edge
    expect(toggled).toBe(0);
    release();                           // released
    press([NAV_BUTTON.settings]);        // a REAL press edge now fires
    expect(toggled).toBe(1);
  });

  it('a disconnect resets the baseline: a pedal resting at -1 on reconnect fires no phantom move', () => {
    current = null;                      // pad gone → unseeded
    pollOnce();
    current = pad({ axes: [0, -1] });    // reconnect, axis 1 resting fully deflected
    pollOnce();                          // seeds with the resting value
    pollOnce();                          // unchanged: no crossing
    expect(focusedElement()).toBeNull();
    current = pad({ axes: [0, 0] });     // return to centre: no fire either
    pollOnce();
    expect(focusedElement()).toBeNull();
    current = pad({ axes: [0, -0.9] });  // a REAL crossing after centring moves focus
    pollOnce();
    expect(document.activeElement).toBe(document.getElementById('c')); // prev wraps to last
  });

  it('an analog-only button (value, no pressed flag) counts as pressed — pressedWheelRoles parity', () => {
    const analog = pad();
    analog.buttons[NAV_BUTTON.confirm] = { pressed: false, value: 0.6 };
    current = analog; pollOnce();
    expect(document.activeElement).toBe(document.getElementById('a')); // cold confirm focuses first
  });

  it('settingsOnly (live session, menu closed): only the settings toggle acts', () => {
    let live = true;
    configure({
      getPad: () => current,
      getRoot: () => document.getElementById('scope'),
      isSuspended: () => false,
      settingsOnly: () => live,
      toggleSettings: () => { toggled += 1; },
      back: () => { backed += 1; },
    });
    current = pad(); pollOnce();         // seed
    press([DPAD.down]); release();       // move: inert
    press([NAV_BUTTON.confirm]); release(); // confirm: inert
    press([NAV_BUTTON.back]); release(); // back: inert
    expect(focusedElement()).toBeNull();
    expect(backed).toBe(0);
    press([NAV_BUTTON.settings]); release(); // settings: still live
    expect(toggled).toBe(1);
    live = false;                        // menu opened → full nav again
    press([DPAD.down]);
    expect(document.activeElement).toBe(document.getElementById('a'));
  });

  it('axis moves are ignored while a text-entry element has focus; d-pad still moves', () => {
    document.body.insertAdjacentHTML('beforeend', '<input id="txt" type="text" />');
    const txt = document.getElementById('txt');
    txt.focus();
    press([], [0, 0.9]);                 // stick crossing while typing: ignored
    expect(document.activeElement).toBe(txt);
    release();
    press([DPAD.down]);                  // d-pad is deliberate: moves focus away
    expect(document.activeElement).toBe(document.getElementById('a'));
    txt.remove();
  });
});
