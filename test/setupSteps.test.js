import { describe, it, expect } from 'vitest';
import { stepsFor, nextStep, prevStep, LIGHTS } from '../shared/setupSteps.mjs';

describe('setup step machine', () => {
  it('iphone-hud mode walks garage -> pitwall -> seatfit -> grid', () => {
    expect(stepsFor('iphone-hud')).toEqual(['garage', 'pitwall', 'seatfit', 'grid']);
  });

  it('solo mode skips the network step', () => {
    expect(stepsFor('solo')).toEqual(['garage', 'seatfit', 'grid']);
  });

  it('nextStep advances per mode and ends at the lights', () => {
    expect(nextStep('garage', 'iphone-hud')).toBe('pitwall');
    expect(nextStep('garage', 'solo')).toBe('seatfit');
    expect(nextStep('grid', 'solo')).toBe(LIGHTS);
    expect(nextStep('grid', 'iphone-hud')).toBe(LIGHTS);
  });

  it('prevStep walks back and clamps at garage', () => {
    expect(prevStep('seatfit', 'iphone-hud')).toBe('pitwall');
    expect(prevStep('seatfit', 'solo')).toBe('garage');
    expect(prevStep('garage', 'solo')).toBe('garage');
  });

  it('unknown current step resets to the first step', () => {
    expect(nextStep('nonsense', 'solo')).toBe('garage');
  });
});
