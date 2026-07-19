import { SELECTORS } from './selectors';

export const LONG_FORM_TEXT_ROOT =
  '[data-testid="twitterArticleRichTextView"], [data-testid="note-text"]';

/** True when a candidate belongs to a quote, card, or nested post. */
function isForeignTextRoot(
  node: HTMLElement,
  article: HTMLElement,
): boolean {
  const nested = node.closest('article');
  if (nested && nested !== article) return true;
  if (node.closest('[data-testid="quoteTweet"]')) return true;
  if (node.closest('[data-testid="card.wrapper"]')) return true;

  // Quotes are sometimes role=link islands instead of nested articles.
  let current: HTMLElement | null = node.parentElement;
  while (current && current !== article) {
    if (
      current.getAttribute('role') === 'link' &&
      current.querySelector('[data-testid="User-Name"]')
    ) {
      const link = current;
      return [
        ...article.querySelectorAll<HTMLElement>(SELECTORS.tweetText),
      ].some((text) => text !== node && !link.contains(text));
    }
    current = current.parentElement;
  }
  return false;
}

/**
 * Resolve the one DOM surface whose text is sent to TTS. Karaoke imports this
 * same function so audio and captions cannot disagree across timeline posts,
 * status pages, Notes, or long-form X Articles.
 */
export function primaryReadingTextRoot(
  article: HTMLElement,
): HTMLElement | null {
  for (const node of article.querySelectorAll<HTMLElement>(
    SELECTORS.tweetText,
  )) {
    if (!isForeignTextRoot(node, article)) return node;
  }

  for (const node of article.querySelectorAll<HTMLElement>(
    LONG_FORM_TEXT_ROOT,
  )) {
    if (!isForeignTextRoot(node, article)) return node;
  }
  return null;
}
