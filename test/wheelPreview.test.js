import { describe, it, expect } from 'vitest';
import { wheelPreviewSvg } from '../renderer/wheelPreview.js';
import { WHEEL_BUTTON_LABELS } from '../shared/wheelProfile.mjs';

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

  it('labels the mirrored roles (STEER/THR/BRK) and uses the SHARED button labels (rider b)', () => {
    for (const label of ['STEER', 'THR', 'BRK']) {
      expect(svg, `labels ${label}`).toContain(label);
    }
    // The button pills render EXACTLY the shared WHEEL_BUTTON_LABELS map — the same
    // one the SEAT FIT assign panel uses — so the panel and this picture can never
    // drift. Literal glyphs (▲/▼), not HTML entities.
    for (const label of Object.values(WHEEL_BUTTON_LABELS)) {
      expect(svg, `pills render shared label ${label}`).toContain(`>${label}</text>`);
    }
    expect(svg).toContain('GEAR ▲');
    expect(svg).toContain('GEAR ▼');
  });

  it('is display-semantics clean: observed INPUT, never aim/measured/gimbal', () => {
    expect(svg).toContain('OBSERVED WHEEL INPUT');
    const lower = svg.replace(/<!--[\s\S]*?-->/g, '').toLowerCase();
    expect(lower, 'must not claim camera aim').not.toContain('camera aim');
    expect(lower, 'must not claim a measured value').not.toContain('measured');
    expect(lower, 'must not claim a gimbal position').not.toContain('gimbal');
  });

  it('produces well-formed markup — no raw "<" outside a known element', () => {
    // Every "<" must open a known SVG element (or an XML comment); the button
    // labels are literal Unicode glyphs (▲/▼), which carry no "<".
    expect(svg.match(/<(?!\/?(svg|rect|circle|text|tspan|line)\b|!--)/g)).toBeNull();
  });
});
