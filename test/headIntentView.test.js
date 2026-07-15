// Pure render model for the mapper head-intent diagnostics chip (CB8 slice 3B).
// Proves each HeadIntentState + the transport connection states map to the
// rendered view correctly, and that the display can never imply active control.
import { describe, it, expect } from 'vitest';
import { headIntentView, HEAD_INTENT_STATE_LABELS } from '../shared/headIntentView.mjs';

const liveWith = (diagnostics) => ({ connection: 'live', diagnostics });

const VALID_DIAG = {
    state: 'HEAD_INTENT_STATE_ACTIVE_LOG_ONLY',
    has_last_valid: true,
    last_valid_seq: 42,
    receive_age_ms: 37,
    rate_per_sec: 30,
    yaw_deg: -12.53, pitch_deg: 6.81, roll_deg: 1.2,
    tracking_enabled: true, centered: true, has_centered: true,
};

describe('headIntentView — connection states (transport)', () => {
    it("'stopped' hides the chip entirely (consumer intentionally off)", () => {
        const v = headIntentView({ connection: 'stopped', diagnostics: null });
        expect(v.visible).toBe(false);
    });

    it('connecting / unavailable / exhausted / reconnecting each render a distinct label + tone', () => {
        expect(headIntentView({ connection: 'connecting' })).toMatchObject({ visible: true, tone: 'wait' });
        expect(headIntentView({ connection: 'unavailable' }).chip).toContain('MAPPER OFFLINE / INGEST OFF');
        expect(headIntentView({ connection: 'exhausted' })).toMatchObject({ tone: 'warn' });
        expect(headIntentView({ connection: 'exhausted' }).chip).toContain('CAP 4');
        expect(headIntentView({ connection: 'stream-error' }).chip).toContain('RECONNECTING');
    });

    it('a non-live connection shows no detail line even if diagnostics ride along', () => {
        const v = headIntentView({ connection: 'connecting', diagnostics: VALID_DIAG });
        expect(v.detail).toBe('');
    });

    it('an unknown/undefined connection degrades to hidden, never throws', () => {
        expect(headIntentView(undefined).visible).toBe(false);
        expect(headIntentView({}).visible).toBe(false);
    });
});

describe('headIntentView — every HeadIntentState maps to a label + tone', () => {
    for (const [enumName, expected] of Object.entries(HEAD_INTENT_STATE_LABELS)) {
        it(`${enumName} -> "${expected.label}" (${expected.tone})`, () => {
            const v = headIntentView(liveWith({ ...VALID_DIAG, state: enumName, has_last_valid: false }));
            expect(v.visible).toBe(true);
            expect(v.stateLabel).toBe(expected.label);
            expect(v.tone).toBe(expected.tone);
            expect(v.chip).toContain(expected.label);
        });
    }

    it('ACTIVE_LOG_ONLY is the "fresh" state and is still labelled NO CONTROL', () => {
        const v = headIntentView(liveWith(VALID_DIAG));
        expect(v.chip).toBe('HEAD-INTENT · ACTIVE · LOG-ONLY · NO CONTROL');
        expect(v.tone).toBe('live');
    });

    it('an unknown state string falls back to UNSPECIFIED, never throws', () => {
        const v = headIntentView(liveWith({ ...VALID_DIAG, state: 'SOMETHING_NEW' }));
        expect(v.stateLabel).toBe('UNSPECIFIED');
    });
});

describe('headIntentView — detail line passes the mapper values through verbatim', () => {
    it('shows the server-computed age, rate, seq, and angles from the last valid sample', () => {
        const v = headIntentView(liveWith(VALID_DIAG));
        expect(v.detail).toContain('yaw -12.5°');
        expect(v.detail).toContain('pitch 6.8°');
        expect(v.detail).toContain('roll 1.2°');
        expect(v.detail).toContain('age 37ms'); // receive_age_ms passed through, NOT recomputed
        expect(v.detail).toContain('30/s');
        expect(v.detail).toContain('seq 42');
    });

    it('no last-valid sample yet: no angle detail (nothing invented)', () => {
        const v = headIntentView(liveWith({ ...VALID_DIAG, has_last_valid: false }));
        expect(v.detail).toBe('');
    });

    it('missing numeric fields render as -- rather than NaN', () => {
        const v = headIntentView(liveWith({ state: 'HEAD_INTENT_STATE_STALE', has_last_valid: true }));
        expect(v.detail).toContain('yaw --°');
        expect(v.detail).not.toContain('NaN');
    });
});

describe('headIntentView — the NO CONTROL invariant', () => {
    it('EVERY visible render carries the NO CONTROL wording and the noControl flag', () => {
        const states = Object.keys(HEAD_INTENT_STATE_LABELS);
        const conns = ['connecting', 'unavailable', 'exhausted', 'stream-error'];
        for (const s of states) {
            const v = headIntentView(liveWith({ ...VALID_DIAG, state: s }));
            expect(v.chip).toContain('NO CONTROL');
            expect(v.noControl).toBe(true);
        }
        for (const c of conns) {
            const v = headIntentView({ connection: c });
            expect(v.chip).toContain('NO CONTROL');
        }
    });
});
