import { describe, it, expect } from 'vitest';
import {
  isValidIpv4, suggestionFromHint, mergeCandidates, mdnsCandidates, HINT_MAX_AGE_MS,
} from '../shared/addressProviders.mjs';

describe('isValidIpv4', () => {
  it('accepts real addresses, rejects junk', () => {
    expect(isValidIpv4('192.168.4.2')).toBe(true);
    expect(isValidIpv4('0.0.0.0')).toBe(true);
    expect(isValidIpv4('255.255.255.255')).toBe(true);
    for (const bad of ['256.1.1.1', '1.2.3', '1.2.3.4.5', 'a.b.c.d', '', '192.168.4.2 ', null, 42]) {
      expect(isValidIpv4(bad), String(bad)).toBe(false);
    }
  });
});

describe('suggestionFromHint — fresh + valid only', () => {
  it('suggests a fresh valid hint', () => {
    expect(suggestionFromHint({ addr: '192.168.4.7', ageMs: 1500 })).toBe('192.168.4.7');
  });

  it('rejects stale, invalid, and missing hints', () => {
    expect(suggestionFromHint({ addr: '192.168.4.7', ageMs: HINT_MAX_AGE_MS + 1 })).toBeNull();
    expect(suggestionFromHint({ addr: 'not-an-ip', ageMs: 10 })).toBeNull();
    expect(suggestionFromHint(null)).toBeNull();
    expect(suggestionFromHint({ addr: '192.168.4.7' })).toBeNull(); // no age
  });

  it('honors a custom freshness window', () => {
    expect(suggestionFromHint({ addr: '10.0.0.2', ageMs: 40_000 }, { maxAgeMs: 60_000 })).toBe('10.0.0.2');
  });
});

describe('mergeCandidates + mdns stub', () => {
  it('dedupes in priority order and drops invalid entries', () => {
    expect(mergeCandidates(['192.168.4.2', 'junk'], ['192.168.4.7', '192.168.4.2']))
      .toEqual(['192.168.4.2', '192.168.4.7']);
  });

  it('mdns provider is a declared stub until the coordinated milestone', () => {
    expect(mdnsCandidates()).toEqual([]);
  });
});
