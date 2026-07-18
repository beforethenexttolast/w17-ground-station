// Controller-driven UI navigation for the viewer's OWN interface (Batch 9).
//
// VIEWER-ONLY, NOT A CONTROL PATH. This module moves DOM focus among the app's
// own controls and clicks them — the same thing a keyboard user does with Tab +
// Enter. It reads navigator.getGamepads() (via an injected getPad) exactly the
// way the SEAT FIT live mirror already does, and it drives .focus()/.click() on
// existing elements. It never touches CRSF, servos, telemetry, the gimbal, or
// any car output; the forbidden serial/RC/head-tracking vocabulary the
// noControlPath sweep bans appears nowhere here. Button presses used for
// navigation still light the live input mirror — that mirror is a display of
// observed input and is deliberately not suppressed (task §5).
//
// The DOM focus/Tab order is the single source of truth: focusables() returns
// controls in document order, so gamepad navigation and keyboard parity are
// automatic — one moves the same focus the other does.
//
// Shape: a small stateful singleton (configured once by renderer/setupFlow.js,
// polled once per animation frame by renderer/hud.js's existing frame() tick)
// wrapping a core of PURE helpers (focusables / diffIntents / nextIndex) that
// are unit-tested directly.

// Standard-gamepad indices (mapping:'standard'): confirm=A(0), back=B(1),
// settings=Start/Options(9). D-pad up/down/left/right = 12/13/14/15. Left stick
// = axes 0 (x) and 1 (y).
//
// APPROVED DEVIATION (review triage 2026-07-17): back(1) closes the settings
// menu ONLY — it never steps the setup flow BACK. Button 1 is BOOST in every
// controller preset, so a mirror test press must not navigate; stepping BACK is
// done by d-pad-focusing the visible BACK button and pressing confirm(0), which
// collides with no preset role.
export const NAV_BUTTON = { confirm: 0, back: 1, settings: 9 };
export const DPAD = { up: 12, down: 13, left: 14, right: 15 };
export const STICK_AXIS = { x: 0, y: 1 };
export const AXIS_THRESHOLD = 0.5;

// Everything the browser treats as tabbable; tabindex="-1" is filtered out in
// navigable(). Order is document order (querySelectorAll), i.e. the Tab order.
//
// DEFERRAL (Batch 9 triage #6, durable in-code marker for finding 7): <select>
// and range/<input type=range> controls ARE reached by pad focus (they match the
// selector), but confirm cannot open a native <select> and d-pad left/right moves
// focus rather than stepping the value — so their VALUE is pad-inoperable. Affected
// today: #adapterSelect, #setTelemetrySource, #wheelDeadzone. Mouse/keyboard fully
// work. Candidate follow-up: left/right value-stepping while such a control holds
// pad focus. Recorded in-repo here (not only in the external plan).
const FOCUSABLE_SEL = 'a[href], button, input, select, textarea, summary, [tabindex]';

// A control is navigable only if it — and every ancestor up to the root — is
// visible and enabled. jsdom has no layout engine, so visibility is decided from
// classes/attributes the app actually uses to hide things (never offsetParent,
// which jsdom always reports null): the `.hidden` class, the `hidden` attribute,
// an inactive `.setup-screen` (shown only with `.active`), and `disabled`.
function navigable(elem, root) {
  if (!elem || elem.disabled) return false;
  if (typeof elem.getAttribute === 'function' && elem.getAttribute('tabindex') === '-1') return false;
  let n = elem;
  const stop = root.parentNode;
  while (n && n !== stop) {
    if (n.nodeType === 1) {
      if (n.classList && n.classList.contains('hidden')) return false;
      if (typeof n.hasAttribute === 'function' && n.hasAttribute('hidden')) return false;
      if (n.classList && n.classList.contains('setup-screen') && !n.classList.contains('active')) return false;
      if (n.disabled) return false;
    }
    n = n.parentNode;
  }
  return true;
}

// PURE: the navigable controls under `root`, in document (== Tab) order.
export function focusables(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  return [...root.querySelectorAll(FOCUSABLE_SEL)].filter((elem) => navigable(elem, root));
}

// PURE: wrap-around index step. cur < 0 (nothing focused yet) lands on the first
// element for 'next' and the last for 'prev'.
export function nextIndex(len, cur, dir) {
  if (len <= 0) return -1;
  if (cur < 0) return dir === 'prev' ? len - 1 : 0;
  return dir === 'next' ? (cur + 1) % len : (cur - 1 + len) % len;
}

