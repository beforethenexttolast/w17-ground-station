// The B1 quit policy (main/quitPolicy.js, decision Q1) over the REAL
// lifecycle + manager with a routed fake runner and injected dialog/quit
// fakes — no Electron needed. Pins: dialog only for an app-OWNED hotspot,
// the three-button semantics, stop-before-quit, failed-stop-keeps-app-open,
// deterministic repeated quits, quits during STARTING/STOPPING, and the
// no-recursion guarantee.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { HotspotManager } = require('../main/hotspot.js');
const { HotspotLifecycle } = require('../main/hotspotLifecycle.js');
const {
  createQuitPolicy, QUIT_BUTTONS, GIFTEE_QUIT_BUTTONS, MAPPER_QUIT_BUTTONS,
} = require('../main/quitPolicy.js');

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const ok = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '' });
const fail = (stderr = 'boom', stdout = '') => ({ ok: false, code: 1, stdout, stderr });

function fakeRun(routes) {
  const calls = [];
  const run = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const key = `${cmd} ${args.join(' ')}`;
    for (const [needle, handler] of Object.entries(routes)) {
      if (key.includes(needle)) {
        return typeof handler === 'function' ? handler({ cmd, args, opts }) : handler;
      }
    }
    return fail(`unrouted: ${key.slice(0, 80)}`);
  };
  return { run, calls };
}

const PS_START_KEY = 'StartTetheringAsync';
const PS_STOP_KEY = 'StopTetheringAsync';
const MOBILE_OK_ROUTES = {
  PROBE_OK: ok('PROBE_STATE_Off\nPROBE_OK'),
  'wlan show drivers': ok(fixture('netsh_drivers_en.txt')),
  [PS_START_KEY]: ok('START_OK'),
  [PS_STOP_KEY]: ok('STOP_OK'),
};
const CREDS = { ssid: 'W17-GRID', password: 'lights0ut!' };

const STOP_AND_QUIT = 0;
const LEAVE_RUNNING = 1;
const CANCEL = 2;

// One quit-policy world: real lifecycle over routed manager, scripted dialog
// answers, spies on everything. flush() drains the policy's promise chains.
function build(routes, { responses = [], mapperAlive, allowLeaveHotspot = true } = {}) {
  const { run, calls } = fakeRun(routes);
  const manager = new HotspotManager({ run, platform: 'win32' });
  const lifecycle = new HotspotLifecycle({ manager });
  const dialogs = [];
  let pendingDialog = null;
  const showDialog = vi.fn(async (opts) => {
    dialogs.push(opts);
    if (pendingDialog) return pendingDialog; // manually released dialog
    return { response: responses.shift() };
  });
  const showError = vi.fn();
  const quit = vi.fn();
  const decisions = [];
  const policy = createQuitPolicy({
    lifecycle, mapperAlive, showDialog, showError, quit,
    onDecision: (action) => decisions.push(action),
    allowLeaveHotspot,
  });
  const quitEvent = () => {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    policy.onBeforeQuit(event);
    return event;
  };
  const flush = async (n = 6) => { for (let i = 0; i < n; i += 1) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };
  return {
    lifecycle, manager, calls, policy, quitEvent, flush,
    showDialog, showError, quit, dialogs, decisions,
    holdDialog: () => { let release; pendingDialog = new Promise((r) => { release = (response) => r({ response }); }); return release; },
  };
}

