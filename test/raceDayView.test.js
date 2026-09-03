import { describe, it, expect } from 'vitest';
import {
  raceDayStepLines, raceDayHeadline, raceDayControls, raceDayMapperMessage,
  raceDayDriveAlarm, raceDaySettingsNote, RACE_DAY_STEP_LABELS,
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
    ok: ['verified', 'unverified', 'external'],
    skipped: ['own-wifi'],
    fail: ['start-failed', 'other-hotspot', 'already-on-unknown', 'degraded', 'busy', 'unexpected'],
  },
  mapper: {
    idle: [null],
    pending: [null],
    running: ['starting'],
    ok: ['running', 'already-running', 'external', 'link-unknown'],
    skipped: [],
    fail: ['not-configured', 'no-profile', 'bad-profile-path', 'profile-not-found',
      'not-found', 'spawn-failed', 'link-down', 'exited', 'exited-with-message',
      'stop-failed', 'unexpected'],
  },
  telemetry: {
    idle: [null],
    pending: [null],
    running: ['selecting', 'waiting'],
    ok: ['live', 'waiting'],
    skipped: ['own-source', 'held-off', 'unavailable'],
    fail: ['unexpected'],
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
      telemetry: 'CAR READINGS',
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

  it('a hotspot already on under the saved name is green and says so (OD-7)', () => {
    const [l] = raceDayStepLines(snap([step('hotspot', 'ok', 'external')]));
    expect(l.tone).toBe('ok');
    expect(l.text).toBe('already on — using it');
  });

  it("someone else's hotspot names the remedy, and an unreadable one does not pretend", () => {
    const [a] = raceDayStepLines(snap([step('hotspot', 'fail', 'other-hotspot')]));
    expect(a.text).toBe('a different Wi-Fi hotspot is already on — switch it off in Windows settings, then press RACE DAY again');
    const [b] = raceDayStepLines(snap([step('hotspot', 'fail', 'already-on-unknown')]));
    expect(b.text).toBe('a Wi-Fi hotspot is already on and this computer cannot tell which one — switch it off in Windows settings, then press RACE DAY again');
  });

  it('a crash of the drive program leads with what to do', () => {
    const [l] = raceDayStepLines(snap([step('mapper', 'fail', 'exited')]));
    expect(l.text).toBe('stopped on its own — press RACE DAY to bring it back');
  });

  it('a death the program EXPLAINED points at its own words, never at a retry loop', () => {
    // The drive program refuses a controller setup whose per-computer values
    // are unfilled: it says so and stops. "press RACE DAY to bring it back"
    // would be a loop that can never succeed, so this line differs on purpose.
    const [l] = raceDayStepLines(snap([step('mapper', 'fail', 'exited-with-message')]));
    expect(l.text).toBe('stopped on its own and said why — read the line below, then fix it in ⚙ (RACE DAY)');
  });

  it('a stop that did not take says the program is STILL RUNNING (review correctness-5)', () => {
    const [l] = raceDayStepLines(snap([step('mapper', 'fail', 'stop-failed')]));
    expect(l.text).toBe('it would not stop when asked and is still running — close the app and open it again');
    expect(l.tone).toBe('fail');
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

// The one row on the card whose words the ground station did NOT choose: the
// drive program's own last sentence, quoted. main/mapperRunner.js cleans and
// caps it; this view only decides whether it is shown and how it is framed.
describe('raceDayMapperMessage — the child\'s own last words', () => {
  const withMapper = (mapper) => ({ seq: 1, running: false, steps: [], mapper });

  it('is shown, labelled as a quotation, when the program died explaining itself', () => {
    const said = raceDayMapperMessage(withMapper({
      running: false,
      exitMessage: 'this saved profile has not been matched to this computer yet',
    }));
    expect(said).toEqual({
      label: 'IT SAID',
      text: 'this saved profile has not been matched to this computer yet',
      tone: 'fail',
    });
  });

  it('is absent for a stop we asked for, an empty message, or a snapshot without one', () => {
    expect(raceDayMapperMessage(withMapper({ running: true, exitMessage: null }))).toBeNull();
    expect(raceDayMapperMessage(withMapper({ running: false, exitMessage: '   ' }))).toBeNull();
    expect(raceDayMapperMessage(withMapper({ running: false }))).toBeNull();
    expect(raceDayMapperMessage({ seq: 1, steps: [] })).toBeNull();
    expect(raceDayMapperMessage(null)).toBeNull();
  });

  it('a non-string message is refused rather than rendered (a hostile/odd snapshot draws nothing)', () => {
    expect(raceDayMapperMessage(withMapper({ exitMessage: { toString: () => 'x' } }))).toBeNull();
    expect(raceDayMapperMessage(withMapper({ exitMessage: 42 }))).toBeNull();
  });
});

// Review giftee-ux-5. Once the gate is hidden the card is off-screen, so this
// is the ONLY line that can tell the operator the car stopped being driven.
describe('raceDayDriveAlarm — the live-HUD line for a drive program that died', () => {
  const withMapper = (status, kind) => ({
    seq: 1, running: false, mapper: {},
    steps: [step('hotspot', 'ok', 'verified'), step('mapper', status, kind), step('bridge', 'ok', 'on')],
  });

  it('a dead drive program says she is not being driven, and what to press', () => {
    for (const kind of ['exited', 'exited-with-message', 'spawn-failed', 'not-configured']) {
      const alarm = raceDayDriveAlarm(withMapper('fail', kind));
      expect(alarm, kind).toEqual({
        text: 'DRIVE PROGRAM STOPPED — she is not being driven. Open ⚙ and press RACE DAY again',
        tone: 'fail',
      });
    }
  });

  it('a dead RADIO names the cable instead — the program is fine, the signal is not', () => {
    expect(raceDayDriveAlarm(withMapper('fail', 'link-down'))).toEqual({
      text: 'THE RADIO STOPPED — she is not being driven. Check the cable to the little radio box, then ⚙ → RACE DAY',
      tone: 'fail',
    });
  });

  it('a STOP the operator asked for raises nothing — that belongs on the card they are looking at', () => {
    expect(raceDayDriveAlarm(withMapper('fail', 'stop-failed'))).toBeNull();
  });

  it('a healthy, idle, or unknown snapshot raises nothing', () => {
    expect(raceDayDriveAlarm(withMapper('ok', 'running'))).toBeNull();
    expect(raceDayDriveAlarm(withMapper('ok', 'link-unknown'))).toBeNull();
    expect(raceDayDriveAlarm(withMapper('idle', null))).toBeNull();
    expect(raceDayDriveAlarm(withMapper('running', 'starting'))).toBeNull();
    expect(raceDayDriveAlarm({ seq: 1, steps: [] })).toBeNull();
    expect(raceDayDriveAlarm(null)).toBeNull();
  });

  it('the alarm never teaches hobbyist vocabulary either', () => {
    const jargon = /mediamtx|webrtc|whep|rtsp|\bcom\s?\d|\belrs\b|crsf|\bmapper\b|\budp\b|\bgrpc\b/i;
    for (const kind of ['exited', 'link-down', 'spawn-failed']) {
      expect(raceDayDriveAlarm(withMapper('fail', kind)).text, kind).not.toMatch(jargon);
    }
  });
});

// Owner decision OD-19: race day may persist exactly one setting, once, and the
// GARAGE must say it did. A silent configuration change is the same class of
// surprise as a silent reset.
describe('raceDaySettingsNote — the one persisted change is stated (OD-19)', () => {
  it('says what changed, in the operator\'s vocabulary, and only after it changed', () => {
    expect(raceDaySettingsNote(null)).toBeNull();
    expect(raceDaySettingsNote({})).toBeNull();
    expect(raceDaySettingsNote({ telemetrySelected: false })).toBeNull();
    // Not a truthy-coercion: only an explicit true makes the claim.
    expect(raceDaySettingsNote({ telemetrySelected: 1 })).toBeNull();

    const note = raceDaySettingsNote({ telemetrySelected: true });
    expect(note).toEqual({
      label: 'NOTE',
      text: 'race day set CAR READINGS to the drive program (once) — you can change it in ⚙',
      tone: 'muted',
    });
    // It names the CARD's own label, never the component behind it.
    expect(note.text).toContain(RACE_DAY_STEP_LABELS.telemetry);
    expect(note.text).not.toMatch(/mediamtx|webrtc|whep|rtsp|\belrs\b|crsf|\bmapper\b|\budp\b|\bgrpc\b|telemetry\.source/i);
  });
});