// A stable, live-handle-free snapshot of the pad's buttons (pressed bools) and
// axes (numbers). A button is pressed if the browser says so OR its analog
// value clears 0.05 — the same predicate as pressedWheelRoles' PRESS_THRESHOLD
// (shared/wheelProfile.mjs), so analog-only buttons (wheel paddles, triggers)
// register for navigation exactly as they do for the mirror. (Missing pads
// never reach here — pollOnce resets to the unseeded state instead, see below.)
//
// DEFERRAL (Batch 9 triage, durable in-code marker for finding 7): this allocates
// two arrays per poll (once per rAF frame), and setupFlow's snapPad ≈ this
// snapshotPad while dedupeGamepads runs a few times a frame in wheel sessions.
// Acceptable allocation churn on desktop Electron; a follow-up could reuse buffers
// / share one snapshot. Recorded in-repo here (not only in the external plan).
function snapshotPad(pad) {
  if (!pad) return { buttons: [], axes: [] };
  return {
    buttons: (pad.buttons || []).map((b) => !!(b && (b.pressed || Number(b.value) > 0.05))),
    axes: (pad.axes || []).map((a) => Number(a) || 0),
  };
}

// PURE: edge/threshold-detect the navigation intents between two snapshots.
// Buttons fire on the press edge (pressed now, not before). Axis movement fires
// once when the stick crosses the threshold from a smaller magnitude, so holding
// the stick deflected does not auto-repeat and returning to centre re-arms it.
// Returns { move:'next'|'prev'|null, moveAxis, confirm, back, settings } —
// moveAxis marks a move that came from a stick/axis crossing (not the d-pad),
// so pollOnce can ignore axis moves while the user is typing in a text field.
export function diffIntents(prev, snap, { threshold = AXIS_THRESHOLD } = {}) {
  const pb = (prev && prev.buttons) || [];
  const cb = (snap && snap.buttons) || [];
  const pa = (prev && prev.axes) || [];
  const ca = (snap && snap.axes) || [];
  const edge = (i) => !!cb[i] && !pb[i];

  let move = null;
  let moveAxis = false;
  if (edge(DPAD.up) || edge(DPAD.left)) move = 'prev';
  else if (edge(DPAD.down) || edge(DPAD.right)) move = 'next';
  else {
    const cross = (pv, cv, sign) => (sign < 0
      ? (pv > -threshold && cv <= -threshold)
      : (pv < threshold && cv >= threshold));
    const px = pa[STICK_AXIS.x] || 0, cx = ca[STICK_AXIS.x] || 0;
    const py = pa[STICK_AXIS.y] || 0, cy = ca[STICK_AXIS.y] || 0;
    if (cross(py, cy, -1) || cross(px, cx, -1)) move = 'prev';
    else if (cross(py, cy, 1) || cross(px, cx, 1)) move = 'next';
    moveAxis = move !== null;
  }
  return {
    move,
    moveAxis,
    confirm: edge(NAV_BUTTON.confirm),
    back: edge(NAV_BUTTON.back),
    settings: edge(NAV_BUTTON.settings),
  };
}

// ---------- stateful singleton (wiring) ----------

let cfg = null;          // { getPad, getRoot, isSuspended, settingsOnly, toggleSettings, back }
let prevSnap = null;     // last snapshot for edge detection; null = unseeded
let focusEl = null;      // element currently carrying the pad focus ring
let listenersBound = false;

// The visible focus-ring class, applied by pad navigation and cleared as soon as
// the user touches the mouse or presses Tab (so it never sits stale next to a
// native keyboard/mouse focus). See .uinav-focus in renderer/hud.css.
const RING = 'uinav-focus';

export function clearFocusRing() {
  if (focusEl && focusEl.classList) focusEl.classList.remove(RING);
  focusEl = null;
}

function applyFocus(elem) {
  if (!elem) return;
  if (focusEl && focusEl !== elem && focusEl.classList) focusEl.classList.remove(RING);
  focusEl = elem;
  try { elem.focus(); } catch { /* focus is always safe here; guard for exotic hosts */ }
  if (typeof elem.scrollIntoView === 'function') elem.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (elem.classList) elem.classList.add(RING);
}