describe('quit policy (audit B1, decision Q1)', () => {
  it('INACTIVE hotspot: quit passes through — no preventDefault, no dialog', async () => {
    const w = build(MOBILE_OK_ROUTES);
    const event = w.quitEvent();
    await w.flush();
    expect(event.prevented).toBe(false);
    expect(w.showDialog).not.toHaveBeenCalled();
    expect(w.quit).not.toHaveBeenCalled(); // Electron's own quit continues; the policy never re-quits
  });

  it('EXTERNALLY started hotspot (already-on failure recorded, not owned): still no dialog', async () => {
    const w = build({ ...MOBILE_OK_ROUTES, [PS_START_KEY]: ok('START_ALREADY_ON') });
    await w.lifecycle.start(CREDS); // fails already-on; nothing owned
    await w.lifecycle.probe();      // probe also sees a hotspot; still not ours
    const event = w.quitEvent();
    await w.flush();
    expect(event.prevented).toBe(false);
    expect(w.showDialog).not.toHaveBeenCalled();
  });

  it('app-OWNED live hotspot: quit is intercepted and the three-button dialog appears once', async () => {
    const w = build(MOBILE_OK_ROUTES, { responses: [CANCEL] });
    await w.lifecycle.start(CREDS);
    const event = w.quitEvent();
    await w.flush();
    expect(event.prevented).toBe(true);
    expect(w.showDialog).toHaveBeenCalledTimes(1);
    expect(w.dialogs[0].buttons).toEqual([...QUIT_BUTTONS]);
    expect(w.dialogs[0].detail).toContain('W17-GRID');
    expect(w.dialogs[0].detail).not.toContain(CREDS.password);
  });

  it('STOP HOTSPOT AND QUIT: waits for the stop to succeed, then quits; next before-quit passes through', async () => {
    const w = build(MOBILE_OK_ROUTES, { responses: [STOP_AND_QUIT] });
    await w.lifecycle.start(CREDS);
    w.quitEvent();
    await w.flush();
    expect(w.lifecycle.snapshot()).toMatchObject({ phase: 'inactive', owned: false }); // stopped BEFORE quitting
    expect(w.quit).toHaveBeenCalledTimes(1);
    const second = w.quitEvent(); // the re-issued quit sails through
    expect(second.prevented).toBe(false);
  });

  it('failed stop during quit: app stays open, actionable error shown, ownership retained, later quit re-asks', async () => {
    const w = build(
      { ...MOBILE_OK_ROUTES, [PS_STOP_KEY]: fail('winrt stop threw') },
      { responses: [STOP_AND_QUIT, CANCEL] },
    );
    await w.lifecycle.start(CREDS);
    w.quitEvent();
    await w.flush();
    expect(w.quit).not.toHaveBeenCalled(); // matrix row: failed stop during quit -> owned, app open
    expect(w.showError).toHaveBeenCalledTimes(1);
    const [title, message] = w.showError.mock.calls[0];
    expect(`${title} ${message}`).toMatch(/stop failed|could not be stopped/i);
    expect(`${title} ${message}`).toContain('STOP HOTSPOT');       // actionable
    expect(`${title} ${message}`).not.toContain(CREDS.password);   // credential-free
    expect(w.lifecycle.snapshot()).toMatchObject({ phase: 'live', owned: true });
    // A later quit is a fresh decision (asked again, user cancels).
    const again = w.quitEvent();
    await w.flush();
    expect(again.prevented).toBe(true);
    expect(w.showDialog).toHaveBeenCalledTimes(2);
  });

  it('LEAVE HOTSPOT RUNNING: quits without stopping — the hotspot stays active and owned', async () => {
    const w = build(MOBILE_OK_ROUTES, { responses: [LEAVE_RUNNING] });
    await w.lifecycle.start(CREDS);
    w.quitEvent();
    await w.flush();
    expect(w.quit).toHaveBeenCalledTimes(1);
    expect(w.manager.active()).toBe('mobile'); // matrix row: hotspot remains active; process exits
    expect(w.calls.filter((c) => c.args.join(' ').includes(PS_STOP_KEY))).toHaveLength(0);
  });

  it('CANCEL: nothing quits, nothing stops, state unchanged; a later quit asks again', async () => {
    const w = build(MOBILE_OK_ROUTES, { responses: [CANCEL, CANCEL] });
    await w.lifecycle.start(CREDS);
    const snapBefore = w.lifecycle.snapshot();
    w.quitEvent();
    await w.flush();
    expect(w.quit).not.toHaveBeenCalled();
    expect(w.lifecycle.snapshot()).toEqual(snapBefore); // matrix row: unchanged
    w.quitEvent();
    await w.flush();
    expect(w.showDialog).toHaveBeenCalledTimes(2);
  });

  it('repeated quit requests while the dialog is open are absorbed: one dialog, one decision', async () => {
    const w = build(MOBILE_OK_ROUTES);
    await w.lifecycle.start(CREDS);
    const release = w.holdDialog();
    const e1 = w.quitEvent();
    await w.flush();
    const e2 = w.quitEvent(); // user mashes quit while the dialog is up
    const e3 = w.quitEvent();
    expect(e1.prevented && e2.prevented && e3.prevented).toBe(true);
    expect(w.showDialog).toHaveBeenCalledTimes(1);
    release(LEAVE_RUNNING);
    await w.flush();
    expect(w.quit).toHaveBeenCalledTimes(1);
  });

  it('quit during STARTING that ends LIVE: waits for the transition, then asks', async () => {
    let releaseStart;
    const gate = new Promise((r) => { releaseStart = r; });
    const w = build(
      { ...MOBILE_OK_ROUTES, [PS_START_KEY]: async () => { await gate; return ok('START_OK'); } },
      { responses: [LEAVE_RUNNING] },
    );
    const starting = w.lifecycle.start(CREDS);
    const event = w.quitEvent();
    expect(event.prevented).toBe(true); // held even before ownership exists
    await w.flush();
    expect(w.showDialog).not.toHaveBeenCalled(); // still settling
    releaseStart();
    await starting;
    await w.flush();
    expect(w.showDialog).toHaveBeenCalledTimes(1); // settled LIVE -> owned -> ask
    expect(w.quit).toHaveBeenCalledTimes(1);
  });

  it('quit during STARTING that FAILS: settles un-owned and quits with no dialog', async () => {
    let releaseStart;
    const gate = new Promise((r) => { releaseStart = r; });
    const w = build({
      ...MOBILE_OK_ROUTES,
      'wlan show drivers': ok('    Hosted network supported  : No'),
      [PS_START_KEY]: async () => { await gate; return ok('START_FAILED_Unknown nope'); },
    });
    const starting = w.lifecycle.start(CREDS);
    w.quitEvent();
    releaseStart();
    await starting;
    await w.flush();
    expect(w.showDialog).not.toHaveBeenCalled();
    expect(w.quit).toHaveBeenCalledTimes(1);
  });

  it('quit during STOPPING: a stop that succeeds quits silently; one that fails asks', async () => {
    // Success case.
    let releaseStop;
    const gate = new Promise((r) => { releaseStop = r; });
    const w = build({
      ...MOBILE_OK_ROUTES,
      [PS_STOP_KEY]: async () => { await gate; return ok('STOP_OK'); },
    });
    await w.lifecycle.start(CREDS);
    const stopping = w.lifecycle.stop();
    const event = w.quitEvent();
    expect(event.prevented).toBe(true);
    releaseStop();
    await stopping;
    await w.flush();
    expect(w.showDialog).not.toHaveBeenCalled();
    expect(w.quit).toHaveBeenCalledTimes(1);
    // Failure case: the settled state is still owned -> dialog.
    let releaseStop2;
    const gate2 = new Promise((r) => { releaseStop2 = r; });
    const w2 = build(
      { ...MOBILE_OK_ROUTES, [PS_STOP_KEY]: async () => { await gate2; return fail('nope'); } },
      { responses: [CANCEL] },
    );
    await w2.lifecycle.start(CREDS);
    const stopping2 = w2.lifecycle.stop();
    w2.quitEvent();
    releaseStop2();
    await stopping2;
    await w2.flush();
    expect(w2.showDialog).toHaveBeenCalledTimes(1);
    expect(w2.quit).not.toHaveBeenCalled();
  });

  it('no recursive quit loop: the policy-issued quit() re-enters before-quit and passes straight through', async () => {
    const w = build(MOBILE_OK_ROUTES, { responses: [LEAVE_RUNNING] });
    await w.lifecycle.start(CREDS);
    // Make quit() re-fire before-quit synchronously, like Electron would.
    const reEntries = [];
    w.quit.mockImplementation(() => {
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      w.policy.onBeforeQuit(event);
      reEntries.push(event.prevented);
    });
    w.quitEvent();
    await w.flush();
    expect(w.quit).toHaveBeenCalledTimes(1);   // exactly one re-quit, no loop
    expect(reEntries).toEqual([false]);        // the re-entry was NOT intercepted
    expect(w.showDialog).toHaveBeenCalledTimes(1);
  });

  it('a crashing dialog does not make the app unquittable', async () => {
    const w = build(MOBILE_OK_ROUTES);
    await w.lifecycle.start(CREDS);
    w.showDialog.mockImplementation(async () => { throw new Error('dialog backend gone'); });
    w.quitEvent();
    await w.flush();
    expect(w.quit).toHaveBeenCalledTimes(1); // fail-open for quit, hotspot left as-is
  });
});

