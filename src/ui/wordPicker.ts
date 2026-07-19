import { readingTextRoots } from '../x/textRoot';
import {
  alignPreparedWordsToDom,
  buildDomWordsForRoots,
  domWordRect,
  domWordRects,
  preparedIndexByDomIndex,
  type DomWord,
} from './domWordMap';
import { paintTtsxRoot } from './theme';

interface WordTarget {
  article: HTMLElement;
  roots: readonly HTMLElement[];
  preparedWords: readonly string[];
  layoutKey: string;
  boxes: RenderedWordBox<WordHit>[];
}

interface WordHit {
  article: HTMLElement;
  root: HTMLElement;
  preparedIndex: number;
  word: DomWord;
}

let activeCleanup: (() => void) | null = null;

export interface RenderedWordBox<T> {
  value: T;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Select the closest rendered glyph box under the pointer. */
export function renderedWordAtPoint<T>(
  boxes: readonly RenderedWordBox<T>[],
  x: number,
  y: number,
  padding = 2,
): T | null {
  let best: T | null = null;
  let bestEdgeDistance = Number.POSITIVE_INFINITY;
  let bestCenterDistance = Number.POSITIVE_INFINITY;
  for (const box of boxes) {
    const dx = x < box.left ? box.left - x : x > box.right ? x - box.right : 0;
    const dy = y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0;
    if (dx > padding || dy > padding) continue;
    const edgeDistance = dx * dx + dy * dy;
    const centerX = (box.left + box.right) / 2;
    const centerY = (box.top + box.bottom) / 2;
    const centerDistance =
      (x - centerX) * (x - centerX) + (y - centerY) * (y - centerY);
    if (
      edgeDistance < bestEdgeDistance ||
      (edgeDistance === bestEdgeDistance && centerDistance < bestCenterDistance)
    ) {
      best = box.value;
      bestEdgeDistance = edgeDistance;
      bestCenterDistance = centerDistance;
    }
  }
  return best;
}

function articleAtPoint(clientX: number, clientY: number): HTMLElement | null {
  for (const element of document.elementsFromPoint(clientX, clientY)) {
    const article = element.closest<HTMLElement>(
      'article[data-testid="tweet"], article',
    );
    if (article) return article;
  }
  return null;
}

function rootForWord(
  roots: readonly HTMLElement[],
  word: DomWord,
): HTMLElement | null {
  return roots.find((root) => root.contains(word.node)) ?? null;
}

function wordLayoutKey(roots: readonly HTMLElement[]): string {
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  // A scroll can materialize content-visibility:auto paragraphs, so refresh
  // their rendered fragments even though document-space coordinates persist.
  return [
    scrollX.toFixed(2),
    scrollY.toFixed(2),
    ...roots.map((root) => {
      const rect = root.getBoundingClientRect();
      return [
        root.isConnected ? 1 : 0,
        (rect.left + scrollX).toFixed(2),
        (rect.top + scrollY).toFixed(2),
        rect.width.toFixed(2),
        rect.height.toFixed(2),
      ].join(':');
    }),
  ].join('|');
}

function rebuildWordLayout(target: WordTarget, layoutKey: string): void {
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  const rendered = buildDomWordsForRoots(target.roots).flatMap((word) => {
    const root = rootForWord(target.roots, word);
    if (!root) return [];
    const rects = domWordRects(word);
    return rects.length ? [{ word, root, rects }] : [];
  });
  const preparedByDom = preparedIndexByDomIndex(
    alignPreparedWordsToDom(
      target.preparedWords,
      rendered.map(({ word }) => word),
    ),
  );
  const boxes: RenderedWordBox<WordHit>[] = [];
  for (let domIndex = 0; domIndex < rendered.length; domIndex++) {
    const preparedIndex = preparedByDom.get(domIndex);
    if (preparedIndex == null) continue;
    const { word, root, rects } = rendered[domIndex]!;
    const hit: WordHit = {
      article: target.article,
      root,
      preparedIndex,
      word,
    };
    for (const rect of rects) {
      boxes.push({
        value: hit,
        left: rect.left + scrollX,
        right: rect.right + scrollX,
        top: rect.top + scrollY,
        bottom: rect.bottom + scrollY,
      });
    }
  }
  target.layoutKey = layoutKey;
  target.boxes = boxes;
}

function buildTarget(
  article: HTMLElement,
  preparedWords: readonly string[],
): WordTarget | null {
  const roots = readingTextRoots(article);
  if (!roots.length || !preparedWords.length) return null;
  const target: WordTarget = {
    article,
    roots,
    preparedWords,
    layoutKey: '',
    boxes: [],
  };
  const layoutKey = wordLayoutKey(roots);
  rebuildWordLayout(target, layoutKey);
  return target.boxes.length ? target : null;
}

function wordAtPoint(
  target: WordTarget,
  clientX: number,
  clientY: number,
): WordHit | null {
  const layoutKey = wordLayoutKey(target.roots);
  if (layoutKey !== target.layoutKey) {
    rebuildWordLayout(target, layoutKey);
  }
  return renderedWordAtPoint(
    target.boxes,
    clientX + window.scrollX,
    clientY + window.scrollY,
  );
}

interface HoverScheduler {
  onPointerMove(event: PointerEvent): void;
  cancel(): void;
}

function createHoverScheduler(
  resolve: (clientX: number, clientY: number) => WordHit | null,
  paint: (hit: WordHit | null) => void,
): HoverScheduler {
  let frame: number | null = null;
  let clientX = 0;
  let clientY = 0;
  const onPointerMove = (event: PointerEvent) => {
    clientX = event.clientX;
    clientY = event.clientY;
    if (frame != null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      paint(resolve(clientX, clientY));
    });
  };
  return {
    onPointerMove,
    cancel() {
      if (frame != null) cancelAnimationFrame(frame);
      frame = null;
    },
  };
}

