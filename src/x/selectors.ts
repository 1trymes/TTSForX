/** Selectors for both the older and current X post layouts. */
export const SELECTORS = {
  /** A single tweet (post) — the top-level article. */
  tweet: 'article[data-testid="tweet"], article:not([data-testid])',
  /** The post's text node(s). Quote-tweets and threads may contain several. */
  tweetText: '[data-testid="tweetText"]',
  modernTweetText: 'div[dir="auto"].whitespace-pre-wrap.wrap-break-word',
  /** Quoted post card (exclude its text from read-aloud). */
  quoteTweet: '[data-testid="quoteTweet"]',
  /** The reply/repost/like/share action row. */
  replyButton: '[data-testid="reply"]',
  /** The role used by X for the action-bar container. */
  actionBarGroup: '[role="group"]',
} as const;

/**
 * Attribute stamped on each tweet once we've injected our button, so the
 * MutationObserver stays idempotent across infinite-scroll and re-renders.
 */
export const MARKED_ATTR = 'data-ttsx-mounted';
