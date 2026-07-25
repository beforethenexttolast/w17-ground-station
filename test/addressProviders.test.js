import { describe, it, expect } from 'vitest';
import {
  isValidIpv4, suggestionFromHint, mergeCandidates, mdnsCandidates, hudLabel,
  pickAddressSuggestion, HINT_MAX_AGE_MS,
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

describe('mergeCandidates', () => {
  it('dedupes in priority order and drops invalid entries', () => {
    expect(mergeCandidates(['192.168.4.2', 'junk'], ['192.168.4.7', '192.168.4.2']))
      .toEqual(['192.168.4.2', '192.168.4.7']);
  });
});

describe('mdnsCandidates — discovered HUDs (CB4)', () => {
  it('takes the addresses of discovered HUDs, in the order main offered them', () => {
    expect(mdnsCandidates([
      { addr: '192.168.4.9', dev: 'A' }, { addr: '192.168.4.2', dev: 'B' },
    ])).toEqual(['192.168.4.9', '192.168.4.2']);
  });

  it('re-validates rather than trusting the payload shape (defense in depth)', () => {
    expect(mdnsCandidates([
      { addr: '999.1.1.1' }, { addr: 42 }, {}, null, { dev: 'no addr' }, { addr: '10.0.0.4' },
    ])).toEqual(['10.0.0.4']);
  });

  it('applies the SAME address rule as main, not a weaker one', () => {
    // main rejects "this network" and multicast/broadcast (shared/hudDiscovery.js
    // isUsableUnicastIpv4). A renderer re-check that let those through would be
    // defense in depth in name only.
    expect(mdnsCandidates([
      { addr: '0.0.0.0' }, { addr: '0.1.2.3' }, { addr: '224.0.0.251' },
      { addr: '239.255.255.250' }, { addr: '255.255.255.255' }, { addr: '192.168.4.7' },
    ])).toEqual(['192.168.4.7']);
  });

  it('answers empty for a missing or non-array payload (an older main, a failed poll)', () => {
    expect(mdnsCandidates(undefined)).toEqual([]);
    expect(mdnsCandidates(null)).toEqual([]);
    expect(mdnsCandidates('nope')).toEqual([]);
  });
});

describe('hudLabel — the one piece of network-authored text the UI shows', () => {
  it('keeps a normal device name', () => {
    expect(hudLabel({ dev: 'Vitaliy iPhone' })).toBe('Vitaliy iPhone');
  });

  it('strips non-printable characters and bounds the length', () => {
    expect(hudLabel({ dev: 'Bad\x07\x1b[31m' })).toBe('Bad[31m');
    expect(hudLabel({ dev: 'Z'.repeat(200) }).length).toBe(24);
    expect(hudLabel({})).toBe('');
    expect(hudLabel(null)).toBe('');
  });

  it('cannot emit the chip separator, so a label cannot forge the provenance wording', () => {
    // The separator '·' is U+00B7 — above the printable-ASCII ceiling — so the
    // ASCII filter is what closes this. Widening that range would reopen it.
    expect(hudLabel({ dev: 'X · from HUD traffic' })).not.toContain('·');
  });

  it('keeps the surviving characters of such a label', () => {
    // Without this, a device advertising itself as "X · from HUD traffic"
    // would render a line an operator reads as the evidence-backed traffic hint.
    expect(hudLabel({ dev: 'X · from HUD traffic' })).toBe('X  from HUD traffic');
  });
});

describe('pickAddressSuggestion — what the address field OFFERS', () => {
  it('prefers observed traffic: a packet really arrived from there', () => {
    const pick = pickAddressSuggestion({
      addr: '192.168.4.7', ageMs: 1_000,
      huds: [{ addr: '192.168.4.9', dev: 'Test iPhone' }],
    });
    expect(pick).toEqual({ addr: '192.168.4.7', source: 'traffic', why: 'from HUD traffic' });
  });

  it('falls back to a discovered HUD, labelled by its device name', () => {
    const pick = pickAddressSuggestion({ huds: [{ addr: '192.168.4.9', dev: 'Test iPhone' }] });
    expect(pick).toEqual({
      addr: '192.168.4.9', source: 'mdns', why: 'Test iPhone · found on network',
    });
  });

  it('falls back to discovery when the traffic hint has gone stale', () => {
    const pick = pickAddressSuggestion({
      addr: '192.168.4.7', ageMs: HINT_MAX_AGE_MS + 1,
      huds: [{ addr: '192.168.4.9', dev: '' }],
    });
    expect(pick).toMatchObject({ addr: '192.168.4.9', source: 'mdns', why: 'found on network' });
  });

  it('skips discovered entries whose address does not survive validation', () => {
    const pick = pickAddressSuggestion({ huds: [{ addr: 'junk' }, { addr: '10.0.0.4', dev: 'ok' }] });
    expect(pick.addr).toBe('10.0.0.4');
  });

  it('offers nothing when neither provider has anything', () => {
    expect(pickAddressSuggestion(null)).toBeNull();
    expect(pickAddressSuggestion({})).toBeNull();
    expect(pickAddressSuggestion({ huds: [] })).toBeNull();
    expect(pickAddressSuggestion({ addr: 'junk', ageMs: 1, huds: [{ addr: '0.0.0' }] })).toBeNull();
  });

  it('is a SUGGESTION, never an application: it only ever returns a value to offer', () => {
    // The shape carries no side effect and no "apply" affordance — the setup
    // flow fills the field on an explicit click, and the operator still runs
    // the GRID reachability check. Discovery is advisory per the contract.
    const pick = pickAddressSuggestion({ huds: [{ addr: '10.0.0.4', dev: 'x' }] });
    expect(Object.keys(pick).sort()).toEqual(['addr', 'source', 'why']);
  });
});
