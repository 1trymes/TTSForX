/**
 * Theme detection — tokens apply only to our UI roots, never <html>/<body>.
 * Mutating documentElement has caused layout/style interactions with X (and
 * other extensions); keep everything under [data-ttsx-root].
 */
export type Theme = 'dark' | 'light';

const SVG_PAINT = 'path, circle, rect, polygon, polyline, line';

export function resolveActionIconColor(
  candidates: readonly (string | null | undefined)[],
): string | null {
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (
      value &&
      value !== 'none' &&
      value !== 'transparent' &&
      value !== 'currentcolor' &&
      !/^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/iu.test(value)
    ) {
      return value;
    }
  }
  return null;
}

export function actionIconSize(width: number, height: number): number | null {
  const size = Math.min(width, height);
  return Number.isFinite(size) && size >= 12 && size <= 28 ? size : null;
}

export function detectTheme(): Theme {
  const meta = document
    .querySelector('meta[name="theme-color"]')
    ?.getAttribute('content');
  if (meta) return isDarkColor(meta) ? 'dark' : 'light';

  const bg =
    getComputedStyle(document.body).backgroundColor ||
    getComputedStyle(document.documentElement).backgroundColor;
  return isDarkColor(bg) ? 'dark' : 'light';
}

/** Mark our UI roots with theme + optional dim color. */
export function paintTtsxRoot(el: HTMLElement, theme: Theme = detectTheme()): void {
  el.setAttribute('data-ttsx-root', '1');
  el.setAttribute('data-ttsx-theme', theme);
  const source = nearestActionSibling(el) ?? document;
  applyActionIconAppearance(el, source);
}

/** Refresh theme on every mounted TTSForX root currently in the page. */
export function applyTheme(theme: Theme = detectTheme()): void {
  // Clean up legacy html classes from older builds.
  document.documentElement.classList.remove('ttsx-dark', 'ttsx-light');
  document.documentElement.style.removeProperty('--ttsx-dim');

  for (const el of document.querySelectorAll<HTMLElement>('[data-ttsx-root]')) {
    paintTtsxRoot(el, theme);
  }
}

export function syncActionIconColor(from: ParentNode = document): void {
  for (const el of document.querySelectorAll<HTMLElement>('[data-ttsx-root]')) {
    applyActionIconAppearance(el, nearestActionSibling(el) ?? from);
  }
}

export function syncActionIconAppearance(
  root: HTMLElement,
  from: ParentNode,
): void {
  applyActionIconAppearance(root, from);
}

function nearestActionSibling(root: HTMLElement): Element | null {
  const parent = root.parentElement;
  if (!parent) return null;
  for (const sibling of parent.children) {
    if (sibling !== root && sibling.querySelector('svg')) return sibling;
  }
  return null;
}

function applyActionIconAppearance(
  root: HTMLElement,
  from: ParentNode,
): void {
  const svg =
    from.querySelector<SVGElement>('[data-testid="reply"] svg') ||
    from.querySelector<SVGElement>('svg') ||
    document.querySelector<SVGElement>('[data-testid="reply"] svg');
  if (!svg) return;

  const painted = svg.querySelector<SVGElement>(SVG_PAINT) ?? svg;
  const paintedStyle = getComputedStyle(painted);
  const svgStyle = getComputedStyle(svg);
  const color = resolveActionIconColor([
    paintedStyle.fill,
    paintedStyle.stroke,
    paintedStyle.color,
    svgStyle.fill,
    svgStyle.stroke,
    svgStyle.color,
  ]);
  if (color) root.style.setProperty('--ttsx-dim', color);

  const rect = svg.getBoundingClientRect();
  const size = actionIconSize(rect.width, rect.height);
  if (size != null) root.style.setProperty('--ttsx-icon-size', `${size}px`);
}

function isDarkColor(css: string): boolean {
  const rgb = parseCssColor(css);
  if (!rgb) return true;
  const [r, g, b] = rgb;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum < 0.45;
}

function parseCssColor(css: string): [number, number, number] | null {
  const s = css.trim();
  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1];
    if (h.length === 3) {
      return [
        parseInt(h[0] + h[0], 16),
        parseInt(h[1] + h[1], 16),
        parseInt(h[2] + h[2], 16),
      ];
    }
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
  }
  const m = s.match(/rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)/i);
  if (!m) return null;
  return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])];
}
