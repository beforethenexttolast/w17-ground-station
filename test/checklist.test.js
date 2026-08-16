import { describe, it, expect } from 'vitest';
import {
  buildChecklist, applyProbes, canStart, OVERRIDE_ALWAYS_ALLOWED,
} from '../shared/checklist.mjs';

const ids = (checks) => checks.map((c) => c.id);

describe('buildChecklist — which checks apply', () => {
  it('solo without telemetry: video, controller, elrs(skippable)', () => {
    const c = buildChecklist({ mode: 'solo' });
    expect(ids(c)).toEqual(['video-lock', 'controller', 'elrs-running']);
    expect(c.find((x) => x.id === 'elrs-running').required).toBe(false);
  });

  it('iphone-hud with telemetry + elrs configured: full grid', () => {
    const c = buildChecklist({ mode: 'iphone-hud', telemetryConfigured: true, elrsConfigured: true });
    expect(ids(c)).toEqual(['video-lock', 'controller', 'telemetry', 'iphone-reachable', 'elrs-running']);
    expect(c.every((x) => x.required)).toBe(true);
    expect(c.every((x) => x.status === 'pending')).toBe(true);
  });

  it('every check carries a non-empty fix hint, preserved through applyProbes', () => {
    const c = buildChecklist({ mode: 'iphone-hud', telemetryConfigured: true, elrsConfigured: true });
    expect(c.every((x) => typeof x.hint === 'string' && x.hint.length > 0)).toBe(true);
    const probed = applyProbes(c, { 'iphone-reachable': false });
    const red = probed.find((x) => x.id === 'iphone-reachable');
    expect(red.status).toBe('fail');
    expect(red.hint).toMatch(/hotspot/); // the client-isolation escape hatch
  });
});

// GRID hints are giftee-facing failure copy (vision operator model: plain-
// language failures; 2026-08-16 audit defect 11 confirmed the old wording —
// mediamtx paths, H.264, COM ports, component names — was off that bar).
// These pins are DELIBERATE: the exact strings are the deliverable, so a
// wording change here must be a conscious decision against the operator
// model, not a drive-by.
describe('hints — plain language for a non-hobbyist operator (audit defect 11)', () => {
  const all = buildChecklist({ mode: 'iphone-hud', telemetryConfigured: true, elrsConfigured: true });
  const hint = (id) => all.find((c) => c.id === id).hint;

  it('every hint says what happened AND what to do, in gift-manual vocabulary', () => {
    expect(hint('video-lock'))
      .toBe('no picture from the car — is the car switched on? give it a few seconds after power-on');
    expect(hint('controller'))
      .toBe('controller not detected — plug it in or press the PS button (the keyboard arrows work too)');
    expect(hint('telemetry'))
      .toBe('no data from the car yet — make sure the car is switched on, or check the telemetry settings in ⚙');
    expect(hint('iphone-reachable'))
      .toBe('phone not reachable — put the phone and this computer on the same Wi-Fi, or use the hotspot');
    expect(hint('elrs-running'))
      .toBe('the program that drives the car is not running — press LAUNCH, or set its location in ⚙');
  });

  it('no hint leaks hobbyist vocabulary, in any mode', () => {
    // The ban list is the audit's own examples plus the classes around them:
    // stack components, codec/transport names, serial-port jargon, repo docs
    // paths. "computer" must not trip a naive COM match — the pattern is
    // anchored to the jargon forms actually banned.
    const jargon = /mediamtx|webrtc|h\.?264|whep|rtsp|\bcom\s?\d|\bcom port|\belrs\b|joystick-control|docs\/|\.md\b|crsf/i;
    for (const mode of ['solo', 'iphone-hud']) {
      for (const flags of [{}, { telemetryConfigured: true, elrsConfigured: true }]) {
        for (const c of buildChecklist({ mode, ...flags })) {
          expect(c.hint, `${c.id} hint must stay plain-language`).not.toMatch(jargon);
        }
      }
    }
  });

  it('every hint leads with the failure before the em-dash fix (the shape the renderer shows)', () => {
    for (const c of all) {
      expect(c.hint).toMatch(/^[^—]+ — .+/);
    }
  });
});

describe('applyProbes / canStart', () => {
  const base = buildChecklist({ mode: 'iphone-hud', telemetryConfigured: true, elrsConfigured: true });

  it('maps probe results to statuses (true/false/skipped/undefined)', () => {
    const c = applyProbes(base, {
      'video-lock': true, controller: false, 'elrs-running': 'skipped',
    });
    expect(c.find((x) => x.id === 'video-lock').status).toBe('ok');
    expect(c.find((x) => x.id === 'controller').status).toBe('fail');
    expect(c.find((x) => x.id === 'elrs-running').status).toBe('skipped');
    expect(c.find((x) => x.id === 'telemetry').status).toBe('pending');
  });

  it('canStart requires every required check ok (skipped counts as satisfied)', () => {
    const allOk = applyProbes(base, {
      'video-lock': true, controller: true, telemetry: true,
      'iphone-reachable': true, 'elrs-running': 'skipped',
    });
    expect(canStart(allOk)).toBe(true);
    const oneFail = applyProbes(base, {
      'video-lock': true, controller: true, telemetry: true,
      'iphone-reachable': false, 'elrs-running': true,
    });
    expect(canStart(oneFail)).toBe(false);
  });

  it('a non-required failing check never blocks', () => {
    const c = applyProbes(buildChecklist({ mode: 'solo' }), {
      'video-lock': true, controller: true, 'elrs-running': false,
    });
    expect(canStart(c)).toBe(true);
  });

  it('the START ANYWAY override is an engine-level invariant', () => {
    expect(OVERRIDE_ALWAYS_ALLOWED).toBe(true);
  });
});
