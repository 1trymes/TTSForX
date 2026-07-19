/**
 * DOM observer — mount speaker buttons on tweets.
 *
 * X.com mutates constantly (ads, counters, virtualized feed). Scanning the
 * whole document on every mutation melts the tab. We:
 *  - debounce scans (~350ms)
 *  - prefer mounting only newly added <article> nodes
 *  - fall back to a full scan rarely (boot / navigation / idle catch-up)
 */
import { watchArticle } from '../tts/prefetch';
import { mountSpeakerButton } from '../ui/speakerButton';
import { debugHandledFailure } from '../diagnostics';
import { SELECTORS } from './selectors';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';

const WATCHED_ATTR = 'data-ttsx-watched';
/** Coalesce mutation storms; X fires hundreds per second while scrolling. */
const SCAN_DEBOUNCE_MS = 350;
/** Periodic full scan to catch anything the incremental path missed. */
const FULL_SCAN_IDLE_MS = 4000;

let observer: MutationObserver | null = null;
let debounceTimer: number | null = null;
let fullScanTimer: number | null = null;
let pendingArticles = new Set<HTMLElement>();
let wantFullScan = false;
let context: ContentScriptContext | null = null;

function mountOne(tweet: HTMLElement): boolean {
  const before = !!tweet.querySelector('.ttsx-action');
  try {
    mountSpeakerButton(tweet);
    const after = !!tweet.querySelector('.ttsx-action');
    if (after && !tweet.hasAttribute(WATCHED_ATTR)) {
      watchArticle(tweet);
      tweet.setAttribute(WATCHED_ATTR, '1');
    } else if (!after && tweet.hasAttribute(WATCHED_ATTR)) {
      tweet.removeAttribute(WATCHED_ATTR);
    }
    return !before && after;
  } catch (err) {
    debugHandledFailure('mount failed', err);
    return false;
  }
}

function runScan(reason: string): void {
  debounceTimer = null;
  if (!context || context.isInvalid) return;
  let mounted = 0;

  if (wantFullScan || reason.startsWith('boot') || reason === 'nav') {
    wantFullScan = false;
    pendingArticles.clear();
    const tweets = document.querySelectorAll<HTMLElement>(SELECTORS.tweet);
    tweets.forEach((tweet) => {
      if (mountOne(tweet)) mounted++;
    });
  } else if (pendingArticles.size) {
    for (const tweet of pendingArticles) {
      if (!tweet.isConnected) continue;
      if (mountOne(tweet)) mounted++;
    }
    pendingArticles.clear();
  }

  if (mounted && import.meta.env.DEV) {
    console.debug(`[TTSForX] scan(${reason}): ${mounted} new button(s)`);
  }
  if (typeof window !== 'undefined') {
    (window as unknown as { __ttsxScan?: (r?: string) => void }).__ttsxScan = (
      r = 'manual',
    ) => {
      wantFullScan = true;
      runScan(r);
    };
  }
}

function queueScan(reason: string, full = false): void {
  if (!context || context.isInvalid) return;
  if (full) wantFullScan = true;
  if (debounceTimer != null) return;
  debounceTimer = context.setTimeout(
    () => runScan(reason),
    SCAN_DEBOUNCE_MS,
  );
}

function collectArticles(root: Node, into: Set<HTMLElement>): void {
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const el = root as HTMLElement;
  if (el.matches?.(SELECTORS.tweet)) {
    into.add(el);
    return;
  }
  if (!el.querySelectorAll) return;
  for (const a of el.querySelectorAll<HTMLElement>(SELECTORS.tweet)) {
    into.add(a);
  }
}

/** Coalesce a burst of mutations into a single delayed scan. */
export function scheduleScan(): void {
  queueScan('mutation', true);
}

function scheduleFullCatchUp(): void {
  if (!context || context.isInvalid) return;
  if (fullScanTimer != null) clearTimeout(fullScanTimer);
  fullScanTimer = context.setTimeout(() => {
    fullScanTimer = null;
    if (document.hidden) return;
    queueScan('idle-full', true);
  }, FULL_SCAN_IDLE_MS);
}

/** Use WXT's lifecycle-aware SPA navigation watcher. */
function hookNavigation(ctx: ContentScriptContext): void {
  ctx.addEventListener(window, 'wxt:locationchange', () => {
    queueScan('nav', true);
    scheduleFullCatchUp();
  });
}

/** Boot the observer. Idempotent. */
export function startObserver(ctx: ContentScriptContext): void {
  if (observer) return;
  context = ctx;
  ctx.onInvalidated(stopObserver);
  wantFullScan = true;
  runScan('boot');
  ctx.setTimeout(() => queueScan('boot+800', true), 800);
  ctx.setTimeout(() => queueScan('boot+2500', true), 2500);

  observer = new MutationObserver((records) => {
    if (document.hidden) return;
    let sawArticle = false;
    for (const rec of records) {
      for (const node of rec.addedNodes) {
        collectArticles(node, pendingArticles);
        if (pendingArticles.size) sawArticle = true;
      }
      // Action bars sometimes re-render without replacing the article.
      if (rec.type === 'childList' && rec.target instanceof HTMLElement) {
        const art = rec.target.closest?.('article');
        if (art && art.matches?.(SELECTORS.tweet)) {
          pendingArticles.add(art as HTMLElement);
          sawArticle = true;
        }
      }
    }
    if (sawArticle) queueScan('mutation-add', false);
    else scheduleFullCatchUp();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  hookNavigation(ctx);
}

function stopObserver(): void {
  observer?.disconnect();
  observer = null;
  if (debounceTimer != null) clearTimeout(debounceTimer);
  if (fullScanTimer != null) clearTimeout(fullScanTimer);
  debounceTimer = null;
  fullScanTimer = null;
  pendingArticles.clear();
  wantFullScan = false;
  context = null;
  delete (window as unknown as { __ttsxScan?: (reason?: string) => void })
    .__ttsxScan;
}
