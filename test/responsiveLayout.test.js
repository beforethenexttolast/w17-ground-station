import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Responsive-layout CONTRACT tests (task Phase 3). jsdom has no layout engine, so
// these cannot prove *physical* non-overlap at a given pixel size — visual
// viewport validation at 1920×1080 / 1600×900 / 1366×768 / 1280×720 remains a
// MANUAL step on Windows (see docs/camera_aim_display_semantics.md §5 and the
// Windows handoff prompt). What they DO pin is that the responsive affordances
// the setup screens rely on are present and cannot silently regress:
//   - the setup overlay SCROLLS instead of clipping on short viewports;
//   - widths are fluid (fill the window, cap for readability) not fixed columns;
//   - the multi-column step collapses via auto-fit, with no hard pixel breakpoint;
//   - action rows WRAP so START / START ANYWAY / CHANGE SETUP / BACK / NEXT never
//     collide;
//   - font floors stay readable at the smallest target;
//   - nothing globally scales the page (which would make text unreadable).

const css = readFileSync(new URL('../renderer/hud.css', import.meta.url), 'utf8');

// Body of an EXACT selector rule (hud.css is one-selector-per-rule). The trailing
// `\s*\{` guards against a prefix match (`.gate` must not match `.gatehead`).
function rule(sel) {
  const re = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const m = css.match(re);
  if (!m) throw new Error(`no CSS rule found for "${sel}"`);
  return m[1];
}
const clampMin = (decl) => {
  const m = decl.match(/font-size:\s*clamp\(\s*(\d+(?:\.\d+)?)px/);
  return m ? Number(m[1]) : null;
};

describe('responsive layout — setup overlay scrolls, never clips (Phase 3)', () => {
  it('.gate scrolls on short viewports and top-aligns when content overflows', () => {
    const gate = rule('.gate');
    expect(gate).toMatch(/overflow-y:\s*auto/);          // 1280×720 etc.: scroll, not clip
    expect(gate).toMatch(/justify-content:\s*safe center/); // centre when it fits, top when not
    // Generous bottom padding reserves space so the pinned footnote / radio
    // overlays never cover START/BACK/NEXT.
    expect(gate).toMatch(/padding:[^;]*clamp\(4/);
  });
});

describe('responsive layout — fluid widths, no fixed columns (Phase 3)', () => {
  it('.setup-screen fills the window with a readable cap (not a narrow fixed column)', () => {
    const ss = rule('.setup-screen');
    expect(ss).toMatch(/width:\s*100%/);
    expect(ss).toMatch(/max-width:\s*min\([^)]*vw/); // caps against the viewport width
  });

  it('.cols is an auto-fit grid that collapses to one column — no hard pixel breakpoint', () => {
    const cols = rule('.cols');
    expect(cols).toMatch(/grid-template-columns:\s*repeat\(\s*auto-fit/);
    // No @media pixel breakpoint drives the SEAT FIT / PIT WALL column collapse.
    expect(css).not.toMatch(/@media[^{]*max-width:\s*\d+px[^{]*\{[^}]*\.cols\b/);
  });

  it('the camera section, preview and device list are fluid (fit their column)', () => {
    expect(rule('.cammodes')).toMatch(/width:\s*100%/);
    expect(rule('.padpreview')).toMatch(/max-width:\s*min\([^)]*(?:vw|px)/);
    expect(rule('.padlist')).toMatch(/width:\s*100%/);
  });
});

describe('responsive layout — action rows wrap, never overlap (Phase 3)', () => {
  it('the primary action row (START / START ANYWAY / CHANGE SETUP) wraps with spacing', () => {
    const g = rule('.gridbtns');
    expect(g).toMatch(/flex-wrap:\s*wrap/);
    expect(g).toMatch(/gap:/);
  });

  it('BACK / NEXT keep clear spacing', () => {
    expect(rule('.setup-nav')).toMatch(/gap:/);
  });

  it('the GARAGE mode cards and the LAYOUT preset pills wrap', () => {
    expect(rule('.modecards')).toMatch(/flex-wrap:\s*wrap/);
    expect(rule('.presetrow')).toMatch(/flex-wrap:\s*wrap/);
  });
});

describe('responsive layout — readable at the smallest target (Phase 3)', () => {
  it('body/help/status/step text keep a readable clamp floor', () => {
    expect(clampMin(rule('.hint'))).toBeGreaterThanOrEqual(11);
    expect(clampMin(rule('.checkrow'))).toBeGreaterThanOrEqual(11);
    expect(clampMin(rule('.stepname'))).toBeGreaterThanOrEqual(12);
    expect(clampMin(rule('.camhelp'))).toBeGreaterThanOrEqual(10);
  });

  it('nothing globally scales the page (no zoom / transform:scale that would shrink text)', () => {
    expect(css).not.toMatch(/\bzoom\s*:/i);
    expect(rule('body')).not.toMatch(/transform:\s*scale|zoom/);
  });
});
