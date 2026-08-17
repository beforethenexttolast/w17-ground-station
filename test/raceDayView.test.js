import { describe, it, expect } from 'vitest';
import {
  raceDayStepLines, raceDayHeadline, raceDayControls, RACE_DAY_STEP_LABELS,
} from '../shared/raceDayView.mjs';

const snap = (steps, { running = false, mapper = { running: false } } = {}) => ({
  seq: 1, running, steps, mapper,
});
const step = (id, status, kind = null) => ({ id, status, kind });

// Every (status, kind) pair the orchestrator can actually emit — kept in sync
// by the sweep test below feeding ALL of them through the view.
const EMITTABLE = {
  hotspot: {
    idle: [null],
    pending: [null],
    running: ['starting', 'checking'],
    ok: ['verified', 'unverified'],
    skipped: ['own-wifi'],
    fail: ['start-failed', 'degraded', 'busy', 'unexpected'],
  },
  mapper: {
    idle: [null],
    pending: [null],
    running: ['starting'],
    ok: ['running', 'already-running', 'external'],
    skipped: [],
    fail: ['not-configured', 'no-profile', 'bad-profile-path', 'profile-not-found',
      'not-found', 'spawn-failed', 'exited', 'unexpected'],
  },
  bridge: {
    idle: [null],
    pending: [null],
    running: ['applying'],
    ok: ['on'],
    skipped: ['desktop-session', 'off-by-choice'],
    fail: ['no-address', 'forced-off', 'apply-failed', 'unexpected'],
  },
};

