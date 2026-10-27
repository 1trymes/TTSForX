/** Warm a bounded number of nearby posts only while the focused tab is quiet. */
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { extractTweetText } from '../ui/speakerButton';
import { debugHandledFailure } from '../diagnostics';
import { cacheClear, cacheChunkCount, cacheKey } from './cache';
import { engine } from './engine';
import { hardwareBudget } from './hardware';
import { normalizeTtsLanguage } from './languages';
import { prepareTextForSpeech } from './prepareText';
import { QuietWork } from './quietWork';
import { getSettings, loadSettings, onSettingsChange, resolveVoice } from './settings';

const MAX_WARM_CHARS = 12_000;
const visible = new Set<HTMLElement>();
const watched = new Set<HTMLElement>();
let observer: IntersectionObserver | null = null;
let scheduler: QuietWork | null = null;
let activeArticle: HTMLElement | null = null;
let armed = false;
let context: ContentScriptContext | null = null;
let removeSettingsListener: (() => void) | null = null;
let removeEngineListener: (() => void) | null = null;
let connectionEnded = false;
let budget = hardwareBudget();

function userBusy(): boolean {
  const status = engine.getState().status;
  return status === 'playing' || status === 'loading' || status === 'paused';
}

function canRun(): boolean {
  return !!context && !context.isInvalid && !connectionEnded && armed &&
    !document.hidden && document.hasFocus() && !userBusy();
}

export function startPrefetch(ctx: ContentScriptContext): void {
  if (observer) return;
  context = ctx;
  connectionEnded = false;
  budget = hardwareBudget();
  scheduler = new QuietWork(canRun, pump);
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const article = entry.target as HTMLElement;
      if (!article.isConnected) {
        visible.delete(article);
        watched.delete(article);
        observer?.unobserve(article);
      } else if (entry.isIntersecting) {
        visible.add(article);
      } else {
        visible.delete(article);
      }
    }
    if (activeArticle && !visible.has(activeArticle)) scheduler?.pause();
    scheduler?.request();
  }, { root: null, rootMargin: budget.rootMargin, threshold: 0.05 });

  removeSettingsListener = onSettingsChange((settings, previous) => {
    if (previous && (previous.voice !== settings.voice || previous.steps !== settings.steps)) {
      scheduler?.pause();
      cacheClear();
    }
    scheduler?.request();
  });
  removeEngineListener = engine.onState(() => {
    if (userBusy()) scheduler?.pause();
    else scheduler?.request();
  });

  // Constant-time passive handlers: no text extraction or geometry on input.
  const activity = () => scheduler?.activity();
  for (const type of ['scroll', 'wheel', 'touchstart', 'touchmove', 'pointerdown', 'keydown']) {
    ctx.addEventListener(document, type, activity, { capture: true, passive: true });
  }
  ctx.addEventListener(document, 'visibilitychange', activity);
  ctx.addEventListener(window, 'blur', () => scheduler?.pause());
  ctx.addEventListener(window, 'focus', activity);
  ctx.addEventListener(window, 'wxt:locationchange', activity);
  ctx.addEventListener(window, 'pagehide', () => scheduler?.pause());
  ctx.addEventListener(window, 'pageshow', (event) => {
    if (!(event as PageTransitionEvent).persisted) return;
    connectionEnded = false;
    scheduler?.activity();
  });
  ctx.onInvalidated(stopPrefetch);
}

export function watchArticle(article: HTMLElement): void {
  if (!observer || connectionEnded || watched.has(article)) return;
  watched.add(article);
  // IO determines proximity without a layout read after button insertion.
  observer.observe(article);
}

export function armPrefetch(): void {
  armed = true;
  // Loading starts with an eligible warm job, not a timer during scrolling.
  scheduler?.request();
}

function connectedVisibleArticles(): HTMLElement[] {
  for (const article of watched) {
    if (article.isConnected) continue;
    watched.delete(article);
    visible.delete(article);
    observer?.unobserve(article);
  }
  return [...visible];
}

async function pump(signal: AbortSignal): Promise<'more' | 'done' | 'retry'> {
  try {
    await loadSettings();
    if (signal.aborted || !canRun()) return 'done';
    const center = window.innerHeight / 2;
    // Read each candidate's bounds once, then sort cached distances.
    const candidates = connectedVisibleArticles().map((article) => {
      const rect = article.getBoundingClientRect();
      return { article, distance: Math.abs((rect.top + rect.bottom) / 2 - center) };
    }).sort((a, b) => a.distance - b.distance).slice(0, budget.warmPosts);
    const settings = getSettings();
    for (const { article } of candidates) {
      if (signal.aborted || !canRun()) return 'done';
      const raw = extractTweetText(article);
      const prepared = prepareTextForSpeech(raw);
      if (!prepared || prepared.length > MAX_WARM_CHARS) continue;
      const language = normalizeTtsLanguage(article
        .querySelector<HTMLElement>('[data-testid="tweetText"][lang]')?.getAttribute('lang'));
      const key = cacheKey(prepared, resolveVoice(settings), language, settings.steps);
      if (cacheChunkCount(key) >= budget.warmChunks) continue;
      activeArticle = article;
      await engine.synthesize(raw, { silent: true, language, maxChunks: 1, signal });
      return 'more';
    }
    return 'done';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/connection lost|extension context invalidated/i.test(message)) {
      connectionEnded = true;
      return 'done';
    }
    if (!/cancelled/i.test(message)) debugHandledFailure('prefetch failed', error);
    return 'retry';
  } finally {
    activeArticle = null;
  }
}

function stopPrefetch(): void {
  scheduler?.dispose();
  scheduler = null;
  connectionEnded = true;
  armed = false;
  observer?.disconnect();
  observer = null;
  visible.clear();
  watched.clear();
  removeSettingsListener?.();
  removeSettingsListener = null;
  removeEngineListener?.();
  removeEngineListener = null;
  context = null;
}

export function prefetchDebug() {
  return {
    visible: connectedVisibleArticles().length,
    armed,
    connectionEnded,
    modelReady: engine.isModelReady(),
    budget,
  };
}
