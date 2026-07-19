/**
 * Prefetch TTS for tweets near the viewport.
 *
 * Strategy (keeps weak machines alive):
 *  - Never load a second Supertonic 3 model
 *  - Never expand "Show more"; only an explicit playback gesture may do it
 *  - Warm first 1–2 chunks of the nearest N posts (instant tap + lookahead)
 *  - Long posts still get a warm start (full synth stays length-capped)
 *  - Optionally finish a smaller number fully
 *  - Caps from hardwareBudget(); pause when tab hidden
 *  - User taps always jump the synth queue (engine priority)
 */
import { extractTweetText } from '../ui/speakerButton';
import { debugHandledFailure } from '../diagnostics';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import {
  cacheClear,
  cacheChunkCount,
  cacheGet,
  cacheKey,
} from './cache';
import { engine } from './engine';
import { hardwareBudget } from './hardware';
import { normalizeTtsLanguage } from './languages';
import { prepareTextForSpeech } from './prepareText';
import {
  getSettings,
  loadSettings,
  onSettingsChange,
  resolveVoice,
} from './settings';

type Job = {
  article: HTMLElement;
  text: string;
  key: string;
  language: string;
  dist: number;
  chars: number;
};

/** Refuse absurdly long notes so warm can't monopolize the queue. */
const MAX_WARM_CHARS = 12_000;

const visible = new Set<HTMLElement>();
const watched = new Set<HTMLElement>();
let observer: IntersectionObserver | null = null;
let running = false;
let scheduled = false;
let armed = false;
let context: ContentScriptContext | null = null;
let removeSettingsListener: (() => void) | null = null;
let removeEngineListener: (() => void) | null = null;
// A disconnected content port after an extension reload cannot recover in the
// old isolated world. Stop background work; the freshly injected script on the
// next navigation owns warm-up from that point onward.
let connectionEnded = false;
let budget = hardwareBudget();

export function startPrefetch(ctx: ContentScriptContext): void {
  if (observer) return;
  context = ctx;
  connectionEnded = false;
  budget = hardwareBudget();
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        if (!el.isConnected) {
          visible.delete(el);
          watched.delete(el);
          observer?.unobserve(el);
        } else if (entry.isIntersecting) {
          visible.add(el);
        } else {
          visible.delete(el);
        }
      }
      schedule(true);
    },
    { root: null, rootMargin: budget.rootMargin, threshold: 0.05 },
  );

  removeSettingsListener = onSettingsChange((s, prev) => {
    if (prev && (prev.voice !== s.voice || prev.steps !== s.steps)) {
      cacheClear();
    }
    schedule(true);
  });

  removeEngineListener = engine.onState((state) => {
    if (state.status === 'idle') schedule(true);
  });

  ctx.addEventListener(document, 'visibilitychange', () => {
    if (!document.hidden) schedule(true);
  });
  ctx.onInvalidated(stopPrefetch);
}

export function watchArticle(article: HTMLElement): void {
  if (!observer || connectionEnded) return;
  if (!watched.has(article)) {
    watched.add(article);
    observer!.observe(article);
  }
  const r = article.getBoundingClientRect();
  const margin = 240;
  if (r.bottom > -margin && r.top < window.innerHeight + margin) {
    visible.add(article);
    schedule(true);
  }
}

export function armPrefetch(): void {
  if (armed) {
    schedule(true);
    return;
  }
  armed = true;
  engine.preload();
  schedule(true);
}

function schedule(immediate = false): void {
  if (
    !context ||
    context.isInvalid ||
    connectionEnded ||
    !armed ||
    running ||
    scheduled ||
    document.hidden
  ) {
    return;
  }
  scheduled = true;
  const kick = () => {
    scheduled = false;
    void pump();
  };
  // Prefer idle time; never kick on the next animation frame while scrolling.
  if (immediate) {
    context.setTimeout(kick, 400);
    return;
  }
  if (typeof requestIdleCallback === 'function') {
    context.requestIdleCallback(kick, { timeout: 2000 });
  } else {
    context.setTimeout(kick, 800);
  }
}

function articleDist(article: HTMLElement): number {
  const r = article.getBoundingClientRect();
  return Math.abs((r.top + r.bottom) / 2 - window.innerHeight / 2);
}

function connectedVisibleArticles(): HTMLElement[] {
  for (const article of watched) {
    if (article.isConnected) continue;
    watched.delete(article);
    visible.delete(article);
    observer?.unobserve(article);
  }
  return [...visible].filter((article) => article.isConnected);
}

function voiceKeyForPrepared(prepared: string, language: string): string {
  const settings = getSettings();
  const voice = resolveVoice(settings);
  return cacheKey(prepared, voice, language, settings.steps);
}