// Race-day honesty (micro-backlog 2026-08-20): quitting while race day's
// MANAGED drive program is alive must SAY the quit stops it — teardown kills
// that child unconditionally, so a silent quit would misrepresent what the
// button does. Pins: the two-button dialog, its giftee wording (no "mapper"),
// mapper-prompt-before-hotspot-prompt ordering (CANCEL stays side-effect
// free), the no-mapper path unchanged, and fail-open on a broken seam.
describe('quit policy — race-day managed drive program', () => {
  const MAPPER_QUIT = 0;
  const MAPPER_CANCEL = 1;

  it('managed drive program alive, no hotspot: quit is intercepted and the two-button dialog appears', async () => {
    const w = build(MOBILE_OK_ROUTES, { mapperAlive: () => true, responses: [MAPPER_QUIT] });
    const event = w.quitEvent();
    await w.flush();
    expect(event.prevented).toBe(true);
    expect(w.showDialog).toHaveBeenCalledTimes(1);
    expect(w.dialogs[0].buttons).toEqual([...MAPPER_QUIT_BUTTONS]);
    // Giftee wording bar (shared/raceDayView.mjs): "the drive program", never
    // the component name — and the copy states the consequence honestly.
    const copy = `${w.dialogs[0].message} ${w.dialogs[0].detail}`;
    expect(copy).toContain('drive program');
    expect(copy).not.toMatch(/mapper/i);
    expect(copy).toMatch(/stops it|will be stopped/i);
    expect(w.quit).toHaveBeenCalledTimes(1); // QUIT proceeds; teardown does the stop
    const second = w.quitEvent(); // the re-issued quit sails through
    expect(second.prevented).toBe(false);
  });

  it('CANCEL: nothing quits, nothing is stopped, and a later quit asks again', async () => {
    const w = build(MOBILE_OK_ROUTES, { mapperAlive: () => true, responses: [MAPPER_CANCEL, MAPPER_CANCEL] });
    w.quitEvent();
    await w.flush();
    expect(w.quit).not.toHaveBeenCalled();
    w.quitEvent();
    await w.flush();
    expect(w.showDialog).toHaveBeenCalledTimes(2); // fresh decision, asked again
  });

  it('drive program AND owned hotspot: the side-effect-free prompt comes first, then the hotspot one', async () => {
    const w = build(MOBILE_OK_ROUTES, {
      mapperAlive: () => true,
      responses: [MAPPER_QUIT, LEAVE_RUNNING],
    });
    await w.lifecycle.start(CREDS);
    w.quitEvent();
    await w.flush();
    expect(w.showDialog).toHaveBeenCalledTimes(2);
    expect(w.dialogs[0].buttons).toEqual([...MAPPER_QUIT_BUTTONS]); // mapper asked FIRST
    expect(w.dialogs[1].buttons).toEqual([...QUIT_BUTTONS]);
    expect(w.quit).toHaveBeenCalledTimes(1);
  });

  it('CANCEL at the drive-program prompt skips the hotspot dialog entirely — no side effects at all', async () => {
    const w = build(MOBILE_OK_ROUTES, { mapperAlive: () => true, responses: [MAPPER_CANCEL] });
    await w.lifecycle.start(CREDS);
    const snapBefore = w.lifecycle.snapshot();
    w.quitEvent();
    await w.flush();
    expect(w.showDialog).toHaveBeenCalledTimes(1); // hotspot never asked
    expect(w.quit).not.toHaveBeenCalled();
    expect(w.lifecycle.snapshot()).toEqual(snapBefore); // hotspot untouched
    expect(w.calls.filter((c) => c.args.join(' ').includes(PS_STOP_KEY))).toHaveLength(0);
  });

  it('a child that exits between before-quit and the decision raises no stale prompt', async () => {
    let alive = true;
    const w = build(MOBILE_OK_ROUTES, { mapperAlive: () => alive });
    const event = w.quitEvent(); // intercepted on the alive snapshot
    expect(event.prevented).toBe(true);
    alive = false; // the managed child died while the quit was in flight
    await w.flush();
    expect(w.showDialog).not.toHaveBeenCalled();
    expect(w.quit).toHaveBeenCalledTimes(1);
  });

  it('no managed drive program: quit passes through with no dialog (unchanged behavior)', async () => {
    const w = build(MOBILE_OK_ROUTES, { mapperAlive: () => false });
    const event = w.quitEvent();
    await w.flush();
    expect(event.prevented).toBe(false);
    expect(w.showDialog).not.toHaveBeenCalled();
  });

  it('a throwing aliveness seam fails open: reads as not-alive, the app stays quittable', async () => {
    const w = build(MOBILE_OK_ROUTES, { mapperAlive: () => { throw new Error('orchestrator gone'); } });
    const event = w.quitEvent();
    await w.flush();
    expect(event.prevented).toBe(false); // treated as no managed child
    expect(w.showDialog).not.toHaveBeenCalled();
  });
});

