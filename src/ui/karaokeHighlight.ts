/**
 * Morphing karaoke pill hosted inside the tweet article.
 * Absolute positioning under the article — scrolls with the post; no scroll
 * listeners or per-frame repositioning.
 */
import { readingTextRoots } from '../x/textRoot';
import {
  alignPreparedWordsToDom,
  buildDomWordsForRoots,
  domWordRects,
  isDomWordConnected,
  mergeWordRectsByLine,
  type DomWord,
} from './domWordMap';
import { paintTtsxRoot } from './theme';

let pills: HTMLDivElement[] = [];
let host: HTMLElement | null = null;
let articleEl: HTMLElement | null = null;
let textRoots: HTMLElement[] = [];
let preparedWords: readonly string[] = [];
let domWords: DomWord[] = [];
/** preparedWordIndex → domWords index */
let alignMap: number[] = [];
let activeDomIndex = -1;
let hostPrevPosition = '';
let revealFrame: number | null = null;
let textObserver: MutationObserver | null = null;
let domDirty = false;

export type KaraokePlacementMotion = 'none' | 'snap' | 'morph';

/**
 * A newly created (or newly resumed) pill has no meaningful previous
 * geometry. Its first placement must therefore snap into position; animating
 * that move would make it travel from the article origin to the first word.
 */
export function karaokePlacementMotion(
  previousDomIndex: number,
  nextDomIndex: number,
): KaraokePlacementMotion {
  if (nextDomIndex < 0 || nextDomIndex === previousDomIndex) return 'none';
  return previousDomIndex < 0 ? 'snap' : 'morph';
}

function cancelPendingReveal(): void {
  if (revealFrame == null) return;
  cancelAnimationFrame(revealFrame);
  revealFrame = null;
}

function ensureHost(article: HTMLElement): HTMLElement {
  if (host?.isConnected && host.parentElement === article) return host;

  teardownHost();
  articleEl = article;

  const style = getComputedStyle(article);
  if (style.position === 'static') {
    hostPrevPosition = article.style.position;
    article.style.position = 'relative';
  } else {
    hostPrevPosition = '';
  }

  host = document.createElement('div');
  host.className = 'ttsx-karaoke-host';
  host.setAttribute('aria-hidden', 'true');
  article.appendChild(host);
  return host;
}

function teardownHost(): void {
  cancelPendingReveal();
  for (const pill of pills) pill.remove();
  pills = [];
  host?.remove();
  host = null;

  if (articleEl) {
    if (articleEl.style.position === 'relative' && hostPrevPosition === '') {
      articleEl.style.position = '';
    } else if (hostPrevPosition) {
      articleEl.style.position = hostPrevPosition;
    }
  }
  hostPrevPosition = '';
}

function ensurePills(
  article: HTMLElement,
  count: number,
): HTMLDivElement[] {
  const currentHost = ensureHost(article);
  pills = pills.filter(
    (pill) => pill.isConnected && pill.parentElement === currentHost,
  );
  while (pills.length > count) pills.pop()?.remove();
  while (pills.length < count) {
    const pill = document.createElement('div');
    pill.className = 'ttsx-karaoke-pill';
    pill.setAttribute('aria-hidden', 'true');
    paintTtsxRoot(pill);
    currentHost.appendChild(pill);
    pills.push(pill);
  }
  return pills;
}

function hidePill(): void {
  cancelPendingReveal();
  for (const pill of pills) pill.classList.remove('ttsx-karaoke-pill--on');
}

function observeTextRoots(roots: readonly HTMLElement[]): void {
  textObserver?.disconnect();
  textObserver = new MutationObserver(() => {
    domDirty = true;
  });
  for (const root of roots) {
    textObserver.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
    });
  }
}

