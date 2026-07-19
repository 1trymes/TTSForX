/**
 * Centralized X.com DOM selectors.
 *
 * X.com exposes stable `data-testid` hooks that have remained constant for
 * years, even as class names are hashed and rotated on every deploy. We anchor
 * to those exclusively so the extension survives X's daily CSS churn. When X
 * eventually renames a testid, this is the single file to update.
 */
export const SELECTORS = {
  /** A single tweet (post) — the top-level article. */
  tweet: 'article[data-testid="tweet"]',
  /** The post's text node(s). Quote-tweets and threads may contain several. */
  tweetText: '[data-testid="tweetText"]',
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