// --- OD-7: LEAVE HOTSPOT RUNNING is not offered to the giftee --------------
// That button is what manufactures the already-on hotspot the booklet's only
// printed recovery then trips over, and the operator model has no use for it.
describe('quit policy — the giftee hotspot prompt (owner decision OD-7)', () => {
  it('offers TWO buttons, and CANCEL is still the cancel', async () => {
    const w = build(MOBILE_OK_ROUTES, { allowLeaveHotspot: false, responses: [1] });
    await w.lifecycle.start(CREDS);
    w.quitEvent();
    await w.flush();
    expect(w.dialogs[0].buttons).toEqual([...GIFTEE_QUIT_BUTTONS]);
    expect(w.dialogs[0].buttons).not.toContain('LEAVE HOTSPOT RUNNING');
    // Index 1 is CANCEL in the two-button set — the answer is read against the
    // array that was SHOWN, never the three-button constant.
    expect(w.quit).not.toHaveBeenCalled();
    expect(w.dialogs[0].cancelId).toBe(1);
    expect(w.dialogs[0].defaultId).toBe(0);
    expect(w.dialogs[0].detail).not.toMatch(/leave it broadcasting/i);
  });

  it('STOP AND QUIT still stops the hotspot first, then quits', async () => {
    const w = build(MOBILE_OK_ROUTES, { allowLeaveHotspot: false, responses: [0] });
    await w.lifecycle.start(CREDS);
    w.quitEvent();
    await w.flush();
    expect(w.calls.filter((c) => c.args.join(' ').includes(PS_STOP_KEY))).toHaveLength(1);
    expect(w.quit).toHaveBeenCalledTimes(1);
  });

  it('a development build keeps all three buttons', async () => {
    const w = build(MOBILE_OK_ROUTES, { responses: [LEAVE_RUNNING] });
    await w.lifecycle.start(CREDS);
    w.quitEvent();
    await w.flush();
    expect(w.dialogs[0].buttons).toEqual([...QUIT_BUTTONS]);
    expect(w.quit).toHaveBeenCalledTimes(1);
    expect(w.calls.filter((c) => c.args.join(' ').includes(PS_STOP_KEY))).toHaveLength(0);
  });
});

