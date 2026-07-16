import { describe, it, expect } from 'vitest';
import {
  cameraModeView, CAMERA_MODES, DEFAULT_CAMERA_MODE,
  AVAILABLE_MODE_LABEL, ACTIVE_AUTHORITY_UNREPORTED_LABEL,
} from '../shared/cameraMode.mjs';

// The CAMERA MODE model is DISPLAY-ONLY. It must keep AVAILABLE/REQUESTED and
// ACTIVE AUTHORITY strictly apart, offer Manual as the only selectable mode, keep
// Head Tracking visible-but-locked, NEVER fabricate an active authority the viewer
// cannot know (task §1A), and NEVER expose a way to arm or emit control (task §4).

describe('camera mode model — modes', () => {
  it('exposes exactly Manual (selectable) and Head Tracking (locked)', () => {
    expect(CAMERA_MODES.map((m) => m.key)).toEqual(['manual', 'headtrack']);
    const manual = CAMERA_MODES.find((m) => m.key === 'manual');
    const ht = CAMERA_MODES.find((m) => m.key === 'headtrack');
    expect(manual.selectable).toBe(true);
    expect(ht.selectable).toBe(false);
    expect(ht.lock).toContain('LOCKED');
  });

  it('default requested mode is manual', () => {
    expect(DEFAULT_CAMERA_MODE).toBe('manual');
    expect(cameraModeView().requested).toBe('manual');
  });

  it('renders Manual as selected and Head Tracking as locked/unselected', () => {
    const view = cameraModeView({ requested: 'manual' });
    const manual = view.modes.find((m) => m.key === 'manual');
    const ht = view.modes.find((m) => m.key === 'headtrack');
    expect(manual).toMatchObject({ selectable: true, selected: true, locked: false });
    expect(ht).toMatchObject({ selectable: false, selected: false, locked: true });
    expect(ht.lock).toContain('SAFETY GATE');
  });

  it('the locked Head Tracking card carries a locked state and NO active/armed/selected state', () => {
    const ht = cameraModeView({ requested: 'headtrack' }).modes.find((m) => m.key === 'headtrack');
    expect(ht).toMatchObject({ selectable: false, selected: false, locked: true });
    expect(ht.lock).toContain('LOCKED');
    // The card exposes no state field that could read as active/armed/authoritative.
    expect(ht).not.toHaveProperty('armed');
    expect(ht).not.toHaveProperty('active');
    expect(ht).not.toHaveProperty('authoritative');
  });

  it('coerces a request for the locked head-tracking mode back to manual (no unsafe landing)', () => {
    const view = cameraModeView({ requested: 'headtrack' });
    expect(view.requested).toBe('manual');
    expect(view.modes.find((m) => m.key === 'headtrack').selected).toBe(false);
  });

  it('coerces an unknown requested mode to manual', () => {
    expect(cameraModeView({ requested: 'nonsense' }).requested).toBe('manual');
    expect(cameraModeView({ requested: undefined }).requested).toBe('manual');
  });
});

