export function rangeFillPercent(
  min: number,
  max: number,
  value: number,
): number {
  const span = max - min;
  if (![min, max, value, span].every(Number.isFinite) || span <= 0) return 0;
  const percent = span > 0 ? ((value - min) / span) * 100 : 0;
  return Math.max(0, Math.min(100, percent));
}

/** Keep custom range tracks visually filled through their current value. */
export function paintRangeFill(input: HTMLInputElement): void {
  const percent = rangeFillPercent(
    Number(input.min || 0),
    Number(input.max || 100),
    Number(input.value),
  );
  input.style.setProperty(
    '--ttsx-range-fill',
    `${percent}%`,
  );
}

export function bindRangeFill(input: HTMLInputElement): () => void {
  const repaint = () => paintRangeFill(input);
  input.addEventListener('input', repaint);
  paintRangeFill(input);
  return () => input.removeEventListener('input', repaint);
}
