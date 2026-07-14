// @vitest-environment jsdom
// Keyboard-focus policy (audit M1): the global HUD/setup key handlers must
// yield to native behavior whenever an editable/interactive control has
// focus. These are DOM-level tests — real elements, real KeyboardEvents
// dispatched through the real handler factories — because the original
// defects (space swallowed in the SSID field, Enter discarding the Wi-Fi
// join) lived exactly in the event wiring, not in any pure computation.
import { describe, it, expect, vi } from 'vitest';
import {
  isEditableTarget,
  isInteractiveTarget,
  makeHudKeyHandlers,
  makeEnterToAdvance,
  makeEnterToSubmit,
} from '../shared/keyboardFocus.mjs';

const make = (html) => {
  document.body.innerHTML = html;
  return document.body.firstElementChild;
};

const key = (target, k, type = 'keydown') => {
  const e = new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
};

describe('isEditableTarget', () => {
  it('covers input, select, and textarea', () => {
    expect(isEditableTarget(make('<input type="text" />'))).toBe(true);
    expect(isEditableTarget(make('<input type="password" />'))).toBe(true);
    expect(isEditableTarget(make('<select><option>a</option></select>'))).toBe(true);
    expect(isEditableTarget(make('<textarea></textarea>'))).toBe(true);
  });

  it('covers contenteditable, including bare and "true", excluding "false"', () => {
    expect(isEditableTarget(make('<div contenteditable></div>'))).toBe(true);
    expect(isEditableTarget(make('<div contenteditable="true"></div>'))).toBe(true);
    expect(isEditableTarget(make('<div contenteditable="plaintext-only"></div>'))).toBe(true);
    expect(isEditableTarget(make('<div contenteditable="false"></div>'))).toBe(false);
  });

  it('covers elements NESTED inside a contenteditable region', () => {
    const host = make('<div contenteditable="true"><span id="inner">x</span></div>');
    expect(isEditableTarget(host.querySelector('#inner'))).toBe(true);
  });

  it('rejects buttons, plain elements, and non-elements', () => {
    expect(isEditableTarget(make('<button>go</button>'))).toBe(false);
    expect(isEditableTarget(make('<div>x</div>'))).toBe(false);
    expect(isEditableTarget(document.body)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(undefined)).toBe(false);
  });
});

describe('isInteractiveTarget', () => {
  it('adds native-activation controls on top of editable ones', () => {
    expect(isInteractiveTarget(make('<button>go</button>'))).toBe(true);
    expect(isInteractiveTarget(make('<a href="#">x</a>'))).toBe(true);
    expect(isInteractiveTarget(make('<input type="text" />'))).toBe(true);
    expect(isInteractiveTarget(make('<div>x</div>'))).toBe(false);
    expect(isInteractiveTarget(document.body)).toBe(false);
  });
});

