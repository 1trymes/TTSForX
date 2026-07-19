export interface DomWordFragment {
  node: Text;
  start: number;
  end: number;
  text: string;
  /** True when this fragment continues the previous fragment without space. */
  joinsPrevious: boolean;
  /** False for text suppressed by layout/CSS. */
  rendered: boolean;
}

export interface DomWord {
  /** The word exactly as exposed by the rendered surface. */
  text: string;
  /** One word can span any number of wrappers and text nodes. */
  fragments: readonly DomWordFragment[];
}

/**
 * CSS visibility is the boundary between page content and hidden source copies.
 * We deliberately ignore extension-specific classes and aria-hidden: aria-hidden
 * affects accessibility, not whether the user can actually see the text.
 */
function isRenderedElement(
  root: HTMLElement,
  element: HTMLElement,
  cache: WeakMap<HTMLElement, boolean>,
): boolean {
  const cached = cache.get(element);
  if (cached != null) return cached;

  const style = getComputedStyle(element);
  const ownVisibility =
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    style.visibility !== 'collapse' &&
    style.contentVisibility !== 'hidden' &&
    Number.parseFloat(style.opacity || '1') !== 0;
  const parent = element.parentElement;
  const rendered =
    ownVisibility &&
    (element === root ||
      !parent ||
      !root.contains(parent) ||
      isRenderedElement(root, parent, cache));
  cache.set(element, rendered);
  return rendered;
}

function isRenderedTextNode(
  root: HTMLElement,
  node: Text,
  cache: WeakMap<HTMLElement, boolean>,
): boolean {
  const parent = node.parentElement;
  return !!parent && root.contains(node) && isRenderedElement(root, parent, cache);
}

function collectDomFragments(root: HTMLElement): DomWordFragment[] {
  const fragments: DomWordFragment[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const visibilityCache = new WeakMap<HTMLElement, boolean>();
  let previous: DomWordFragment | null = null;
  let canJoinPrevious = false;
  let current = walker.nextNode();
  while (current) {
    const node = current as Text;
    if (isRenderedTextNode(root, node, visibilityCache)) {
      const pattern = /\S+/gu;
      let match: RegExpExecArray | null;
      let consumed = 0;
      while ((match = pattern.exec(node.data))) {
        const separated = /\s/u.test(node.data.slice(consumed, match.index));
        const fragment: DomWordFragment = {
          node,
          start: match.index,
          end: match.index + match[0].length,
          text: match[0],
          joinsPrevious:
            previous != null &&
            canJoinPrevious &&
            !separated,
          rendered: true,
        };
        fragments.push(fragment);
        previous = fragment;
        consumed = fragment.end;
        canJoinPrevious = fragment.end === node.data.length;
      }
      if (/\s/u.test(node.data.slice(consumed))) canJoinPrevious = false;
    }
    current = walker.nextNode();
  }
  return fragments;
}

function canonicalRenderedText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u02bc\u2032\uff07]/gu, "'")
    .replace(/[\u201c\u201d\uff02]/gu, '"')
    .replace(/[\u2010-\u2015\u2212]/gu, '-')
    .replace(/[\u00ad\u200b-\u200d\ufeff\u2060]/giu, '')
    .toLocaleLowerCase();
}

/**
 * Bind rendered words back to their text-node fragments. The rendered word
 * sequence is authoritative; wrappers inserted inside a word are transparent.
 */
export function mapRenderedWordsToDom(
  renderedWords: readonly string[],
  candidates: readonly DomWordFragment[],
): DomWord[] {
  const fragments = candidates.filter((fragment) => fragment.rendered);
  const words: DomWord[] = [];
  let cursor = 0;

  for (const renderedWord of renderedWords) {
    const target = canonicalRenderedText(renderedWord);
    if (!target) continue;

    let matchStart = -1;
    let matchEnd = -1;
    for (let start = cursor; start < fragments.length; start++) {
      let combined = '';
      for (let end = start; end < fragments.length; end++) {
        if (end > start && !fragments[end]!.joinsPrevious) break;
        combined += canonicalRenderedText(fragments[end]!.text);
        if (combined === target) {
          matchStart = start;
          matchEnd = end;
          break;
        }
        if (!target.startsWith(combined)) break;
      }
      if (matchStart >= 0) break;
    }

    if (matchStart < 0 || matchEnd < matchStart) continue;
    words.push({
      text: renderedWord,
      fragments: fragments.slice(matchStart, matchEnd + 1),
    });
    cursor = matchEnd + 1;
  }
  return words;
}

