import { describe, it, expect } from 'vitest';
import { padPreviewSvg } from '../renderer/padPreview.js';
import { PRESETS } from '../shared/inputPresets.mjs';

// The SEAT FIT layout preview is DISPLAY / INPUT-MIRROR only. It now depicts BOTH
// sticks (left = steering, right = camera pan/tilt) — the authorized relaxation of
// the earlier depiction convention (docs/camera_aim_display_semantics.md §2.1).
// These tests pin the new boundary: the sticks are labelled as STICK INPUT (never
// as measured camera aim), the right stick starts neutral, and the *button
// mirror* seam (data-role) still admits exactly the seven buttons — the camera
// axes carry data-stick, never data-role, so they can never enter the
// press-mirror path. test/noControlPath.js separately proves the file adds no
// control path.

describe('padPreviewSvg', () => {
  it('renders every preset with its button names and mirrored roles', () => {
    for (const [key, preset] of Object.entries(PRESETS)) {
      const svg = padPreviewSvg(key);
      expect(svg, key).toContain('<svg');
      for (const name of Object.values(preset.buttonNames)) {
        expect(svg, `${key} shows ${name}`).toContain(`>${name}<`);
      }
      // Role labels present (STEERING satisfies the STEER check; the camera stick
      // adds PAN / TILT). OVERTAKE is abbreviated OT in the tight face cluster.
      for (const role of ['THROTTLE', 'BRAKE', 'STEER', 'DRS', 'BOOST', 'OT', 'GEAR', 'PAN', 'TILT']) {
        expect(svg, `${key} labels ${role}`).toContain(role);
      }
    }
  });

  it('carries a data-role hook for each mirrored BUTTON (live highlight) — exactly the seven, nothing more', () => {
    for (const key of Object.keys(PRESETS)) {
      const svg = padPreviewSvg(key);
      const roles = [...svg.matchAll(/data-role="([^"]+)"/g)].map((m) => m[1]);
      expect(roles.sort(), key).toEqual(
        ['boost', 'brake', 'drs', 'gearDown', 'gearUp', 'overtake', 'throttle'],
      );
      // The two stick dots carry data-stick (NOT data-role): the camera/steer
      // axes are excluded from the button press-mirror seam by construction.
      const sticks = [...svg.matchAll(/data-stick="([^"]+)"/g)].map((m) => m[1]);
      expect(sticks.sort(), key).toEqual(['left', 'right']);
      expect(svg, `${key} stick dots must not carry data-role`)
        .not.toMatch(/data-stick="[^"]+"[^>]*data-role|data-role="[^"]+"[^>]*data-stick/);
    }
  });

  it('depicts both sticks as STICK INPUT — never as measured camera aim (semantics §2.1)', () => {
    for (const key of Object.keys(PRESETS)) {
      const svg = padPreviewSvg(key);
      // Both sticks are drawn and labelled.
      expect(svg, `${key} draws the left stick`).toContain('data-stick="left"');
      expect(svg, `${key} draws the right stick`).toContain('data-stick="right"');
      expect(svg, `${key} labels the left stick`).toContain('LEFT STICK');
      expect(svg, `${key} labels the right stick`).toContain('RIGHT STICK');
      expect(svg, `${key} names the camera stick as input`).toContain('CAMERA · STICK INPUT');
      // A clear neutral centre marker for each well.
      expect((svg.match(/class="pp-neutral"/g) || []).length, `${key} neutral markers`).toBe(2);
      // The labelling rule (on the RENDERED text, comments stripped): it must NOT
      // claim measured aim / gimbal position.
      const lower = svg.replace(/<!--[\s\S]*?-->/g, '').toLowerCase();
      expect(lower, `${key} must not claim camera aim`).not.toContain('camera aim');
      expect(lower, `${key} must not claim measurement`).not.toContain('measured');
      expect(lower, `${key} must not claim gimbal`).not.toContain('gimbal');
    }
  });

  it('the right-stick live dot starts centred (neutral) — a first paint reads as no deflection', () => {
    const svg = padPreviewSvg('dualshock');
    const m = svg.match(/data-stick="right" data-cx="(\d+)" data-cy="(\d+)" cx="(\d+)" cy="(\d+)"/);
    expect(m, 'right dot has data-cx/cy + cx/cy').not.toBeNull();
    expect(m[3]).toBe(m[1]); // cx == data-cx
    expect(m[4]).toBe(m[2]); // cy == data-cy
  });

  it('escapes markup in button names (defense in depth for future presets)', () => {
    // esc() runs on every name; the current presets contain none, so assert the
    // output has no raw '<' outside tags by parsing shape: every '<' must start a
    // known element (now including <line> for the stick crosshairs).
    const svg = padPreviewSvg('generic');
    expect(svg.match(/<(?!\/?(svg|rect|circle|text|tspan|line)\b|!--)/g)).toBeNull();
  });
});
