import { readingTextRoots } from '../x/textRoot';
import {
  alignPreparedWordsToDom,
  buildDomWordsForRoots,
  domWordRect,
  preparedIndexByDomIndex,
  type DomWord,
} from './domWordMap';
import { paintTtsxRoot } from './theme';

interface WordTarget {
  article: HTMLElement;
  roots: readonly HTMLElement[];
  preparedByDom: ReadonlyMap<number, number>;
  wordsByNode: ReadonlyMap<Text, readonly IndexedWord[]>;
  wordsByElement: ReadonlyMap<Element, readonly IndexedWord[]>;
}

interface IndexedWord {
  domIndex: number;
  word: DomWord;
}

interface WordHit {
  article: HTMLElement;
  root: HTMLElement;
  preparedIndex: number;
  word: DomWord;
}

let activeCleanup: (() => void) | null = null;

function appendIndexedWord<K>(
  map: Map<K, IndexedWord[]>,
  key: K,
  indexed: IndexedWord,
): void {
  const current = map.get(key);
  if (current) current.push(indexed);
  else map.set(key, [indexed]);
}

function buildTarget(
  article: HTMLElement,
  preparedWords: readonly string[],
): WordTarget | null {
  const roots = readingTextRoots(article);
  if (!roots.length || !preparedWords.length) return null;
  const words = buildDomWordsForRoots(roots);
  const preparedByDom = preparedIndexByDomIndex(
    alignPreparedWordsToDom(preparedWords, words),
  );
  if (!preparedByDom.size) return null;
  const wordsByNode = new Map<Text, IndexedWord[]>();
  const wordsByElement = new Map<Element, IndexedWord[]>();
  const rootSet = new Set<HTMLElement>(roots);
  for (let domIndex = 0; domIndex < words.length; domIndex++) {
    const word = words[domIndex]!;
    const indexed = { domIndex, word };
    appendIndexedWord(wordsByNode, word.node, indexed);
    let element: HTMLElement | null = word.node.parentElement;
    while (element) {
      appendIndexedWord(wordsByElement, element, indexed);
      if (rootSet.has(element)) break;
      element = element.parentElement;
    }
  }
  return {
    article,
    roots,
    preparedByDom,
    wordsByNode,
    wordsByElement,
  };
}

function articleAtPoint(clientX: number, clientY: number): HTMLElement | null {
  const element = document.elementFromPoint(clientX, clientY);
  return (
    element?.closest<HTMLElement>('article[data-testid="tweet"]') ?? null
  );
}

interface CaretPoint {
  node: Node;
  offset: number;
}

type CaretDocument = Document & {
  caretPositionFromPoint?: (
    x: number,
    y: number,
  ) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

function caretAtPoint(clientX: number, clientY: number): CaretPoint | null {
  const doc = document as CaretDocument;
  try {
    const position = doc.caretPositionFromPoint?.(clientX, clientY);
    if (position) return { node: position.offsetNode, offset: position.offset };
  } catch {
    /* spatial hit testing below remains authoritative */
  }
  try {
    const range = doc.caretRangeFromPoint?.(clientX, clientY);
    if (range) {
      return { node: range.startContainer, offset: range.startOffset };
    }
  } catch {
    /* spatial hit testing below remains authoritative */
  }
  return null;
}

export function wordRectContainsPoint(
  rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>,
  clientX: number,
  clientY: number,
  padding = 2,
): boolean {
  return (
    clientX >= rect.left - padding &&
    clientX <= rect.right + padding &&
    clientY >= rect.top - padding &&
    clientY <= rect.bottom + padding
  );
}

function hitIndexedWord(
  target: WordTarget,
  root: HTMLElement,
  indexed: IndexedWord,
  clientX: number,
  clientY: number,
): WordHit | null {
  const preparedIndex = target.preparedByDom.get(indexed.domIndex);
  if (preparedIndex == null) return null;
  const rect = domWordRect(indexed.word);
  if (!rect || !wordRectContainsPoint(rect, clientX, clientY)) return null;
  return {
    article: target.article,
    root,
    preparedIndex,
    word: indexed.word,
  };
}

function rootForNode(
  target: WordTarget,
  node: Node | null,
): HTMLElement | null {
  if (!node) return null;
  return target.roots.find((root) => root.contains(node)) ?? null;
}

function wordAtPoint(
  target: WordTarget,
  clientX: number,
  clientY: number,
): WordHit | null {
  const element = document.elementFromPoint(clientX, clientY);
  const caret = caretAtPoint(clientX, clientY);
  const root =
    rootForNode(target, element) ?? rootForNode(target, caret?.node ?? null);
  if (!root) return null;

  // Fast path: use the browser's caret boundary, then confirm with the
  // rendered word rectangle so a block-edge caret cannot select a neighbour.
  if (caret?.node instanceof Text) {
    for (const indexed of target.wordsByNode.get(caret.node) ?? []) {
      const { word } = indexed;
      if (caret.offset < word.start || caret.offset > word.end) continue;
      const hit = hitIndexedWord(target, root, indexed, clientX, clientY);
      if (hit) return hit;
    }
  }

  // Chromium can resolve the first glyph of a block to the previous block's
  // caret. Scan only the text-bearing element under the pointer as a precise
  // spatial fallback; this also keeps contractions such as “I’ve” intact.
  let candidateElement: Element | null = element;
  while (candidateElement && root.contains(candidateElement)) {
    const candidates = target.wordsByElement.get(candidateElement);
    if (candidates) {
      for (const indexed of candidates) {
        const hit = hitIndexedWord(target, root, indexed, clientX, clientY);
        if (hit) return hit;
      }
    }
    if (candidateElement === root) break;
    candidateElement = candidateElement.parentElement;
  }
  return null;
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
