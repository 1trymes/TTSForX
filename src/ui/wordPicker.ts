import { readingTextRoots } from '../x/textRoot';
import {
  alignPreparedWordsToDom,
  buildDomWordsForRoots,
  domWordRects,
  isDomWordConnected,
  mergeWordRectsByLine,
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
  dirty: boolean;
  observer: MutationObserver | null;
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
  return (
    roots.find((root) =>
      word.fragments.some((fragment) => root.contains(fragment.node)),
    ) ?? null
  );
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
  const domWords = buildDomWordsForRoots(target.roots);
  const preparedByDom = preparedIndexByDomIndex(
    alignPreparedWordsToDom(target.preparedWords, domWords),
  );
  const boxes: RenderedWordBox<WordHit>[] = [];
  for (let domIndex = 0; domIndex < domWords.length; domIndex++) {
    const preparedIndex = preparedByDom.get(domIndex);
    if (preparedIndex == null) continue;
    const word = domWords[domIndex]!;
    const root = rootForWord(target.roots, word);
    if (!root) continue;
    const rects = domWordRects(word);
    if (!rects.length) continue;
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
  target.dirty = false;
}

function classWithoutPicker(value: string | null): string {
  return (value ?? '')
    .split(/\s+/u)
    .filter((name) => name && name !== 'ttsx-word-picker-active')
    .sort()
    .join(' ');
}

function observeTarget(target: WordTarget): void {
  const observer = new MutationObserver((records) => {
    const meaningful = records.some((record) => {
      if (record.type !== 'attributes' || record.attributeName !== 'class') {
        return true;
      }
      const element = record.target as Element;
      return (
        classWithoutPicker(record.oldValue) !==
        classWithoutPicker(element.getAttribute('class'))
      );
    });
    if (meaningful) target.dirty = true;
  });
  for (const root of target.roots) {
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
    });
  }
  target.observer = observer;
}

function disposeTarget(target: WordTarget | null): void {
  target?.observer?.disconnect();
  if (target) target.observer = null;
}

function targetNeedsRefresh(target: WordTarget): boolean {
  return (
    target.dirty ||
    !target.article.isConnected ||
    target.roots.some((root) => !root.isConnected) ||
    target.boxes.some((box) => !isDomWordConnected(box.value.word))
  );
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
    dirty: false,
    observer: null,
  };
  const layoutKey = wordLayoutKey(roots);
  rebuildWordLayout(target, layoutKey);
  if (!target.boxes.length) return null;
  observeTarget(target);
  return target;
}

function wordAtPoint(
  target: WordTarget,
  clientX: number,
  clientY: number,
  forceLayout = false,
): WordHit | null {
  const layoutKey = wordLayoutKey(target.roots);
  if (
    forceLayout ||
    targetNeedsRefresh(target) ||
    layoutKey !== target.layoutKey
  ) {
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

function hoverFragments(
  hover: HTMLElement,
  count: number,
): HTMLElement[] {
  while (hover.children.length > count) hover.lastElementChild?.remove();
  while (hover.children.length < count) {
    const fragment = document.createElement('div');
    fragment.className = 'ttsx-word-picker-hover-fragment';
    hover.appendChild(fragment);
  }
  return [...hover.children] as HTMLElement[];
}

function paintHover(hover: HTMLElement, hit: WordHit | null): void {
  const rects = hit
    ? mergeWordRectsByLine(domWordRects(hit.word))
    : [];
  if (!rects.length) {
    hover.hidden = true;
    return;
  }
  hover.hidden = false;
  const fragments = hoverFragments(hover, rects.length);
  for (let index = 0; index < rects.length; index++) {
    const rect = rects[index]!;
    const fragment = fragments[index]!;
    fragment.style.left = `${Math.round(rect.left - 3)}px`;
    fragment.style.top = `${Math.round(rect.top - 2)}px`;
    fragment.style.width = `${Math.round(rect.width + 6)}px`;
    fragment.style.height = `${Math.round(rect.height + 4)}px`;
  }
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
  preparedWordsForArticle:
    | readonly string[]
    | (() => readonly string[] | null),
  onSelect: (wordIndex: number) => void,
): boolean {
  stopWordPicker();
  const resolvePreparedWords = () =>
    typeof preparedWordsForArticle === 'function'
      ? preparedWordsForArticle()
      : preparedWordsForArticle;
  let target: WordTarget | null = buildTarget(
    article,
    resolvePreparedWords() ?? [],
  );
  if (!target) return false;

  const hover = createHover();
  let paintedRoots: readonly HTMLElement[] = [];
  function paintRoots(roots: readonly HTMLElement[]): void {
    for (const root of paintedRoots) {
      if (!roots.includes(root)) root.classList.remove('ttsx-word-picker-active');
    }
    for (const root of roots) root.classList.add('ttsx-word-picker-active');
    paintedRoots = roots;
  }
  paintRoots(target.roots);
  function currentTarget(forceRefresh = false): WordTarget | null {
    if (!target || forceRefresh || targetNeedsRefresh(target)) {
      disposeTarget(target);
      target = buildTarget(article, resolvePreparedWords() ?? []);
      paintRoots(target?.roots ?? []);
    }
    return target;
  }
  const hitFromPoint = (
    clientX: number,
    clientY: number,
    forceRefresh = false,
  ) => {
    const liveTarget = currentTarget(forceRefresh);
    return liveTarget
      ? wordAtPoint(liveTarget, clientX, clientY, forceRefresh)
      : null;
  };
  const hoverScheduler = createHoverScheduler(hitFromPoint, (hit) =>
    paintHover(hover, hit),
  );
  const onClick = (event: MouseEvent) => {
    // Re-snapshot text and geometry at selection time. Hover remains cheap,
    // while a DOM rewrite can never commit a stale word index.
    const hit = hitFromPoint(event.clientX, event.clientY, true);
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
    disposeTarget(target);
    for (const root of paintedRoots) {
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
  const ownedTargets = new Set<WordTarget>();
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
    forceRefresh = false,
  ): WordTarget | null {
    const article = articleAtPoint(clientX, clientY);
    if (!article) return null;
    const cached = targets.get(article);
    if (cached && !forceRefresh && !targetNeedsRefresh(cached)) return cached;
    if (cached) {
      disposeTarget(cached);
      ownedTargets.delete(cached);
      targets.delete(article);
    }
    const preparedWords = preparedWordsForArticle(article);
    if (!preparedWords?.length) return null;
    const target = buildTarget(article, preparedWords);
    if (target) {
      targets.set(article, target);
      ownedTargets.add(target);
    }
    return target;
  }

  const hitFromPoint = (
    clientX: number,
    clientY: number,
    forceRefresh = false,
  ) => {
    const target = targetAtPoint(clientX, clientY, forceRefresh);
    return target
      ? wordAtPoint(target, clientX, clientY, forceRefresh)
      : null;
  };
  const hoverScheduler = createHoverScheduler(hitFromPoint, (hit) => {
    paintActiveRoot(hit?.root ?? null);
    paintHover(hover, hit);
  });
  const onClick = (event: MouseEvent) => {
    const hit = hitFromPoint(event.clientX, event.clientY, true);
    if (!hit) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const selectedTarget = targets.get(hit.article);
    if (selectedTarget) {
      disposeTarget(selectedTarget);
      ownedTargets.delete(selectedTarget);
      targets.delete(hit.article);
    }
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
    for (const target of ownedTargets) disposeTarget(target);
    ownedTargets.clear();
    paintActiveRoot(null);
    hover.remove();
  };
}