function currentRoot() {
  return (cfg && cfg.getRoot) ? cfg.getRoot() : (typeof document !== 'undefined' ? document.body : null);
}

// Move focus one step through the active root's Tab order. Starts from the
// current ring element, else whatever is natively focused, else the first/last.
function moveFocus(dir) {
  const root = currentRoot();
  const list = focusables(root);
  if (!list.length) return;
  let idx = list.indexOf(focusEl);
  if (idx === -1 && typeof document !== 'undefined') idx = list.indexOf(document.activeElement);
  applyFocus(list[nextIndex(list.length, idx, dir)]);
}

// Confirm: activate the focused control. With nothing focused yet, the first
// confirm just moves focus onto the first control (so a cold press is never a
// no-op), matching how a keyboard user Tabs before pressing Enter.
function activate() {
  const root = currentRoot();
  const list = focusables(root);
  if (!list.length) return;
  let target = (focusEl && list.includes(focusEl)) ? focusEl : null;
  if (!target && typeof document !== 'undefined' && list.includes(document.activeElement)) target = document.activeElement;
  if (!target) { moveFocus('next'); return; }
  applyFocus(target);
  if (typeof target.click === 'function') target.click();
}

function bindListeners() {
  if (listenersBound || typeof document === 'undefined') return;
  listenersBound = true;
  // A mouse click or a Tab press hands control back to native focus — drop the
  // pad ring so the two focus systems never show two rings at once.
  document.addEventListener('pointerdown', clearFocusRing, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Tab') clearFocusRing(); }, true);
}

// Configure (or reconfigure) the singleton. Resets edge/focus state so a fresh
// wiring — including a test's vi.resetModules reload — starts clean.
export function configure(options) {
  cfg = options || null;
  prevSnap = null;
  clearFocusRing();
  bindListeners();
}

// Typing guard (triage #7): while a text-entry element holds focus, stick/axis
// motion must not move focus away mid-word (a wheel pedal tap crosses the
// threshold easily). D-pad and buttons remain live — they are deliberate.
const TEXTLESS_INPUT = /^(checkbox|radio|range|button|submit|reset|color|file)$/i;
function isTextEntry(elem) {
  if (!elem) return false;
  if (elem.isContentEditable) return true;
  if (elem.tagName === 'TEXTAREA') return true;
  return elem.tagName === 'INPUT' && !TEXTLESS_INPUT.test(elem.type || 'text');
}

// One poll tick: read the pad, edge-detect intents, and apply exactly one.
//
// Edge baseline (triage #8): the FIRST snapshot after configure() — or after a
// pad disconnect (getPad() null resets to unseeded) — only seeds prevSnap;
// intents fire from the second poll on. A button held during boot, or a pedal
// axis resting at ±1 on reconnect, therefore never fires a phantom intent.
//
// Suspension (a wheel-mapping row LISTENING) hands every press/axis motion to
// that capture instead of moving focus — but prevSnap is still advanced so
// resuming does not replay a stale edge. settingsOnly (a live session with the
// settings menu closed) keeps ONLY the settings toggle live: driving inputs
// share the pad's buttons/axes, so focus moves, confirm, and back are inert
// until the menu is opened (triage #2). Precedence: settings toggle >
// settings-only gate > back/close > confirm > move.
export function pollOnce() {
  if (!cfg) return;
  const pad = cfg.getPad ? cfg.getPad() : null;
  if (!pad) { prevSnap = null; return; }
  const snap = snapshotPad(pad);
  if (!prevSnap) { prevSnap = snap; return; }
  const intents = diffIntents(prevSnap, snap);
  prevSnap = snap;
  if (cfg.isSuspended && cfg.isSuspended()) return;
  if (intents.settings) { clearFocusRing(); if (cfg.toggleSettings) cfg.toggleSettings(); return; }
  if (cfg.settingsOnly && cfg.settingsOnly()) return;
  if (intents.back) { clearFocusRing(); if (cfg.back) cfg.back(); return; }
  if (intents.confirm) { activate(); return; }
  if (intents.move) {
    if (intents.moveAxis && typeof document !== 'undefined' && isTextEntry(document.activeElement)) return;
    moveFocus(intents.move);
  }
}

// Test-only peek at the ring element (avoids exporting mutable state).
export function focusedElement() { return focusEl; }
