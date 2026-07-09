// Pure step machine for the pre-ride setup flow. ESM (renderer + vitest).
// Steps carry the pit-wall naming: GARAGE (mode) -> PIT WALL (network,
// iphone-hud mode only) -> SEAT FIT (controller) -> GRID (checklist);
// 'lights' is the terminal transition out of the flow into the HUD.

export const LIGHTS = 'lights';

export function stepsFor(mode) {
    return mode === 'iphone-hud'
        ? ['garage', 'pitwall', 'seatfit', 'grid']
        : ['garage', 'seatfit', 'grid'];
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
