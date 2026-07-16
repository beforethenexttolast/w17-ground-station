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
    // Bottom padding reserves a band deep enough to clear a full 3-toast radio
    // stack + the footnote so neither can cover START/BACK/NEXT (Batch 2 §3).
    // Batch 4 (P4) raised the floor 5.5em → 7em: the measured worst case (a tall
    // SEAT FIT with a full 3-toast stack) scrolled the camera-note tail ~17px
    // under the radio band at 5.5em; 7em brings that to 0px at both target sizes.
    expect(gate).toMatch(/padding:[^;]*clamp\(7em/);
  });

  it('the radio + footnote overlays are position:fixed viewport overlays, not scroll-flow children (Batch 2 §3)', () => {
    // As position:absolute children of the scrollable .gate, a tall SEAT FIT that
    // scrolled would carry these toasts up into the content band. position:fixed
    // pins them to the viewport so they stay clear of the scrolling content.
    expect(rule('.radioLog')).toMatch(/position:\s*fixed/);
    expect(rule('.keys.footnote')).toMatch(/position:\s*fixed/);
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

  it('.cols caps columns at a readable width (not 1fr edge-to-edge) and centers the track pair (Batch 1 / P3)', () => {
    const cols = rule('.cols');
    // 34ch floor keeps the auto-fit collapse; a 56ch (not 1fr) ceiling caps the
    // readable width so PIT WALL / SEAT FIT columns follow the centered rhythm
    // of the single-column GARAGE/GRID steps.
    expect(cols).toMatch(/grid-template-columns:\s*repeat\(\s*auto-fit\s*,\s*minmax\(\s*min\(\s*100%\s*,\s*34ch\s*\)\s*,\s*56ch\s*\)\s*\)/);
    expect(cols).not.toMatch(/minmax\([^)]*1fr\s*\)/); // no edge-to-edge track
    expect(cols).toMatch(/justify-content:\s*center/); // track pair centered as a unit
  });

  it('the camera section, preview and device list are fluid (fit their column)', () => {
    expect(rule('.cammodes')).toMatch(/width:\s*100%/);
    expect(rule('.padpreview')).toMatch(/max-width:\s*min\([^)]*(?:vw|px)/);
    expect(rule('.padlist')).toMatch(/width:\s*100%/);
  });

  it('the pad preview and test strip share the aligned ≈420px block cap (Batch 3 / P2)', () => {
    // The redesigned, compact pad viz and the test strip beneath it cap at the
    // same width so they render as one aligned block (≈420×191) instead of the
    // old oversized min(560px,90vw). Pinned so the pair can't drift apart.
    expect(rule('.padpreview')).toMatch(/max-width:\s*min\(\s*420px\s*,\s*100%\s*\)/);
    expect(rule('.teststrip')).toMatch(/max-width:\s*min\(\s*420px\s*,\s*100%\s*\)/);
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

  it('the start button caps at its row width and wraps its label (Batch 4 / P4)', () => {
    // On the smallest target the START / START ANYWAY button must never push past
    // its (wrapping) action row: max-width:100% caps it and white-space:normal
    // lets a long label wrap instead of forcing horizontal overflow.
    const sb = rule('.startbtn');
    expect(sb).toMatch(/max-width:\s*100%/);
    expect(sb).toMatch(/white-space:\s*normal/);
    expect(sb).not.toMatch(/white-space:\s*nowrap/);
  });

  it('the GARAGE mode cards and the LAYOUT preset pills wrap', () => {
    expect(rule('.modecards')).toMatch(/flex-wrap:\s*wrap/);
    expect(rule('.presetrow')).toMatch(/flex-wrap:\s*wrap/);
  });

  it('the IPHONE LINK row is full-width + left-anchored so a CHECK result never re-centers it (Batch 1 / P3)', () => {
    // .addrrow spans the full column, so its start edge is fixed regardless of
    // line-1 content width; the shared input-row rule aligns items to the start
    // (never center, which shifts the row when a status/summary line grows).
    expect(rule('.addrrow')).toMatch(/width:\s*100%/);
    const rowRule = css.match(/\.netjoinrow,\.addrrow,\.hsrow\s*\{([^}]*)\}/);
    expect(rowRule, 'shared input-row rule (.netjoinrow,.addrrow,.hsrow)').toBeTruthy();
    expect(rowRule[1]).toMatch(/justify-content:\s*flex-start/);
    expect(rowRule[1]).not.toMatch(/justify-content:\s*center/);
  });
});

describe('responsive layout — wheel panel + viz fit their column (Batch 6 / P5b)', () => {
  it('the INPUT TYPE pills and the wheel assign rows wrap', () => {
    expect(rule('.inputtyperow')).toMatch(/flex-wrap:\s*wrap/);
    expect(rule('.wheelrow')).toMatch(/flex-wrap:\s*wrap/);
  });

  it('the wheel viz is fluid with a readable cap (like the pad preview)', () => {
    const wp = rule('.wheelpreview');
    expect(wp).toMatch(/width:\s*100%/);
    expect(wp).toMatch(/max-width:\s*min\([^)]*(?:px|vw)/);
  });

  it('the deadzone range fills its row and can shrink (min-width:0) so it never overflows', () => {
    const dz = rule('.wheeldz input[type=range]');
    expect(dz).toMatch(/flex:\s*1/);
    expect(dz).toMatch(/min-width:\s*0/);
  });
});

describe('flow chrome — step rail + solid backdrop (Batch 8a)', () => {
  it('the step rail wraps and centers so all four steps stay on-screen at the target sizes', () => {
    const rail = rule('.steprail');
    expect(rail).toMatch(/flex-wrap:\s*wrap/);
    expect(rail).toMatch(/justify-content:\s*center/);
  });

  it('the rail step label keeps a readable clamp floor', () => {
    expect(clampMin(rule('.railstep'))).toBeGreaterThanOrEqual(9);
  });

  it('the setup backdrop is fully opaque so the live HUD no longer bleeds through (design §1)', () => {
    // The first .gate rule carries the background (the second is only the fade
    // transition). Both radial stops must be opaque — no sub-1 alpha that would
    // let the HUD show through the setup overlay.
    const gate = rule('.gate');
    expect(gate).toMatch(/radial-gradient/);
    expect(gate).toMatch(/rgba\(7,\s*12,\s*13,\s*1\)/);
    expect(gate).toMatch(/rgba\(2,\s*4,\s*4,\s*1\)/);
    expect(gate).not.toMatch(/rgba\([^)]*,\s*\.\d+\)/); // no translucent stop remains
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