describe('raceDayStepLines — plain giftee language (the GRID-hint wording bar)', () => {
  it('labels never name components: the mapper is only ever the DRIVE PROGRAM', () => {
    expect(RACE_DAY_STEP_LABELS).toEqual({
      hotspot: 'CAR WI-FI',
      mapper: 'DRIVE PROGRAM',
      bridge: 'PHONE LINK',
    });
  });

  it('every failure line says what happened AND what to do (pinned strings — the wording is the deliverable)', () => {
    const lines = raceDayStepLines(snap([
      step('hotspot', 'fail', 'start-failed'),
      step('mapper', 'fail', 'not-configured'),
      step('bridge', 'fail', 'no-address'),
    ]));
    expect(lines[0].text).toBe('the car Wi-Fi did not switch on — open PIT WALL to see why, or use your home Wi-Fi');
    expect(lines[1].text).toBe('its location is not set — set it once in ⚙ (RACE DAY)');
    expect(lines[2].text).toBe("the phone's address is not saved — run setup once with the phone connected");
    for (const l of lines) expect(l.tone).toBe('fail');
  });

  it('the happy-path lines are pinned too', () => {
    const lines = raceDayStepLines(snap([
      step('hotspot', 'ok', 'verified'),
      step('mapper', 'ok', 'running'),
      step('bridge', 'ok', 'on'),
    ]));
    expect(lines.map((l) => l.text)).toEqual(['on and ready', 'running', 'on — pick up the phone']);
    expect(lines.every((l) => l.tone === 'ok')).toBe(true);
  });

  it('skips are stated, not blank: own Wi-Fi, desktop session, ⚙ choice', () => {
    const lines = raceDayStepLines(snap([
      step('hotspot', 'skipped', 'own-wifi'),
      step('bridge', 'skipped', 'desktop-session'),
      step('bridge', 'skipped', 'off-by-choice'),
    ]));
    expect(lines[0].text).toBe('using your own Wi-Fi — nothing to switch on');
    expect(lines[1].text).toBe('desktop session — the phone is not used');
    expect(lines[2].text).toBe('switched off in ⚙');
    expect(lines.every((l) => l.tone === 'muted')).toBe(true);
  });

  it('macOS-dev honesty: a live-but-unverifiable hotspot is ok but SAYS it could not be double-checked', () => {
    const [l] = raceDayStepLines(snap([step('hotspot', 'ok', 'unverified')]));
    expect(l.tone).toBe('ok');
    expect(l.text).toBe('on (could not double-check on this computer)');
  });

  it('a crash of the drive program leads with what to do', () => {
    const [l] = raceDayStepLines(snap([step('mapper', 'fail', 'exited')]));
    expect(l.text).toBe('stopped on its own — press RACE DAY to bring it back');
  });

  it('an instance running OUTSIDE race day is stated as such, green, not claimed as ours (review minor 5)', () => {
    const [l] = raceDayStepLines(snap([step('mapper', 'ok', 'external')]));
    expect(l.tone).toBe('ok');
    expect(l.text).toBe('already running (started outside RACE DAY)');
  });

  it('NO line leaks hobbyist vocabulary, over EVERY emittable status/kind pair', () => {
    // The exact jargon ban the GRID hints hold (test/checklist.test.js),
    // plus the mapper-vocabulary words this card must never teach a giftee.
    const jargon = /mediamtx|webrtc|h\.?264|whep|rtsp|\bcom\s?\d|\bcom port|\belrs\b|joystick-control|docs\/|\.md\b|crsf|\bmapper\b|\budp\b|\bgrpc\b|\bargv\b|\bspawn\b/i;
    for (const [id, byStatus] of Object.entries(EMITTABLE)) {
      for (const [status, kinds] of Object.entries(byStatus)) {
        for (const kind of kinds.length ? kinds : [null]) {
          const [line] = raceDayStepLines(snap([step(id, status, kind)]));
          expect(line.text, `${id}/${status}/${kind}`).not.toMatch(jargon);
          expect(line.label, `${id} label`).not.toMatch(jargon);
          expect(line.text.length, `${id}/${status}/${kind} must say something`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('failure lines keep the "what\'s wrong — what to do" em-dash shape', () => {
    for (const [id, byStatus] of Object.entries(EMITTABLE)) {
      for (const kind of byStatus.fail) {
        const [line] = raceDayStepLines(snap([step(id, 'fail', kind)]));
        expect(line.text, `${id}/fail/${kind}`).toContain(' — ');
      }
    }
  });

  it('an unknown kind from a newer main process degrades to the honest generic, never a blank row', () => {
    const [line] = raceDayStepLines(snap([step('mapper', 'fail', 'kind-from-the-future')]));
    expect(line.text).toBe('something went wrong here — press RACE DAY to try again');
    expect(raceDayStepLines(null)).toEqual([]);
    expect(raceDayStepLines({})).toEqual([]);
  });
});

describe('raceDayHeadline / raceDayControls', () => {
  const allIdle = [step('hotspot', 'idle'), step('mapper', 'idle'), step('bridge', 'idle')];
  const allOk = [step('hotspot', 'ok', 'verified'), step('mapper', 'ok', 'running'), step('bridge', 'skipped', 'desktop-session')];

  it('idle card makes no claim; running / fail / up each get one honest line', () => {
    expect(raceDayHeadline(snap(allIdle))).toBeNull();
    expect(raceDayHeadline(snap(allIdle, { running: true }))).toEqual({ text: 'BRINGING EVERYTHING UP…', tone: 'run' });
    expect(raceDayHeadline(snap([...allOk.slice(0, 2), step('bridge', 'fail', 'no-address')])))
      .toEqual({ text: 'SOMETHING NEEDS ATTENTION — see below', tone: 'fail' });
    expect(raceDayHeadline(snap(allOk)))
      .toEqual({ text: 'EVERYTHING IS UP — STRAIGHT TO THE GRID when ready', tone: 'ok' });
    expect(raceDayHeadline(null)).toBeNull();
  });

  it('START disables only while the bring-up runs; STOP shows only with a managed drive program alive', () => {
    expect(raceDayControls(snap(allIdle))).toEqual({ startDisabled: false, stopVisible: false });
    expect(raceDayControls(snap(allIdle, { running: true }))).toEqual({ startDisabled: true, stopVisible: false });
    expect(raceDayControls(snap(allOk, { mapper: { running: true } })))
      .toEqual({ startDisabled: false, stopVisible: true });
    expect(raceDayControls(snap(allOk, { running: true, mapper: { running: true } })))
      .toEqual({ startDisabled: true, stopVisible: false });
    expect(raceDayControls(null)).toEqual({ startDisabled: false, stopVisible: false });
  });
});
