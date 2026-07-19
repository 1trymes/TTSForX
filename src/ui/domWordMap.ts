export interface DomWord {
  node: Text;
  start: number;
  end: number;
}

export function buildDomWords(root: HTMLElement): DomWord[] {
  const words: DomWord[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    const node = current as Text;
    const pattern = /\S+/gu;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(node.data))) {
      words.push({
        node,
        start: match.index,
        end: match.index + match[0].length,
      });
    }
    current = walker.nextNode();
  }
  return words;
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
      const domWord = dom[domIndex]!;
      const visible = domWord.node.data.slice(domWord.start, domWord.end);
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
  const range = document.createRange();
  try {
    range.setStart(word.node, word.start);
    range.setEnd(word.node, word.end);
  } catch {
    return [];
  }
  const rects = range.getClientRects();
  return Array.from(rects, (rect) =>
    new DOMRect(rect.left, rect.top, rect.width, rect.height),
  ).filter((rect) => rect.width > 0 && rect.height > 0);
}
