import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';

const mock = vi.hoisted(() => ({
  synthesize: vi.fn(), preload: vi.fn(), cached: new Set<string>(),
  status: 'idle', stateListener: (_state: { status: string }) => {},
}));
vi.mock('../src/ui/speakerButton', () => ({ extractTweetText: (a: { text: string }) => a.text }));
vi.mock('../src/tts/engine', () => ({ engine: {
  synthesize: mock.synthesize, preload: mock.preload,
  getState: () => ({ status: mock.status }), isModelReady: () => true,
  onState: (listener: typeof mock.stateListener) => { mock.stateListener = listener; return () => {}; },
} }));
vi.mock('../src/tts/settings', () => ({
  getSettings: () => ({ voice: 'M1', steps: 8 }),
  resolveVoice: () => 'M1', loadSettings: async () => ({}),
  onSettingsChange: () => () => {},
}));
vi.mock('../src/tts/cache', () => ({
  cacheClear: () => mock.cached.clear(),
  cacheKey: (text: string) => text,
  cacheChunkCount: (key: string) => mock.cached.has(key) ? 1 : 0,
  cacheGet: () => null,
}));

let doc: EventTarget & { hidden: boolean; hasFocus: () => boolean };
let win: EventTarget & { innerHeight: number };
let focus = true;
let invalidations: Array<() => void>;
let timers: Array<ReturnType<typeof setTimeout>>;
let intersect: (entries: Array<{ target: HTMLElement; isIntersecting: boolean }>) => void;
let api: typeof import('../src/tts/prefetch');
let context: ContentScriptContext;
let geometryReads: number;
let cancellations: number;
let starts: number[];

