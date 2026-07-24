import { describe, it, expect } from 'vitest';
import { stepsFor, nextStep, prevStep, LIGHTS } from '../shared/setupSteps.mjs';

describe('setup step machine', () => {
  // 2026-07-20: SETUP (drive + camera mode) split out of SEAT FIT into its own
  // step before GRID. Flow is GARAGE -> PIT WALL -> SEAT FIT -> SETUP -> GRID.
  it('iphone-hud mode walks garage -> pitwall -> seatfit -> setup -> grid', () => {
    expect(stepsFor('iphone-hud')).toEqual(['garage', 'pitwall', 'seatfit', 'setup', 'grid']);
  });

  it('solo mode skips the network step', () => {
    expect(stepsFor('solo')).toEqual(['garage', 'seatfit', 'setup', 'grid']);
  });

  it('nextStep advances per mode and ends at the lights', () => {
    // iPhone: PIT WALL precedes SEAT FIT; SETUP follows it before GRID.
    expect(nextStep('garage', 'iphone-hud')).toBe('pitwall');
    expect(nextStep('pitwall', 'iphone-hud')).toBe('seatfit');
    expect(nextStep('seatfit', 'iphone-hud')).toBe('setup');
    expect(nextStep('setup', 'iphone-hud')).toBe('grid');
    expect(nextStep('grid', 'iphone-hud')).toBe(LIGHTS);
    // Desktop: PIT WALL is not in the path at all.
    expect(nextStep('garage', 'solo')).toBe('seatfit');
    expect(nextStep('seatfit', 'solo')).toBe('setup');
    expect(nextStep('setup', 'solo')).toBe('grid');
    expect(nextStep('grid', 'solo')).toBe(LIGHTS);
  });

  it('prevStep walks back and clamps at garage', () => {
    // iPhone: BACK from GRID lands on SETUP, SEAT FIT, PIT WALL, then GARAGE.
    expect(prevStep('grid', 'iphone-hud')).toBe('setup');
    expect(prevStep('setup', 'iphone-hud')).toBe('seatfit');
    expect(prevStep('seatfit', 'iphone-hud')).toBe('pitwall');
    expect(prevStep('pitwall', 'iphone-hud')).toBe('garage');
    // Desktop: BACK from GRID lands on SETUP, then SEAT FIT (PIT WALL skipped).
    expect(prevStep('grid', 'solo')).toBe('setup');
    expect(prevStep('setup', 'solo')).toBe('seatfit');
    expect(prevStep('seatfit', 'solo')).toBe('garage');
    expect(prevStep('garage', 'solo')).toBe('garage');
  });

  it('unknown current step resets to the first step', () => {
    expect(nextStep('nonsense', 'solo')).toBe('garage');
  });
});