function createHover(): HTMLDivElement {
  const hover = document.createElement('div');
  hover.className = 'ttsx-word-picker-hover';
  hover.setAttribute('aria-hidden', 'true');
  hover.hidden = true;
  paintTtsxRoot(hover);
  document.documentElement.appendChild(hover);
  return hover;
}

function paintHover(hover: HTMLElement, hit: WordHit | null): void {
  const rect = hit ? domWordRect(hit.word) : null;
  if (!rect) {
    hover.hidden = true;
    return;
  }
  hover.hidden = false;
  hover.style.left = `${Math.round(rect.left - 3)}px`;
  hover.style.top = `${Math.round(rect.top - 2)}px`;
  hover.style.width = `${Math.round(rect.width + 6)}px`;
  hover.style.height = `${Math.round(rect.height + 4)}px`;
}

export function stopWordPicker(): void {
  const cleanup = activeCleanup;
  activeCleanup = null;
  cleanup?.();
}

export function isWordPickerActive(): boolean {
  return activeCleanup != null;
}

/**
 * One-post picker used by the settings attached to a specific speaker.
 * Selection ends after one word is chosen.
 */
export function startWordPicker(
  article: HTMLElement,
  preparedWords: readonly string[],
  onSelect: (wordIndex: number) => void,
): boolean {
  stopWordPicker();
  const target = buildTarget(article, preparedWords);
  if (!target) return false;

  const hover = createHover();
  for (const root of target.roots) {
    root.classList.add('ttsx-word-picker-active');
  }
  const hitFromPoint = (clientX: number, clientY: number) =>
    wordAtPoint(target, clientX, clientY);
  const hoverScheduler = createHoverScheduler(hitFromPoint, (hit) =>
    paintHover(hover, hit),
  );
  const onClick = (event: MouseEvent) => {
    const hit = hitFromPoint(event.clientX, event.clientY);
    if (!hit) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    stopWordPicker();
    onSelect(hit.preparedIndex);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    stopWordPicker();
  };

  document.addEventListener('pointermove', hoverScheduler.onPointerMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  activeCleanup = () => {
    document.removeEventListener(
      'pointermove',
      hoverScheduler.onPointerMove,
      true,
    );
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    hoverScheduler.cancel();
    for (const root of target.roots) {
      root.classList.remove('ttsx-word-picker-active');
    }
    hover.remove();
  };
  return true;
}

/**
 * Persistent feed picker used by the toolbar popup. Targets are resolved at
 * pointer time, so X can virtualize posts while the user scrolls. Choosing a
 * word starts that post but leaves selection mode active for the next post.
 */
export function startFeedWordPicker(
  preparedWordsForArticle: (
    article: HTMLElement,
  ) => readonly string[] | null,
  onSelect: (article: HTMLElement, wordIndex: number) => void,
): void {
  stopWordPicker();
  const hover = createHover();
  hover.dataset.feedPicker = 'true';
  const targets = new WeakMap<HTMLElement, WordTarget>();
  let activeRoot: HTMLElement | null = null;

  function paintActiveRoot(root: HTMLElement | null): void {
    if (activeRoot === root) return;
    activeRoot?.classList.remove('ttsx-word-picker-active');
    activeRoot = root;
    activeRoot?.classList.add('ttsx-word-picker-active');
  }

  function targetAtPoint(
    clientX: number,
    clientY: number,
  ): WordTarget | null {
    const article = articleAtPoint(clientX, clientY);
    if (!article) return null;
    const cached = targets.get(article);
    if (cached?.roots.every((root) => root.isConnected)) return cached;
    const preparedWords = preparedWordsForArticle(article);
    if (!preparedWords?.length) return null;
    const target = buildTarget(article, preparedWords);
    if (target) targets.set(article, target);
    return target;
  }

  const hitFromPoint = (clientX: number, clientY: number) => {
    const target = targetAtPoint(clientX, clientY);
    return target
      ? wordAtPoint(target, clientX, clientY)
      : null;
  };
  const hoverScheduler = createHoverScheduler(hitFromPoint, (hit) => {
    paintActiveRoot(hit?.root ?? null);
    paintHover(hover, hit);
  });
  const onClick = (event: MouseEvent) => {
    const hit = hitFromPoint(event.clientX, event.clientY);
    if (!hit) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    targets.delete(hit.article);
    paintActiveRoot(null);
    paintHover(hover, null);
    onSelect(hit.article, hit.preparedIndex);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    stopWordPicker();
  };

  document.addEventListener('pointermove', hoverScheduler.onPointerMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  activeCleanup = () => {
    document.removeEventListener(
      'pointermove',
      hoverScheduler.onPointerMove,
      true,
    );
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    hoverScheduler.cancel();
    paintActiveRoot(null);
    hover.remove();
  };
}
