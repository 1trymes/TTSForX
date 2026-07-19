import {
  GENERATION_QUALITY_SLIDER_MAX,
  MAX_GENERATION_STEPS,
  MIN_GENERATION_STEPS,
  generationQualityLabel,
  generationQualitySliderPosition,
  generationStepsAtSliderPosition,
  normalizeGenerationSteps,
} from '../tts/quality';

type QualityChangeHandler = (steps: number) => void;

/** Upgrade a native range into the centered, discrete Supertonic quality UI. */
export function bindGenerationQualityRange(
  input: HTMLInputElement,
  initialSteps: unknown,
  onChange: QualityChangeHandler,
): () => void {
  let currentSteps = normalizeGenerationSteps(initialSteps);

  input.min = '0';
  input.max = String(GENERATION_QUALITY_SLIDER_MAX);
  input.step = '1';
  input.setAttribute('aria-label', 'Generation quality');
  input.setAttribute('aria-valuemin', String(MIN_GENERATION_STEPS));
  input.setAttribute('aria-valuemax', String(MAX_GENERATION_STEPS));

  const paint = (steps: number, notify: boolean): void => {
    const normalized = normalizeGenerationSteps(steps);
    const changed = normalized !== currentSteps;
    currentSteps = normalized;
    input.value = String(generationQualitySliderPosition(normalized));
    input.dataset.qualitySteps = String(normalized);
    input.setAttribute('aria-valuenow', String(normalized));
    input.setAttribute('aria-valuetext', generationQualityLabel(normalized));
    if (notify && changed) onChange(normalized);
  };

  const onInput = (): void => {
    paint(generationStepsAtSliderPosition(input.value), true);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    let next: number | null = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      next = currentSteps - 1;
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      next = currentSteps + 1;
    } else if (event.key === 'Home') {
      next = MIN_GENERATION_STEPS;
    } else if (event.key === 'End') {
      next = MAX_GENERATION_STEPS;
    }
    if (next == null) return;
    event.preventDefault();
    paint(next, true);
  };

  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKeyDown);
  paint(currentSteps, false);

  return () => {
    input.removeEventListener('input', onInput);
    input.removeEventListener('keydown', onKeyDown);
  };
}
