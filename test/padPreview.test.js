import { describe, it, expect } from 'vitest';
import { padPreviewSvg } from '../renderer/padPreview.js';
import { PRESETS } from '../shared/inputPresets.mjs';

// The SEAT FIT layout preview is informational only. Beyond checking that it
// shows the right names, this pins the safety boundary: the preview must not
// grow a camera / pan-tilt depiction (that mapping is out of this app's
// authority and a right-stick drawing would be its first foothold).

describe('padPreviewSvg', () => {
  it('renders every preset with its button names and mirrored roles', () => {
    for (const [key, preset] of Object.entries(PRESETS)) {
      const svg = padPreviewSvg(key);
      expect(svg, key).toContain('<svg');
      for (const name of Object.values(preset.buttonNames)) {
        expect(svg, `${key} shows ${name}`).toContain(`>${name}<`);
      }
      for (const role of ['THROTTLE', 'BRAKE', 'STEER', 'DRS', 'BOOST', 'OVERTAKE', 'GEAR']) {
        expect(svg, `${key} labels ${role}`).toContain(role);
      }
    }
  });

  it('carries a data-role hook for each mirrored button (live highlight), nothing more', () => {
    for (const key of Object.keys(PRESETS)) {
      const svg = padPreviewSvg(key);
      const roles = [...svg.matchAll(/data-role="([^"]+)"/g)].map((m) => m[1]);
      expect(roles.sort(), key).toEqual(
        ['boost', 'brake', 'drs', 'gearDown', 'gearUp', 'overtake', 'throttle'],
      );
      // The left stick and the dim placeholder circle stay role-less.
      expect(svg, key).toContain('<circle class="pp-ctl" cx="110"');
      expect(svg, key).toContain('<circle class="pp-ctl dim"');
    }
  });

  it('never depicts the right stick or camera/pan/tilt (safety boundary)', () => {
    for (const key of Object.keys(PRESETS)) {
      const svg = padPreviewSvg(key).toLowerCase();
      expect(svg, key).not.toContain('right stick');
      // Word-bounded so e.g. <tspan> does not false-positive on "pan".
      expect(svg, `${key} must not mention pan/tilt/cam/gimbal`)
        .not.toMatch(/\b(pan|tilt|cam|camera|gimbal)\b/);
    }
  });

  it('escapes markup in button names (defense in depth for future presets)', () => {
    // esc() runs on every name; the current presets contain none, so assert
    // the output has no raw '<' outside tags by parsing shape: every '<' must
    // start a known element.
    const svg = padPreviewSvg('generic');
    expect(svg.match(/<(?!\/?(svg|rect|circle|text|tspan)\b|!--)/g)).toBeNull();
  });
});