describe('camera mode model — never fabricates active authority (task §1A)', () => {
  it('does NOT report active authority by default — it reads NOT REPORTED BY MAPPER', () => {
    const view = cameraModeView();
    expect(view.activeAuthorityReported).toBe(false);
    expect(view.activeAuthority).toBeNull();
    expect(view.activeAuthorityLabel).toBe(ACTIVE_AUTHORITY_UNREPORTED_LABEL);
    expect(view.activeAuthorityLabel).toBe('NOT REPORTED BY MAPPER');
  });

  it('never derives active authority from the requested mode — asking for manual still leaves it unreported', () => {
    for (const requested of ['manual', 'headtrack', 'nonsense', undefined]) {
      const view = cameraModeView({ requested });
      expect(view.activeAuthorityReported, String(requested)).toBe(false);
      expect(view.activeAuthority).toBeNull();
      expect(view.activeAuthorityLabel).toBe('NOT REPORTED BY MAPPER');
    }
  });

  it('AVAILABLE/REQUESTED and ACTIVE AUTHORITY are distinct fields with distinct values', () => {
    const view = cameraModeView({ requested: 'manual' });
    expect(view.requested).toBe('manual');
    expect(view.requestedLabel).toBe(AVAILABLE_MODE_LABEL);
    expect(view.requestedIsSetupDefault).toBe(true); // marked as the setup default, not live authority
    expect(view.requestedLabel).not.toBe(view.activeAuthorityLabel);
    expect(Object.keys(view)).toEqual(expect.arrayContaining([
      'requested', 'requestedLabel', 'requestedIsSetupDefault',
      'activeAuthority', 'activeAuthorityLabel', 'activeAuthorityReported',
    ]));
  });

  it('never surfaces W3 / head-tracking as the active authority', () => {
    const view = cameraModeView({ requested: 'headtrack' });
    expect(view.activeAuthorityLabel.toLowerCase()).not.toMatch(/w3|head|track/);
  });

  it('reports active authority ONLY from a trusted external source (a future mapper diagnostics feed)', () => {
    const view = cameraModeView({
      activeAuthority: { reported: true, key: 'manual', label: 'MANUAL · RIGHT STICK' },
    });
    expect(view.activeAuthorityReported).toBe(true);
    expect(view.activeAuthority).toBe('manual');
    expect(view.activeAuthorityLabel).toBe('MANUAL · RIGHT STICK');
  });

  it('ignores an untrusted / ill-formed active-authority hint — stays unreported, never fabricated', () => {
    for (const bad of [
      {}, // no reported flag
      { reported: false, label: 'X' }, // explicitly not reported
      { reported: true }, // no label
      { reported: true, label: '' }, // empty label
      'manual', // a bare string, e.g. inferred from the browser stick — rejected
      true,
      null,
    ]) {
      const view = cameraModeView({ activeAuthority: bad });
      expect(view.activeAuthorityReported, JSON.stringify(bad)).toBe(false);
      expect(view.activeAuthority).toBeNull();
      expect(view.activeAuthorityLabel).toBe('NOT REPORTED BY MAPPER');
    }
  });
});

describe('camera mode model — per-card help trimmed to unique content (Batch 2 §2)', () => {
  it('no card help repeats the canonical mapper-authority / W3-log-only wording (it lives once in #camModeNote)', () => {
    const helps = cameraModeView({ requested: 'manual' }).modes.map((m) => m.help.toLowerCase());
    for (const help of helps) {
      // The shared facts are stated once, in the UI note — not per card.
      expect(help).not.toContain('log-only');
      expect(help).not.toContain('control authority');
      expect(help).not.toContain('not reported');
      // The Manual card no longer restates that the mapper is the authority.
      expect(help).not.toContain('the mapper is');
    }
  });

  it('each card keeps non-empty, distinct help', () => {
    const helps = cameraModeView({ requested: 'manual' }).modes.map((m) => m.help);
    expect(helps.every((h) => typeof h === 'string' && h.trim().length > 0)).toBe(true);
    expect(new Set(helps).size).toBe(helps.length); // distinct per card
  });

  it('leaves the head-tracking lock string untouched', () => {
    const ht = CAMERA_MODES.find((m) => m.key === 'headtrack');
    expect(ht.lock).toBe('LOCKED · SAFETY GATE NOT COMPLETE');
  });
});

describe('camera mode model — no control emission (task §4)', () => {
  it('never authorizes control emission, and exposes NO head-track armed flag', () => {
    for (const req of ['manual', 'headtrack', 'nonsense', undefined]) {
      const view = cameraModeView({ requested: req });
      expect(view.canEmitControl).toBe(false);
      // §1A: the fabricated-live-state property is gone entirely.
      expect('headtrackArmed' in view).toBe(false);
    }
  });
});
