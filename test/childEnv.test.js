import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scrubW17Env, SCRUBBED_PREFIX } = require('../shared/childEnv.js');

// shared/childEnv.js is the ONE scrub every spawn site uses (review
// boundaries-4). Its whole job is that no W17_* variable — in any spelling —
// reaches a child this app starts, because the mapper defaults its experimental
// flags from that namespace and the race-day argv whitelist deliberately never
// passes them.

describe('scrubW17Env', () => {
  it('strips the W17_ namespace in every letter case (boundaries-5)', () => {
    const out = scrubW17Env({
      W17_HEADTRACK_INGEST: '1',
      w17_headtrack_ingest: '1',
      W17_HeadTrack_Ingest: '1',
      w17_ANY_future_KNOB: 'x',
      W17_: 'bare prefix',
    });
    expect(Object.keys(out)).toEqual([]);
  });

  it('passes every non-W17 variable through untouched — the child still needs an environment', () => {
    const env = { PATH: '/usr/bin', HOME: '/Users/pit', SystemRoot: 'C:\\Windows', W17X: 'not the namespace', WW17_A: 'nope' };
    expect(scrubW17Env(env)).toEqual(env);
  });

  it('returns a NEW object and never mutates the caller\u2019s env', () => {
    const env = { PATH: '/usr/bin', W17_A: '1' };
    const out = scrubW17Env(env);
    expect(out).not.toBe(env);
    expect(env.W17_A).toBe('1'); // process.env must survive the call intact
    out.PATH = '/changed';
    expect(env.PATH).toBe('/usr/bin');
  });

  it('tolerates an absent/empty environment without throwing', () => {
    expect(scrubW17Env()).toEqual({});
    expect(scrubW17Env({})).toEqual({});
  });

  it('the scrubbed prefix is the whole namespace, not an enumerated name list', () => {
    expect(SCRUBBED_PREFIX).toBe('W17_');
  });
});