function languageForArticle(article: HTMLElement): string {
  return normalizeTtsLanguage(
    article
      .querySelector<HTMLElement>('[data-testid="tweetText"][lang]')
      ?.getAttribute('lang'),
  );
}

async function jobForArticle(article: HTMLElement): Promise<Job | null> {
  if (!article.isConnected) return null;
  // Background discovery is read-only. Long posts remain collapsed until
  // the user explicitly presses the speaker or activates Start from.
  const raw = extractTweetText(article);
  const text = prepareTextForSpeech(raw);
  if (!text || text.length > MAX_WARM_CHARS) return null;
  const language = languageForArticle(article);

  return {
    article,
    text: raw,
    key: voiceKeyForPrepared(text, language),
    language,
    dist: articleDist(article),
    chars: text.length,
  };
}

function userBusy(): boolean {
  const s = engine.getState().status;
  return s === 'playing' || s === 'loading' || s === 'paused';
}

async function pump(): Promise<void> {
  if (
    !context ||
    context.isInvalid ||
    connectionEnded ||
    running ||
    !armed ||
    document.hidden ||
    userBusy()
  ) {
    return;
  }
  running = true;
  try {
    await loadSettings();
    budget = hardwareBudget();
    if (userBusy()) return;
    const warmN = budget.warmChunks;

    const articles = connectedVisibleArticles();
    articles.sort((a, b) => articleDist(a) - articleDist(b));
    // Only expand/warm the nearest few — don't blow open the whole feed.
    const candidates = articles.slice(
      0,
      Math.max(budget.warmPosts, budget.fullPosts) + 2,
    );

    const jobs: Job[] = [];
    for (const article of candidates) {
      if (context.isInvalid || document.hidden) break;
      const job = await jobForArticle(article);
      if (job) jobs.push(job);
    }
    jobs.sort((a, b) => a.dist - b.dist);

    const warmTargets = jobs
      .filter((j) => cacheChunkCount(j.key) < warmN)
      .slice(0, budget.warmPosts);

    for (const job of warmTargets) {
      if (context.isInvalid || document.hidden || userBusy()) break;
      const have = cacheChunkCount(job.key);
      try {
        await engine.synthesize(job.text, {
          silent: true,
          language: job.language,
          startChunk: have,
          maxChunks: Math.max(1, warmN - have),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/cancelled/i.test(msg)) break;
        if (/connection lost|extension context invalidated/i.test(msg)) {
          connectionEnded = true;
          break;
        }
        debugHandledFailure('warm failed', err);
      }
    }

    if (budget.fullPosts > 0 && !document.hidden && !userBusy()) {
      const fullTargets = jobs
        .filter((j) => {
          if (j.chars > budget.maxPrefetchChars) return false;
          const hit = cacheGet(j.key);
          return hit && !hit.complete;
        })
        .slice(0, budget.fullPosts);

      for (const job of fullTargets) {
        if (context.isInvalid || document.hidden || userBusy()) break;
        const hit = cacheGet(job.key);
        const start = hit?.chunks.length ?? 0;
        try {
          await engine.synthesize(job.text, {
            silent: true,
            language: job.language,
            startChunk: start,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/cancelled/i.test(msg)) break;
          if (/connection lost|extension context invalidated/i.test(msg)) {
            connectionEnded = true;
            break;
          }
          debugHandledFailure('full prefetch failed', err);
        }
      }
    }
  } finally {
    running = false;
    if (needsMoreWork()) schedule(false);
  }
}

function needsMoreWork(): boolean {
  if (!context || context.isInvalid || connectionEnded) return false;
  const warmN = budget.warmChunks;
  const articles = connectedVisibleArticles();
  articles.sort((a, b) => articleDist(a) - articleDist(b));

  for (const article of articles.slice(0, budget.warmPosts)) {
    const raw = extractTweetText(article);
    const text = prepareTextForSpeech(raw);
    if (!text || text.length > MAX_WARM_CHARS) continue;
    if (
      cacheChunkCount(voiceKeyForPrepared(text, languageForArticle(article))) <
      warmN
    ) {
      return true;
    }
  }
  return false;
}

function stopPrefetch(): void {
  connectionEnded = true;
  armed = false;
  scheduled = false;
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

export function prefetchDebug(): {
  visible: number;
  armed: boolean;
  connectionEnded: boolean;
  modelReady: boolean;
  budget: ReturnType<typeof hardwareBudget>;
} {
  return {
    visible: connectedVisibleArticles().length,
    armed,
    connectionEnded,
    modelReady: engine.isModelReady(),
    budget,
  };
}