function article(id: number, y = 100): HTMLElement {
  return {
    text: `Post ${id} has a sentence to read.`, isConnected: true,
    querySelector: () => null,
    getBoundingClientRect: () => { geometryReads++; return { top: y, bottom: y + 150 }; },
  } as unknown as HTMLElement;
}
function expose(items: HTMLElement[], isIntersecting = true): void {
  intersect(items.map(target => ({ target, isIntersecting })));
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(0);
  focus = true;
  geometryReads = 0;
  cancellations = 0;
  starts = [];
  mock.cached.clear();
  mock.status = 'idle';
  mock.preload.mockClear();
  mock.synthesize.mockReset();
  mock.synthesize.mockImplementation((text: string, options: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
    starts.push(Date.now());
    const timer = setTimeout(() => { mock.cached.add(text); resolve({}); }, 250);
    options.signal?.addEventListener('abort', () => {
      clearTimeout(timer); cancellations++; reject(new Error('cancelled'));
    }, { once: true });
  }));
  doc = Object.assign(new EventTarget(), { hidden: false, hasFocus: () => focus });
  win = Object.assign(new EventTarget(), { innerHeight: 800 });
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', win);
  vi.stubGlobal('navigator', { hardwareConcurrency: 16, deviceMemory: 8 });
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: typeof intersect) { intersect = callback; }
    observe() {} unobserve() {} disconnect() {}
  });
  invalidations = [];
  timers = [];
  context = {
    isInvalid: false,
    addEventListener: (target: EventTarget, type: string, callback: EventListener, options?: AddEventListenerOptions) => {
      target.addEventListener(type, callback, options);
      invalidations.push(() => target.removeEventListener(type, callback, options));
    },
    onInvalidated: (callback: () => void) => invalidations.push(callback),
    setTimeout: (callback: () => void, ms: number) => { const timer = setTimeout(callback, ms); timers.push(timer); return timer; },
  } as unknown as ContentScriptContext;
  // The benchmark runner materializes the real previous module in ignored output.
  const baselinePath = '../.output/research/prefetch-before.ts';
  api = process.env.TTSX_PREFETCH_BASELINE
    ? await import(/* @vite-ignore */ baselinePath)
    : await import('../src/tts/prefetch');
});
afterEach(() => {
  for (const invalidate of invalidations) invalidate();
  for (const timer of timers) clearTimeout(timer);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('prefetch integration', () => {
  it('uses IO instead of a synchronous geometry read when mounting', () => {
    api.startPrefetch(context);
    api.watchArticle(article(1));
    expect(geometryReads).toBe(0);
    api.armPrefetch();
    expect(mock.preload).not.toHaveBeenCalled();
  });

  it('cancels work on scroll, hide, blur and leaving the viewport', async () => {
    api.startPrefetch(context);
    api.armPrefetch();
    const post = article(1);
    api.watchArticle(post);
    expose([post]);
    await vi.advanceTimersByTimeAsync(1500);
    expect(starts).toEqual([1500]);
    doc.dispatchEvent(new Event('scroll'));
    expect(cancellations).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(starts).toEqual([1500, 6500]);
    doc.hidden = true;
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(cancellations).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(starts).toHaveLength(2);
    doc.hidden = false;
    doc.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(1500);
    focus = false;
    win.dispatchEvent(new Event('blur'));
    expect(cancellations).toBe(3);
    await vi.advanceTimersByTimeAsync(60_000);
    focus = true;
    win.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(1500);
    expose([post], false);
    expect(cancellations).toBe(4);
  });

  it('stops prefetch for playback without changing quality, and reuses its cache', async () => {
    api.startPrefetch(context);
    api.armPrefetch();
    const posts = [article(1), article(2, 300)];
    posts.forEach(api.watchArticle);
    expose(posts);
    await vi.advanceTimersByTimeAsync(1750);
    expect(mock.cached.size).toBe(1);
    expect(mock.synthesize.mock.calls[0]![1]).toMatchObject({ maxChunks: 1, silent: true });
    expect(mock.synthesize.mock.calls[0]![1].steps).toBeUndefined();
    mock.status = 'playing';
    mock.stateListener({ status: 'playing' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(starts).toHaveLength(1);
    mock.status = 'idle';
    mock.stateListener({ status: 'idle' });
    await vi.advanceTimersByTimeAsync(250);
    expect(mock.cached.size).toBe(2);
    expect(starts).toHaveLength(2);
  });

  it('reports a repeatable 30-second feed-scroll workload', async () => {
    const disabled = process.env.TTSX_PREFETCH_DISABLED === '1';
    if (!disabled) { api.startPrefetch(context); api.armPrefetch(); }
    let posts: HTMLElement[] = [];
    for (let frame = 0; frame < 300; frame++) {
      doc.dispatchEvent(new Event('scroll'));
      if (frame % 10 === 0 && !disabled) {
        expose(posts, false);
        posts.forEach(post => Object.assign(post, { isConnected: false }));
        posts = Array.from({ length: 5 }, (_, i) => article(frame + i, i * 180));
        posts.forEach(api.watchArticle);
        expose(posts);
      }
      await vi.advanceTimersByTimeAsync(100);
    }
    const duringScroll = { starts: starts.length, geometryReads, cancellations, preloads: mock.preload.mock.calls.length };
    await vi.advanceTimersByTimeAsync(8000);
    console.log(JSON.stringify({
      workload: '30s input every 100ms, five new posts each second; 8s rest; mock synthesis 250ms',
      variant: disabled ? 'disabled' : process.env.TTSX_PREFETCH_BASELINE ? 'before' : 'after',
      duringScroll, totalStarts: starts.length, firstStartMs: starts[0] ?? null,
      afterScrollStarts: starts.filter(t => t >= 30_000), cachedPosts: mock.cached.size,
    }));
    if (!disabled && !process.env.TTSX_PREFETCH_BASELINE) {
      expect(duringScroll).toEqual({ starts: 0, geometryReads: 0, cancellations: 0, preloads: 0 });
      expect(starts).toEqual([31_400, 36_650]);
    }
  });
});
