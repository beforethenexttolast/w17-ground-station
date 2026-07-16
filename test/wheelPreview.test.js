import { describe, it, expect } from 'vitest';
import { wheelPreviewSvg } from '../renderer/wheelPreview.js';

// The SEAT FIT wheel viz is DISPLAY / INPUT-MIRROR only — the sibling of
// padPreview.js. These pin its live-update seam (data-wheel for steer/thr/brk,
// data-role for the button press mirror) and its display-semantics vocabulary:
// it shows observed INPUT and must never claim camera aim / a measured value /
// a gimbal position. test/noControlPath.js separately proves the file adds no
// control path.

describe('wheelPreviewSvg', () => {
  const svg = wheelPreviewSvg();

  it('renders an SVG with the compact wheel viewBox', () => {
    expect(svg).toContain('<svg');
    expect(svg).toContain('viewBox="0 0 260 214"');
  });

  it('carries the three live wheel hooks — steer needle + thr/brk pedal fills', () => {
    const hooks = [...svg.matchAll(/data-wheel="([^"]+)"/g)].map((m) => m[1]).sort();
    expect(hooks).toEqual(['brk', 'steer', 'thr']);
    // The steer needle carries its rotation pivot (data-cx/cy) and starts unrotated.
    expect(svg).toMatch(/data-wheel="steer"[^>]*data-cx="\d+"[^>]*data-cy="\d+"/);
    expect(svg).toMatch(/data-wheel="steer"[^>]*transform="rotate\(0 \d+ \d+\)"/);
    // Each pedal fill anchors at the bottom (data-y0) with a known travel height
    // (data-h) and starts empty (height 0) so a first paint reads as released.
    for (const key of ['thr', 'brk']) {
      const m = svg.match(new RegExp(`data-wheel="${key}"[^>]*data-y0="(\\d+)"[^>]*data-h="(\\d+)"[^>]*height="0"`));
      expect(m, `${key} fill has y0/h and starts empty`).not.toBeNull();
    }
  });

  it('carries a data-role hook for each mirrored BUTTON — exactly the five wheel roles', () => {
    const roles = [...svg.matchAll(/data-role="([^"]+)"/g)].map((m) => m[1]).sort();
    expect(roles).toEqual(['boost', 'drs', 'gearDown', 'gearUp', 'overtake']);
    // The steer/thr/brk axes carry data-wheel, NEVER data-role, so the analog
    // inputs can never enter the button press-mirror seam.
    expect(svg).not.toMatch(/data-wheel="[^"]+"[^>]*data-role|data-role="[^"]+"[^>]*data-wheel/);
  });

  it('labels the mirrored roles (gears, DRS, boost, overtake, plus STEER/THR/BRK)', () => {
    for (const label of ['STEER', 'THR', 'BRK', 'DRS', 'BOOST', 'OT']) {
      expect(svg, `labels ${label}`).toContain(label);
    }
    // GEAR up/down use ▲/▼ entities like the pad preview shoulder pills.
    expect(svg).toContain('GEAR &#9650;');
    expect(svg).toContain('GEAR &#9660;');
  });

  it('is display-semantics clean: observed INPUT, never aim/measured/gimbal', () => {
    expect(svg).toContain('OBSERVED WHEEL INPUT');
    const lower = svg.replace(/<!--[\s\S]*?-->/g, '').toLowerCase();
    expect(lower, 'must not claim camera aim').not.toContain('camera aim');
    expect(lower, 'must not claim a measured value').not.toContain('measured');
    expect(lower, 'must not claim a gimbal position').not.toContain('gimbal');
  });

  it('produces well-formed markup — no raw "<" outside a known element', () => {
    // Every "<" must open a known SVG element (or an XML comment); the entities
    // (&#9650; etc.) are already escaped literals.
    expect(svg.match(/<(?!\/?(svg|rect|circle|text|tspan|line)\b|!--)/g)).toBeNull();
  });
});
