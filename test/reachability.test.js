import { describe, it, expect } from 'vitest';
import { probeStatusLine, PATH_ONLY_NOTE } from '../shared/reachability.mjs';

// Product truthfulness (audit B4/C4): a positive reachability result proves the
// network PATH only. It must never claim UDP receipt, iOS permission, live W2
// telemetry, or a working iPhone HUD — the phone screen is the final evidence.
describe('PATH_ONLY_NOTE — the approved path-only caveat', () => {
  it('is the exact approved wording', () => {
    expect(PATH_ONLY_NOTE).toBe(
      'Ping succeeded. This proves the network path only. Confirm live data on the iPhone; check iOS Local Network permission if it does not appear.',
    );
  });

  it('claims the path only and points at iOS Local Network permission', () => {
    expect(PATH_ONLY_NOTE).toMatch(/network path only/i);
    expect(PATH_ONLY_NOTE).toMatch(/iOS Local Network permission/i);
  });

  it('never claims the iPhone is receiving / the HUD is working', () => {
    for (const forbidden of [/receiving/i, /\bUDP\b/, /\bHUD\b/, /telemetry/i, /permission (is )?granted/i]) {
      expect(PATH_ONLY_NOTE).not.toMatch(forbidden);
    }
  });
});

describe('probeStatusLine — honest per-status wording', () => {
  it('reachable stays truthful: "network path only", with the rtt when present', () => {
    expect(probeStatusLine({ ok: true, status: 'reachable', rttMs: 4 })).toBe('REACHABLE 4ms — network path only');
    expect(probeStatusLine({ ok: true, status: 'reachable' })).toBe('REACHABLE — network path only');
    // a legacy ok:true without an explicit status is still honest
    expect(probeStatusLine({ ok: true })).toMatch(/network path only/);
  });

  it('a reachable line never claims the iPhone HUD is receiving', () => {
    const line = probeStatusLine({ ok: true, status: 'reachable', rttMs: 4 });
    for (const forbidden of [/receiving/i, /\bUDP\b/, /\bHUD\b/, /permission/i]) {
      expect(line).not.toMatch(forbidden);
    }
  });

  it('maps each red status to a clear, distinct line', () => {
    expect(probeStatusLine({ status: 'timeout' })).toBe('NO REPLY — timed out');
    expect(probeStatusLine({ status: 'unreachable' })).toBe('UNREACHABLE — no route to the phone');
    expect(probeStatusLine({ status: 'invalid' })).toBe('INVALID IP');
    expect(probeStatusLine({ status: 'command-unavailable' })).toBe('PING UNAVAILABLE ON THIS SYSTEM');
    expect(probeStatusLine({ status: 'command-error' })).toBe('CHECK FAILED — retry');
  });

  it('an unknown/unclassified result falls back to its error text (uppercased), never a green', () => {
    const line = probeStatusLine({ ok: false, status: 'unknown', error: 'no reply — reachability could not be confirmed' });
    expect(line).toBe('NO REPLY — REACHABILITY COULD NOT BE CONFIRMED');
    expect(line).not.toMatch(/network path only/);
  });
});