function placePillOver(word: DomWord, morph: boolean): void {
  if (!articleEl?.isConnected) {
    hidePill();
    return;
  }

  const wordRects = mergeWordRectsByLine(domWordRects(word));
  if (!wordRects.length) {
    hidePill();
    return;
  }

  const padX = 3;
  const padY = 1;
  const previousCount = pills.length;
  const elements = ensurePills(articleEl, wordRects.length);
  const articleRect = articleEl.getBoundingClientRect();
  const useMorph = morph && wordRects.length === 1 && previousCount === 1;

  cancelPendingReveal();
  for (let index = 0; index < wordRects.length; index++) {
    const wordRect = wordRects[index]!;
    const element = elements[index]!;
    const x = wordRect.left - articleRect.left + articleEl.scrollLeft - padX;
    const y = wordRect.top - articleRect.top + articleEl.scrollTop - padY;
    const width = Math.max(4, wordRect.width + padX * 2);
    const height = Math.max(4, wordRect.height + padY * 2);
    element.classList.toggle('ttsx-karaoke-pill--snap', !useMorph);
    element.style.width = `${Math.round(width)}px`;
    element.style.height = `${Math.round(height)}px`;
    element.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  if (useMorph) {
    elements[0]!.classList.add('ttsx-karaoke-pill--on');
    return;
  }

  // Multi-line words snap each rendered line fragment into place. Animating a
  // union between those fragments would sweep across unrelated text.
  for (const element of elements) {
    element.classList.remove('ttsx-karaoke-pill--on');
  }
  revealFrame = requestAnimationFrame(() => {
    revealFrame = null;
    if (elements.some((element) => !element.isConnected)) return;
    for (const element of elements) {
      element.classList.add('ttsx-karaoke-pill--on');
    }
    revealFrame = requestAnimationFrame(() => {
      revealFrame = null;
      for (const element of elements) {
        if (element.isConnected) {
          element.classList.remove('ttsx-karaoke-pill--snap');
        }
      }
    });
  });
}

function rebuildDomIfNeeded(): boolean {
  if (!articleEl?.isConnected) return false;
  if (
    !domDirty &&
    textRoots.length &&
    textRoots.every((root) => root.isConnected) &&
    domWords.length &&
    domWords.every(isDomWordConnected)
  ) {
    return true;
  }
  const roots = readingTextRoots(articleEl);
  if (!roots.length || !preparedWords.length) return false;
  textRoots = roots;
  domWords = buildDomWordsForRoots(roots);
  alignMap = alignPreparedWordsToDom(preparedWords, domWords);
  activeDomIndex = -1;
  domDirty = false;
  observeTextRoots(roots);
  return domWords.length > 0;
}

export function startKaraoke(
  article: HTMLElement,
  words: readonly string[],
): void {
  stopKaraoke();
  const roots = readingTextRoots(article);
  if (!roots.length || !words.length) return;

  articleEl = article;
  textRoots = roots;
  preparedWords = words;
  domWords = buildDomWordsForRoots(roots);
  if (!domWords.length) return;
  alignMap = alignPreparedWordsToDom(preparedWords, domWords);
  activeDomIndex = -1;
  domDirty = false;
  observeTextRoots(roots);
}

export function updateKaraoke(preparedWordIndex: number | null): void {
  if (preparedWordIndex == null || preparedWordIndex < 0) {
    hidePill();
    activeDomIndex = -1;
    return;
  }
  if (!rebuildDomIfNeeded()) {
    stopKaraoke();
    return;
  }
  const domIndex = alignMap[preparedWordIndex] ?? -1;
  if (domIndex < 0 || !domWords[domIndex]) return;
  const motion = karaokePlacementMotion(activeDomIndex, domIndex);
  if (motion === 'none') return;
  activeDomIndex = domIndex;
  placePillOver(domWords[domIndex]!, motion === 'morph');
}

export function stopKaraoke(): void {
  teardownHost();
  textObserver?.disconnect();
  textObserver = null;
  domDirty = false;
  articleEl = null;
  textRoots = [];
  preparedWords = [];
  domWords = [];
  alignMap = [];
  activeDomIndex = -1;
}

export function isKaraokeActive(): boolean {
  return articleEl != null;
}
