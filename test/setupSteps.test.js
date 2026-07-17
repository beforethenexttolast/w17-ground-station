import { describe, it, expect } from 'vitest';
import { stepsFor, nextStep, prevStep, LIGHTS } from '../shared/setupSteps.mjs';

describe('setup step machine', () => {
  // Batch 8b: the flow reordered to GARAGE -> SEAT FIT -> PIT WALL -> GRID.
  it('iphone-hud mode walks garage -> seatfit -> pitwall -> grid', () => {
    expect(stepsFor('iphone-hud')).toEqual(['garage', 'seatfit', 'pitwall', 'grid']);
  });

  it('solo mode skips the network step', () => {
    expect(stepsFor('solo')).toEqual(['garage', 'seatfit', 'grid']);
  });

  it('nextStep advances per mode and ends at the lights', () => {
    // iPhone: SEAT FIT now precedes PIT WALL.
    expect(nextStep('garage', 'iphone-hud')).toBe('seatfit');
    expect(nextStep('seatfit', 'iphone-hud')).toBe('pitwall');
    expect(nextStep('pitwall', 'iphone-hud')).toBe('grid');
    expect(nextStep('grid', 'iphone-hud')).toBe(LIGHTS);
    // Desktop: PIT WALL is not in the path at all.
    expect(nextStep('garage', 'solo')).toBe('seatfit');
    expect(nextStep('seatfit', 'solo')).toBe('grid');
    expect(nextStep('grid', 'solo')).toBe(LIGHTS);
  });

  it('prevStep walks back and clamps at garage', () => {
    // iPhone: BACK from GRID lands on PIT WALL, then SEAT FIT, then GARAGE.
    expect(prevStep('grid', 'iphone-hud')).toBe('pitwall');
    expect(prevStep('pitwall', 'iphone-hud')).toBe('seatfit');
    expect(prevStep('seatfit', 'iphone-hud')).toBe('garage');
    // Desktop: BACK from GRID skips PIT WALL straight to SEAT FIT.
    expect(prevStep('grid', 'solo')).toBe('seatfit');
    expect(prevStep('seatfit', 'solo')).toBe('garage');
    expect(prevStep('garage', 'solo')).toBe('garage');
  });

  it('unknown current step resets to the first step', () => {
    expect(nextStep('nonsense', 'solo')).toBe('garage');
  });
});
