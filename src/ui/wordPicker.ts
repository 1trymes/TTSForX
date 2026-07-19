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
  words: readonly DomWord[];
  preparedByDom: ReadonlyMap<number, number>;
}

interface WordHit {
  article: HTMLElement;
  root: HTMLElement;
  preparedIndex: number;
  word: DomWord;
}

let activeCleanup: (() => void) | null = null;

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
  return { article, roots, words, preparedByDom };
}

function articleAtPoint(clientX: number, clientY: number): HTMLElement | null {
  const caret = document.caretPositionFromPoint(clientX, clientY);
  if (!caret) return null;
  const element =
    caret.offsetNode instanceof HTMLElement
      ? caret.offsetNode
      : caret.offsetNode.parentElement;
  return (
    element?.closest<HTMLElement>('article[data-testid="tweet"]') ?? null
  );
}

function wordAtPoint(
  target: WordTarget,
  clientX: number,
  clientY: number,
): WordHit | null {
  const caret = document.caretPositionFromPoint(clientX, clientY);
  if (!caret || !(caret.offsetNode instanceof Text)) return null;
  const node = caret.offsetNode;
  const root = target.roots.find((candidate) => candidate.contains(node));
  if (!root) return null;

  for (let domIndex = 0; domIndex < target.words.length; domIndex++) {
    const word = target.words[domIndex]!;
    if (
      word.node !== node ||
      caret.offset < word.start ||
      caret.offset > word.end
    ) {
      continue;
    }
    const preparedIndex = target.preparedByDom.get(domIndex);
    if (preparedIndex == null) return null;
    const rect = domWordRect(word);
    if (
      !rect ||
      clientX < rect.left - 2 ||
      clientX > rect.right + 2 ||
      clientY < rect.top - 2 ||
      clientY > rect.bottom + 2
    ) {
      return null;
    }
    return {
      article: target.article,
      root,
      preparedIndex,
      word,
    };
  }
  return null;
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
  let currentHit: WordHit | null = null;

  const hitFromPointer = (event: PointerEvent | MouseEvent) =>
    wordAtPoint(target, event.clientX, event.clientY);
  const onPointerMove = (event: PointerEvent) => {
    currentHit = hitFromPointer(event);
    paintHover(hover, currentHit);
  };
  const onClick = (event: MouseEvent) => {
    const hit = hitFromPointer(event) ?? currentHit;
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

  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  activeCleanup = () => {
    document.removeEventListener('pointermove', onPointerMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
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
  let currentHit: WordHit | null = null;
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

  const hitFromPointer = (event: PointerEvent | MouseEvent) => {
    const target = targetAtPoint(event.clientX, event.clientY);
    return target
      ? wordAtPoint(target, event.clientX, event.clientY)
      : null;
  };
  const onPointerMove = (event: PointerEvent) => {
    currentHit = hitFromPointer(event);
    paintActiveRoot(currentHit?.root ?? null);
    paintHover(hover, currentHit);
  };
  const onClick = (event: MouseEvent) => {
    const hit = hitFromPointer(event) ?? currentHit;
    if (!hit) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    targets.delete(hit.article);
    currentHit = null;
    paintActiveRoot(null);
    paintHover(hover, null);
    onSelect(hit.article, hit.preparedIndex);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    stopWordPicker();
  };

  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  activeCleanup = () => {
    document.removeEventListener('pointermove', onPointerMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    paintActiveRoot(null);
    hover.remove();
  };
}