// --- SYN-1 / lifecycle-concurrency-4: the decision is now OBSERVED ---------
describe('quit policy — the decision hook the window lifecycle rides on', () => {
  it('a pass-through quit (nothing owned) still reports "quit" — otherwise the close interceptor never disarms', async () => {
    const w = build(MOBILE_OK_ROUTES);
    const e = w.quitEvent();
    await w.flush();
    expect(e.prevented).toBe(false);
    expect(w.decisions).toEqual(['quit']);
  });

  it('CANCEL reports "stay", so a window destroyed underneath can be put back', async () => {
    const w = build(MOBILE_OK_ROUTES, { responses: [CANCEL] });
    await w.lifecycle.start(CREDS);
    w.quitEvent();
    await w.flush();
    expect(w.decisions).toEqual(['stay']);
    expect(w.quit).not.toHaveBeenCalled();
  });

  it('a failed hotspot stop reports "stay" too (the app deliberately stays open)', async () => {
    const w = build({ ...MOBILE_OK_ROUTES, [PS_STOP_KEY]: fail('nope') }, { responses: [STOP_AND_QUIT] });
    await w.lifecycle.start(CREDS);
    w.quitEvent();
    await w.flush();
    expect(w.decisions).toEqual(['stay']);
    expect(w.showError).toHaveBeenCalledTimes(1);
  });

  it('a throwing observer neither blocks the quit nor wedges the app', async () => {
    const { run } = fakeRun(MOBILE_OK_ROUTES);
    const manager = new HotspotManager({ run, platform: 'win32' });
    const lifecycle = new HotspotLifecycle({ manager });
    const quit = vi.fn();
    const policy = createQuitPolicy({
      lifecycle,
      showDialog: vi.fn(),
      showError: vi.fn(),
      quit,
      onDecision: () => { throw new Error('observer exploded'); },
    });
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    policy.onBeforeQuit(event);
    expect(event.prevented).toBe(false);
  });

  it('a drive program started DURING the hotspot prompt is asked about before teardown kills it (lifecycle-concurrency-4)', async () => {
    let alive = false;
    const w = build(MOBILE_OK_ROUTES, { mapperAlive: () => alive });
    await w.lifecycle.start(CREDS);
    // The held dialog answers every prompt with the SAME response, which is all
    // this scenario needs: 1 = LEAVE HOTSPOT RUNNING on the hotspot prompt, and
    // 1 = CANCEL on the drive-program prompt that must now follow it.
    const release = w.holdDialog();
    w.quitEvent();
    await w.flush();
    expect(w.dialogs).toHaveLength(1); // only the hotspot has been asked about
    // The hotspot dialog is open; the renderer is alive underneath (it was not
    // even window-modal before this branch) and race day starts the drive
    // program — the exact window this fix closes.
    alive = true;
    release(1);
    await w.flush();
    expect(w.dialogs).toHaveLength(2);
    expect(w.dialogs[1].buttons).toEqual([...MAPPER_QUIT_BUTTONS]);
    // CANCEL on that prompt: the program the operator just started is NOT
    // killed by teardown behind their back.
    expect(w.decisions).toEqual(['stay']);
    expect(w.quit).not.toHaveBeenCalled();
  });

  it('a drive program that was ALREADY asked about is not asked twice', async () => {
    const w = build(MOBILE_OK_ROUTES, {
      mapperAlive: () => true,
      responses: [0 /* mapper: QUIT AND STOP */, LEAVE_RUNNING],
    });
    await w.lifecycle.start(CREDS);
    w.quitEvent();
    await w.flush();
    expect(w.dialogs).toHaveLength(2); // mapper, then hotspot — and no third
    expect(w.quit).toHaveBeenCalledTimes(1);
  });
});
