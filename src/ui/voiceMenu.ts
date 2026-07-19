export function selectedVoiceScrollTop(
  optionTop: number,
  optionHeight: number,
  viewportHeight: number,
): number {
  return Math.max(0, optionTop - (viewportHeight - optionHeight) / 2);
}

/** Center the selected voice inside the menu without scrolling the page. */
export function centerSelectedVoice(
  list: HTMLElement,
  selected: HTMLElement | null,
): void {
  if (!selected) return;
  const configuredHeight = Number.parseFloat(
    getComputedStyle(list).getPropertyValue('--ttsx-voice-list-height'),
  );
  const viewportHeight =
    Number.isFinite(configuredHeight) && configuredHeight > 0
      ? configuredHeight
      : list.clientHeight;
  list.scrollTop = selectedVoiceScrollTop(
    selected.offsetTop,
    selected.offsetHeight,
    viewportHeight,
  );
}