describe('makeHudKeyHandlers (the HUD driving-key mirror)', () => {
  const wire = () => {
    const keys = {};
    const h = makeHudKeyHandlers(keys);
    addEventListener('keydown', h.keydown);
    addEventListener('keyup', h.keyup);
    return {
      keys,
      done: () => {
        removeEventListener('keydown', h.keydown);
        removeEventListener('keyup', h.keyup);
      },
    };
  };

  it('space in a focused text input is NOT prevented and NOT recorded', () => {
    const { keys, done } = wire();
    const input = make('<input type="text" />');
    input.focus();
    const e = key(input, ' ');
    expect(e.defaultPrevented).toBe(false); // the space reaches the SSID/password
    expect(keys[' ']).toBeUndefined(); // and never drives the HUD mirror
    done();
  });

  it('arrow keys in a focused input and select are NOT prevented', () => {
    const { done } = wire();
    for (const el of [make('<input type="text" />'), make('<select><option>a</option></select>')]) {
      el.focus();
      expect(key(el, 'ArrowLeft').defaultPrevented).toBe(false); // caret / option moves
      expect(key(el, 'ArrowRight').defaultPrevented).toBe(false);
    }
    done();
  });

  it('contenteditable is protected like an input', () => {
    const { keys, done } = wire();
    const div = make('<div contenteditable="true"></div>');
    expect(key(div, ' ').defaultPrevented).toBe(false);
    expect(keys[' ']).toBeUndefined();
    done();
  });

  it('outside editable controls the mirror still claims arrows/space', () => {
    const { keys, done } = wire();
    expect(key(document.body, 'ArrowUp').defaultPrevented).toBe(true);
    expect(keys.arrowup).toBe(true);
    expect(key(document.body, ' ').defaultPrevented).toBe(true);
    expect(key(document.body, 'e').defaultPrevented).toBe(false); // only arrows/space are claimed
    expect(keys.e).toBe(true);
    done();
  });

  it('a focused BUTTON keeps native space activation but still mirrors driving keys', () => {
    const { keys, done } = wire();
    const btn = make('<button>preview</button>');
    btn.focus();
    expect(key(btn, ' ').defaultPrevented).toBe(false); // space still clicks the button
    expect(key(btn, 'ArrowUp').defaultPrevented).toBe(true); // arrows have no button meaning
    expect(keys.arrowup).toBe(true); // keyboard driving survives button focus
    done();
  });

  it('keyup ALWAYS clears — a key released inside a field never sticks down', () => {
    const { keys, done } = wire();
    key(document.body, 'ArrowUp'); // pressed while driving
    expect(keys.arrowup).toBe(true);
    const input = make('<input type="text" />');
    input.focus();
    key(input, 'ArrowUp', 'keyup'); // released after focus moved into a field
    expect(keys.arrowup).toBe(false);
    done();
  });
});

describe('makeEnterToAdvance (setup NEXT-on-Enter)', () => {
  const wire = (canAdvance = () => true) => {
    const advance = vi.fn();
    const h = makeEnterToAdvance({ canAdvance, advance });
    addEventListener('keydown', h);
    return { advance, done: () => removeEventListener('keydown', h) };
  };

  it('advances on Enter from a non-interactive focus', () => {
    const { advance, done } = wire();
    key(document.body, 'Enter');
    expect(advance).toHaveBeenCalledTimes(1);
    done();
  });

  it('never advances while an editable field or focused button has focus', () => {
    const { advance, done } = wire();
    for (const html of [
      '<input type="text" />', '<textarea></textarea>',
      '<select><option>a</option></select>', '<div contenteditable="true"></div>',
      '<button>x</button>',
    ]) {
      const el = make(html);
      el.focus();
      key(el, 'Enter');
    }
    expect(advance).not.toHaveBeenCalled();
    done();
  });

  it('respects the availability gate and ignores other keys', () => {
    const { advance, done } = wire(() => false);
    key(document.body, 'Enter');
    key(document.body, ' ');
    expect(advance).not.toHaveBeenCalled();
    done();
  });
});

describe('makeEnterToSubmit + advance interplay (Wi-Fi password field)', () => {
  it('Enter in the field submits the JOIN and does NOT navigate', () => {
    const join = vi.fn();
    const advance = vi.fn();
    const nav = makeEnterToAdvance({ canAdvance: () => true, advance });
    addEventListener('keydown', nav);
    const pw = make('<input type="password" />');
    pw.addEventListener('keydown', makeEnterToSubmit(join));
    pw.focus();
    const e = key(pw, 'Enter'); // bubbles up to the window-level nav handler
    expect(join).toHaveBeenCalledTimes(1);
    expect(advance).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
    removeEventListener('keydown', nav);
  });

  it('other keys in the field do not submit', () => {
    const join = vi.fn();
    const pw = make('<input type="password" />');
    pw.addEventListener('keydown', makeEnterToSubmit(join));
    key(pw, ' ');
    key(pw, 'a');
    expect(join).not.toHaveBeenCalled();
  });
});
