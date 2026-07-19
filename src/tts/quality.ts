/** Official Supertonic 3 flow-matching quality range. */
export const MIN_GENERATION_STEPS = 5;
export const DEFAULT_GENERATION_STEPS = 8;
export const MAX_GENERATION_STEPS = 12;
export const GENERATION_QUALITY_SLIDER_MAX = 1000;

export function normalizeGenerationSteps(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_GENERATION_STEPS;
  return Math.min(
    MAX_GENERATION_STEPS,
    Math.max(MIN_GENERATION_STEPS, Math.round(parsed)),
  );
}

export function generationQualityLabel(value: unknown): string {
  const steps = normalizeGenerationSteps(value);
  const quality =
    steps <= 6 ? 'Faster' : steps >= 10 ? 'Higher' : 'Balanced';
  return `${steps} · ${quality}`;
}

/**
 * Keep Supertonic's official 5–12 values while placing the default 8 at the
 * exact visual center shared by the Speed and Volume sliders. Quality is
 * discrete and perceptual, so its two halves use independent linear spacing.
 */
export function generationQualitySliderPosition(value: unknown): number {
  const steps = normalizeGenerationSteps(value);
  if (steps <= DEFAULT_GENERATION_STEPS) {
    return Math.round(
      ((steps - MIN_GENERATION_STEPS) /
        (DEFAULT_GENERATION_STEPS - MIN_GENERATION_STEPS)) *
        (GENERATION_QUALITY_SLIDER_MAX / 2),
    );
  }
  return Math.round(
    GENERATION_QUALITY_SLIDER_MAX / 2 +
      ((steps - DEFAULT_GENERATION_STEPS) /
        (MAX_GENERATION_STEPS - DEFAULT_GENERATION_STEPS)) *
        (GENERATION_QUALITY_SLIDER_MAX / 2),
  );
}

export function generationStepsAtSliderPosition(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  const position = Number.isFinite(parsed)
    ? Math.min(GENERATION_QUALITY_SLIDER_MAX, Math.max(0, parsed))
    : generationQualitySliderPosition(DEFAULT_GENERATION_STEPS);

  let closest = DEFAULT_GENERATION_STEPS;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (
    let steps = MIN_GENERATION_STEPS;
    steps <= MAX_GENERATION_STEPS;
    steps++
  ) {
    const distance = Math.abs(
      generationQualitySliderPosition(steps) - position,
    );
    if (distance < closestDistance) {
      closest = steps;
      closestDistance = distance;
    }
  }
  return closest;
}
