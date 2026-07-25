import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

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

// Structural half of the contract. Three of the four rules pinned in the
// "e01eb9f / e09369b layout rules" block below are MARKUP facts (which parent an
// element hangs off, sibling order, which class a section carries) that no amount
// of CSS-string matching can prove. JSDOM parses the real index.html so those are
// asserted against the actual tree — a moved <div> fails here, not silently ship.
//
// JSDOM is constructed EXPLICITLY rather than by switching this file to the jsdom
// test environment via a docblock: that keeps the 22 pre-existing CSS-string tests
// on the cheap node environment, and keeps `import.meta.url` a real file: URL (the
// jsdom environment breaks the readFileSync(new URL(…)) calls above). NB vitest
// scans this file for the environment-docblock token, so do not write that token
// in a comment here — it switches the environment even from inside prose.
const doc = new JSDOM(readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8')).window.document;

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
    // Bottom padding is DERIVED from the pinned radio band it must clear at max
    // scroll (Batch 8a.1 rider b) — it reserves --gate-toast-reserve (radio offset
    // + the height-capped 2-toast stack + clearance) instead of the old magic 7em,
    // which still let the camera-note tail sit ~26px under a full 3-toast stack at
    // the 1024×640 floor. The reserve + the cap are pinned in the Batch 8a.1 block.
    expect(gate).toMatch(/padding:[^;]*clamp\(\s*var\(--gate-toast-reserve\)/);
  });

  it('the radio overlay is a position:fixed viewport overlay, not a scroll-flow child (Batch 2 §3)', () => {
    // As position:absolute children of the scrollable .gate, a tall SEAT FIT that
    // scrolled would carry these toasts up into the content band. position:fixed
    // pins them to the viewport so they stay clear of the scrolling content.
    // (The viewer-only footnote overlay was removed 2026-07-20.)
    expect(rule('.radioLog')).toMatch(/position:\s*fixed/);
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

describe('flow chrome — radio-stack height cap + derived gate reserve (Batch 8a.1)', () => {
  it('caps the visible radio stack to 2 toasts below ~700px viewport height (rider a)', () => {
    // Height-GATED, not always-on: only below 700px is the oldest toast hidden, so
    // the two design targets (1280×800 / 1366×768) keep the full 3-toast stack.
    // column-reverse puts the newest toast first, so :nth-child(n+3) is the OLDEST
    // (top of the band) — hiding it frees the ~26px that closed the floor overlap.
    expect(css).toMatch(/@media\s*\(\s*max-height:\s*700px\s*\)/);
    expect(css).toMatch(/\.radioLog\s+\.radio-msg:nth-child\(\s*n\+3\s*\)\s*\{\s*display:\s*none/);
  });

  it('the gate bottom reserve is DERIVED from the (capped) radio band, not a magic number (rider b)', () => {
    const root = rule(':root');
    // The band components the reserve is built from — a change to either moves the
    // padding with it (offset from the floor + the 2-toast stack the cap leaves).
    expect(root).toMatch(/--radio-bottom:/);
    expect(root).toMatch(/--radio-2stack:/);
    // reserve = radio offset + the capped 2-toast stack + a small clearance …
    expect(root).toMatch(/--gate-toast-reserve:\s*calc\(\s*var\(--radio-bottom\)\s*\+\s*var\(--radio-2stack\)/);
    // … and the gate consumes exactly that as its bottom padding.
    expect(rule('.gate')).toMatch(/padding:[^;]*var\(--gate-toast-reserve\)/);
  });
});

// The four layout rules shipped by e01eb9f / e09369b, which went in with NO test
// (2026-07-25 follow-up). This repo has already been bitten by the gap they left:
// 085e1d1 shipped BOTH-mode source tags as `.barsrc hidden` while hud.css had no
// generic `.hidden` rule, so the tags leaked into single-mirror modes AND the
// jsdom class-only assertions passed vacuously. Hence: assert the RESOLVED
// contract — the real parent, the real sibling order, the declaration that makes
// a class do something — never just that a class name appears somewhere.
describe('HUD + setup layout rules from e01eb9f / e09369b', () => {
  it('.revwrap is centred on the VIEWPORT: an absolute direct child of .hud, not flexed inside .top', () => {
    // Inside the .top flex row the strip was pushed off-centre by the
    // RUSSELL-plate and clock-stack widths and by .top's right inset (which
    // reserves the ⚙ column). Both halves matter, so both are pinned:
    // (a) MARKUP — the parent really is .hud (the full-viewport layer).
    const revwrap = doc.querySelector('.revwrap');
    expect(revwrap, '.revwrap must exist in index.html').not.toBeNull();
    expect(revwrap.parentElement.classList.contains('hud')).toBe(true);
    expect(revwrap.closest('.top'), '.revwrap must NOT be inside the ⚙-inset .top row').toBeNull();
    // (b) CSS — and it is absolutely centred on that layer, level with the driver
    // plate (same top margin as .top, i.e. var(--gap)).
    const rw = rule('.revwrap');
    expect(rw).toMatch(/position:\s*absolute/);
    expect(rw).toMatch(/left:\s*50%/);
    expect(rw).toMatch(/top:\s*var\(--gap\)/);
    expect(rw).toMatch(/transform:\s*translateX\(\s*-50%\s*\)/);
    expect(rw).not.toMatch(/align-self:\s*center/); // the old in-.top centring
    // The parent must be the positioning context, else left:50% resolves against
    // the wrong box; .hud is position:fixed;inset:0 = the viewport.
    expect(rule('.hud')).toMatch(/position:\s*fixed/);
  });

  it('the right HUD column puts BATT above the single merged BOOST/OVERTAKE/DRS pill row', () => {
    // PROVISIONAL ORDER. 05-hud.html in w17-design-system orders the right column
    // pills -> ERS -> BATT (BATT last); shipping BATT first is a deliberate
    // deviation still pending a w17-design-system §11 amendment (prompt 7 owns
    // that repo). If the owner flips it back, invert the `<` below to `>` — that
    // one-line change is the whole cost, and it is meant to be that cheap.
    const right = doc.querySelector('.bottom .right');
    expect(right, '.bottom .right must exist').not.toBeNull();
    const kids = [...right.children];
    const battIdx = kids.findIndex((k) => k.id === 'battRow');
    const pillIdx = kids.findIndex((k) => k.classList.contains('pillrow'));
    expect(battIdx, '#battRow must be a direct child of .right').toBeGreaterThanOrEqual(0);
    expect(pillIdx, '.pillrow must be a direct child of .right').toBeGreaterThanOrEqual(0);
    expect(battIdx).toBeLessThan(pillIdx); // BATT above the pills (flip to > on a deliberate reversal)
    // ONE merged pill row, not two: BOOST + OVERTAKE + DRS on a single line
    // (design bundle §11 / 05-hud.html). Two rows again = this fails.
    const pillRows = right.querySelectorAll('.pillrow');
    expect(pillRows.length).toBe(1);
    expect([...pillRows[0].children].map((c) => c.id)).toEqual(['boost', 'ot', 'drs']);
    // .right is a column flex, so DOM order IS visual order — without this the
    // sibling assertion above would prove nothing about what the operator sees.
    expect(rule('.right')).toMatch(/flex-direction:\s*column/);
  });

  it('GRID carries `wide`, and `wide` really does widen the screen cap', () => {
    // Class-name-only would be the vacuous assertion 085e1d1 warned about, so
    // pin both: the section carries it, AND .setup-screen.wide resolves to a
    // LARGER max-width than the base .setup-screen (which is what lets the
    // START / START ANYWAY row fit on one line).
    const grid = doc.querySelector('.setup-screen[data-step="grid"]');
    expect(grid, 'the GRID setup screen must exist').not.toBeNull();
    expect(grid.classList.contains('wide')).toBe(true);
    const wide = rule('.setup-screen.wide');
    expect(wide).toMatch(/max-width:\s*min\(\s*1340px\s*,\s*94vw\s*\)/);
    expect(rule('.setup-screen')).toMatch(/max-width:\s*min\(\s*82ch\s*,\s*92vw\s*\)/); // the narrower base it overrides
    // The button row is what needed the width; it must still wrap, so a long
    // label can never force horizontal overflow at the 1024px floor.
    expect(rule('.gridbtns')).toMatch(/flex-wrap:\s*wrap/);
  });

  it('#addrStatus:empty collapses the reserved CHECK-result row (dead space above the PIT WALL note)', () => {
    // #addrStatus is a .netstatus, whose min-height reserves a row so a CHECK
    // result appearing cannot shove the note below it — but that reserve left
    // ~37px of dead space before any check ran. The :empty override collapses it
    // ONLY while the line has no text, so the reserve is still there for the
    // state it exists for. Both halves are the contract:
    expect(rule('.netstatus')).toMatch(/min-height:\s*1\.2em/);        // the reserve …
    expect(rule('#addrStatus:empty')).toMatch(/min-height:\s*0/);      // … collapsed only when empty
    // :empty, not .hidden or a JS class — setupFlow.js only ever writes
    // addrStatus.textContent, so emptiness is the state that actually tracks
    // "no result yet"; a class would need a second thing to stay in sync.
    expect(css).toMatch(/#addrStatus:empty\s*\{/);
    // And it must be an empty ELEMENT in the shipped markup, else the override
    // never applies on a fresh PIT WALL.
    const addrStatus = doc.getElementById('addrStatus');
    expect(addrStatus, '#addrStatus must exist').not.toBeNull();
    expect(addrStatus.textContent).toBe('');
    expect(addrStatus.children.length).toBe(0); // :empty is false with ANY child node
  });
});

// SETUP opts OUT of the two-column split (owner decision, 2026-07-25). Measured
// on the real renderer at the four audit sizes: CAMERA MODE ran 2.98–3.30 : 1
// taller than DRIVE MODE, and at 1024×640 the left column ended at 41.8% while the
// right ran to 71.6% — ~191px of dead left column. Stacking costs vertical space
// (the gate now scrolls 30/72/95px at 1280×800 / 1366×768 / 1024×640) which the
// owner accepted: .gate already scrolls by design, no content is clipped, and the
// overflow is the fixed radio band's RESERVE, not content — nav bottom stays at
// 95.8% of the viewport worst-case and nothing intersects the band.
describe('SETUP is one centred column, not a split (owner decision 2026-07-25)', () => {
  const setupSection = () => doc.querySelector('section.setup-screen[data-step="setup"]');

  it('the SETUP grid is forced to ONE track, capped readable and never wider than its container', () => {
    // min(100%,56ch) — NOT minmax(0,56ch): the track must yield to a narrow
    // container instead of overflowing it, and NOT repeat(auto-fit,…), which is
    // exactly the two-column behaviour being opted out of.
    const stack = rule('.cols.stack');
    expect(stack).toMatch(/grid-template-columns:\s*min\(\s*100%\s*,\s*56ch\s*\)/);
    expect(stack).not.toMatch(/auto-fit|auto-fill/);
    expect(stack).not.toMatch(/minmax\(\s*0/); // would overflow a sub-56ch container
    // 56ch matches the cap the split columns already hit, so stacking does not
    // also re-wrap the prose (measured: track stayed 408.6px before and after).
    expect(rule('.cols')).toMatch(/56ch/);
  });

  it('the SETUP section CARRIES .cols.stack and has DROPPED .wide (markup, not just CSS)', () => {
    const sec = setupSection();
    expect(sec, 'section[data-step="setup"] must exist in index.html').not.toBeNull();
    const grid = sec.querySelector('.cols');
    expect(grid, 'SETUP must still use the .cols grid').not.toBeNull();
    expect(grid.classList.contains('stack'), 'SETUP .cols must carry .stack').toBe(true);
    // A lone 56ch track no longer earns the 1340px wide section.
    expect(sec.classList.contains('wide'), 'SETUP must NOT be .wide any more').toBe(false);
  });

  it('SEAT FIT keeps its split — it is NOT the screen with the imbalance', () => {
    // DESIGN_NOTES.md §14(b) put CAMERA MODE in a right column to balance SEAT
    // FIT, and the original premise was INVERTED: SEAT FIT's right column is not
    // empty (LIVE MIRROR fills it) and it is the TALLER column at 1.31–1.38 : 1.
    // Stacking SEAT FIT too would be the wrong fix, so pin that it stays split.
    const seatfit = doc.querySelector('section.setup-screen[data-step="seatfit"]');
    expect(seatfit, 'section[data-step="seatfit"] must exist').not.toBeNull();
    const grid = seatfit.querySelector('.cols');
    expect(grid).not.toBeNull();
    expect(grid.classList.contains('stack'), 'SEAT FIT must stay two-column').toBe(false);
    expect(grid.classList.contains('seatcols')).toBe(true);
  });

  it('stacking did not orphan the DRIVE MODE handler or the CAMERA MODE id lookups', () => {
    // The two JS contracts a markup move could silently break: the click handler
    // is DELEGATED on #driveModeRow and bound once at module load, and
    // renderCameraMode() resolves #camModes / #camAuthority BY ID. Both must
    // still live inside the SETUP section, in DRIVE-then-CAMERA order.
    const sec = setupSection();
    const driveRow = sec.querySelector('#driveModeRow');
    const camModes = sec.querySelector('#camModes');
    const camAuth = sec.querySelector('#camAuthority');
    expect(driveRow, '#driveModeRow must still be inside the SETUP section').not.toBeNull();
    expect(camModes, '#camModes must still be inside the SETUP section').not.toBeNull();
    expect(camAuth, '#camAuthority must still be inside the SETUP section').not.toBeNull();
    // ids the JS looks up must be unique document-wide, else getElementById wins
    // the wrong one after a copy/paste move.
    for (const id of ['driveModeRow', 'camModes', 'camAuthority']) {
      expect(doc.querySelectorAll(`#${id}`).length, `#${id} must be unique`).toBe(1);
    }
    // The delegated handler reads e.target.dataset.drive, so the pills must be
    // DESCENDANTS of the delegating row (not siblings moved out beside it).
    expect(driveRow.querySelectorAll('.pill[data-drive]').length).toBe(3);
    // Document order: DRIVE MODE stacks ABOVE CAMERA MODE.
    expect(driveRow.compareDocumentPosition(camModes) & 4 /* FOLLOWING */).toBeTruthy();
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