export function buildDomWords(root: HTMLElement): DomWord[] {
  const renderedText = root.innerText ?? root.textContent ?? '';
  const renderedWords = renderedText.match(/\S+/gu) ?? [];
  return mapRenderedWordsToDom(renderedWords, collectDomFragments(root));
}

/** Preserve visual reading order across an X Article title and body. */
export function buildDomWordsForRoots(
  roots: readonly HTMLElement[],
): DomWord[] {
  return roots.flatMap((root) => buildDomWords(root));
}

function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function looksLikeUrl(word: string): boolean {
  return /^(https?:\/\/|www\.|t\.co\/|bit\.ly\/|pic\.(?:twitter|x)\.com\/)/iu.test(
    word,
  );
}

/**
 * Map the prepared TTS word sequence to the visible DOM word sequence.
 * Karaoke and direct word picking share this exact mapping.
 */
export function alignPreparedWordsToDom(
  prepared: readonly string[],
  dom: readonly DomWord[],
): number[] {
  const map = new Array<number>(prepared.length).fill(-1);
  let domIndex = 0;
  for (let preparedIndex = 0; preparedIndex < prepared.length; preparedIndex++) {
    const preparedRaw = prepared[preparedIndex]!;
    const preparedToken = normalizeWord(preparedRaw);
    const wantsLink = preparedToken === 'link';
    while (domIndex < dom.length) {
      const visible = dom[domIndex]!.text;
      const domToken = normalizeWord(visible);
      const matches =
        (wantsLink && looksLikeUrl(visible)) ||
        (preparedToken.length > 0 &&
          domToken.length > 0 &&
          (preparedToken === domToken ||
            (preparedToken.length >= 3 && domToken.includes(preparedToken)) ||
            (domToken.length >= 3 && preparedToken.includes(domToken)))) ||
        (!preparedToken && !domToken && preparedRaw === visible);
      if (matches) {
        map[preparedIndex] = domIndex;
        domIndex++;
        break;
      }
      domIndex++;
    }
  }
  return map;
}

export function preparedIndexByDomIndex(
  preparedToDom: readonly number[],
): Map<number, number> {
  const reverse = new Map<number, number>();
  for (
    let preparedIndex = 0;
    preparedIndex < preparedToDom.length;
    preparedIndex++
  ) {
    const domIndex = preparedToDom[preparedIndex] ?? -1;
    if (domIndex >= 0) reverse.set(domIndex, preparedIndex);
  }
  return reverse;
}

export function isDomWordConnected(word: DomWord): boolean {
  return word.fragments.every((fragment) => fragment.node.isConnected);
}

export function domWordRect(word: DomWord): DOMRect | null {
  const rects = domWordRects(word);
  if (!rects.length) return null;

  let left = rects[0]!.left;
  let top = rects[0]!.top;
  let right = rects[0]!.right;
  let bottom = rects[0]!.bottom;
  for (let index = 1; index < rects.length; index++) {
    const rect = rects[index]!;
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }
  return new DOMRect(left, top, right - left, bottom - top);
}

/** Exact rendered fragments for pointer hit testing. */
export function domWordRects(word: DomWord): DOMRect[] {
  const rects: DOMRect[] = [];
  for (const fragment of word.fragments) {
    const range = document.createRange();
    try {
      range.setStart(fragment.node, fragment.start);
      range.setEnd(fragment.node, fragment.end);
    } catch {
      continue;
    }
    for (const rect of range.getClientRects()) {
      if (rect.width <= 0 || rect.height <= 0) continue;
      rects.push(new DOMRect(rect.left, rect.top, rect.width, rect.height));
    }
  }
  return rects;
}
