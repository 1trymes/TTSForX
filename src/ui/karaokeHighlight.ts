/**
 * Morphing karaoke pill hosted inside the tweet article.
 * Absolute positioning under the article — scrolls with the post; no scroll
 * listeners or per-frame repositioning.
 */
import { primaryReadingTextRoot } from '../x/textRoot';
import {
  alignPreparedWordsToDom,
  buildDomWords,
  domWordRect,
  type DomWord,
} from './domWordMap';
import { paintTtsxRoot } from './theme';

let pill: HTMLDivElement | null = null;
let host: HTMLElement | null = null;
let articleEl: HTMLElement | null = null;
let textRoot: HTMLElement | null = null;
let preparedWords: readonly string[] = [];
let domWords: DomWord[] = [];
/** preparedWordIndex → domWords index */
let alignMap: number[] = [];
let activeDomIndex = -1;
let hostPrevPosition = '';

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
  pill?.remove();
  pill = null;
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

function ensurePill(article: HTMLElement): HTMLDivElement {
  const currentHost = ensureHost(article);
  if (pill?.isConnected && pill.parentElement === currentHost) return pill;

  pill = document.createElement('div');
  pill.className = 'ttsx-karaoke-pill';
  pill.setAttribute('aria-hidden', 'true');
  paintTtsxRoot(pill);
  currentHost.appendChild(pill);
  return pill;
}

function hidePill(): void {
  pill?.classList.remove('ttsx-karaoke-pill--on');
}

function placePillOver(word: DomWord, morph: boolean): void {
  if (!articleEl?.isConnected) {
    hidePill();
    return;
  }

  const wordRect = domWordRect(word);
  if (!wordRect) {
    hidePill();
    return;
  }

  const padX = 3;
  const padY = 1;
  const el = ensurePill(articleEl);
  const articleRect = articleEl.getBoundingClientRect();
  const x = wordRect.left - articleRect.left + articleEl.scrollLeft - padX;
  const y = wordRect.top - articleRect.top + articleEl.scrollTop - padY;
  const width = Math.max(4, wordRect.width + padX * 2);
  const height = Math.max(4, wordRect.height + padY * 2);

  el.classList.toggle('ttsx-karaoke-pill--snap', !morph);
  el.style.width = `${Math.round(width)}px`;
  el.style.height = `${Math.round(height)}px`;
  el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  el.classList.add('ttsx-karaoke-pill--on');
}

function rebuildDomIfNeeded(): boolean {
  if (!articleEl?.isConnected) return false;
  if (textRoot?.isConnected && domWords.length) return true;
  const root = primaryReadingTextRoot(articleEl);
  if (!root || !preparedWords.length) return false;
  textRoot = root;
  domWords = buildDomWords(root);
  alignMap = alignPreparedWordsToDom(preparedWords, domWords);
  return domWords.length > 0;
}

export function startKaraoke(
  article: HTMLElement,
  words: readonly string[],
): void {
  stopKaraoke();
  const root = primaryReadingTextRoot(article);
  if (!root || !words.length) return;

  articleEl = article;
  textRoot = root;
  preparedWords = words;
  domWords = buildDomWords(root);
  if (!domWords.length) return;
  alignMap = alignPreparedWordsToDom(preparedWords, domWords);
  activeDomIndex = -1;
  ensurePill(article);
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
  if (domIndex === activeDomIndex) return;
  activeDomIndex = domIndex;
  placePillOver(domWords[domIndex]!, true);
}

export function stopKaraoke(): void {
  teardownHost();
  articleEl = null;
  textRoot = null;
  preparedWords = [];
  domWords = [];
  alignMap = [];
  activeDomIndex = -1;
}

export function isKaraokeActive(): boolean {
  return articleEl != null;
}
