// Pure step machine for the pre-ride setup flow. ESM (renderer + vitest).
// Steps carry the pit-wall naming: GARAGE (mode) -> PIT WALL (network,
// iphone-hud mode only) -> SEAT FIT (controller) -> SETUP (drive + camera mode)
// -> GRID (checklist); 'lights' is the terminal transition out of the flow into
// the HUD. Desktop/solo mode omits PIT WALL entirely — the network step exists
// only when an iPhone must join the session. (2026-07-19 reorder: PIT WALL now
// precedes SEAT FIT so the iPhone/network joins before the controller step.
// 2026-07-20: SETUP split out of SEAT FIT — drive mode + camera mode get their
// own screen before the GRID, so SEAT FIT is purely controller/input.)

export const LIGHTS = 'lights';

export function stepsFor(mode) {
    return mode === 'iphone-hud'
        ? ['garage', 'pitwall', 'seatfit', 'setup', 'grid']
        : ['garage', 'seatfit', 'setup', 'grid'];
}

export function nextStep(current, mode) {
    const steps = stepsFor(mode);
    const i = steps.indexOf(current);
    if (i === -1) return steps[0];
    return i + 1 < steps.length ? steps[i + 1] : LIGHTS;
}

export function prevStep(current, mode) {
    const steps = stepsFor(mode);
    const i = steps.indexOf(current);
    return i > 0 ? steps[i - 1] : steps[0];
}
