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
