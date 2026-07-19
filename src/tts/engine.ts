/**
 * Content-side TTS engine.
 *
 * Synthesis runs in a Chromium offscreen document (extension origin).
 * Long posts are chunked to Supertonic 3's official 300-character limit.
 * Always synth at 1×; speed uses HTMLAudioElement.playbackRate with
 * preservesPitch (Premiere-style: tempo changes, pitch stays natural).
 * Prefetch warms the first 1–2 chunks; the next WAV is pre-armed while
 * the current clip plays so handoffs stay tight.
 */
import {
  cacheGet,
  cacheKey,
  cacheMergeChunks,
  type CachedAudio,
} from './cache';
import { prepareTextForSpeech } from './prepareText';
import { normalizeTtsLanguage } from './languages';
import {
  tokenizeWords,
  wordIndexAtCueTime,
  type WordCue,
} from './karaokeCues';
import { normalizeGenerationSteps } from './quality';
import {
  getSettings,
  loadSettings,
  onSettingsChange,
  resolveVoice,
  type Settings,
} from './settings';
import { DEFAULT_VOICE } from './voices';
import { applyMediaPlaybackRate, pcmToWavUrl } from './wav';
import { decodePcm16Base64 } from './pcmTransport';

export interface PlayOptions {
  voice?: string;
  /** BCP-47 language reported by X for the post. */
  language?: string;
  speed?: number;
  volume?: number;
  /** Supertonic 3 flow-matching quality iterations (5-12). */
  steps?: number;
  /** When true, do not emit loading/playing UI state (prefetch). */
  silent?: boolean;
  /** Prefetch: only synthesize this many chunks (usually 1–2). */
  maxChunks?: number;
  /** Resume synthesis after a partial cache warm. */
  startChunk?: number;
}

interface GenOut {
  chunks: Float32Array[];
  texts: string[];
  wordCues: WordCue[][];
  sampleRate: number;
  complete: boolean;
  total: number;
  startChunk: number;
}

type ChunkListener = (
  samples: Float32Array,
  sampleRate: number,
  index: number,
  total: number,
  chunkText?: string,
  wordCues?: WordCue[],
) => void;

interface PendingGen {
  parts: Map<number, Float32Array>;
  texts: Map<number, string>;
  wordCues: Map<number, WordCue[]>;
  sampleRate: number;
  startChunk: number;
  resolve: (out: GenOut) => void;
  reject: (message: string) => void;
  chunkListeners: Set<ChunkListener>;
}

type StateListener = (state: EngineState) => void;
type KaraokeListener = (wordIndex: number | null) => void;

export interface PlaybackCaption {
  text: string;
  index: number;
  total: number;
  /** Position inside the exact PCM clip, sourced from HTMLAudioElement. */
  progress: number;
  /** Global index into the prepared post text for the original karaoke pill. */
  wordIndex: number | null;
}

export type EngineState =
  | { status: 'idle' }
  | { status: 'loading'; progress: number }
  | { status: 'playing'; progress: number; caption?: PlaybackCaption }
  | { status: 'paused'; progress: number; caption?: PlaybackCaption }
  | { status: 'error'; message: string };

interface PlayClip {
  samples: Float32Array;
  sampleRate: number;
  duration: number;
  text: string;
  index: number;
  total: number;
  wordOffset: number;
  wordCues: WordCue[];
}

/** Next clip decoded+buffered ahead of the seam. */
interface ArmedClip {
  clip: PlayClip;
  audio: HTMLAudioElement;
  node: MediaElementAudioSourceNode;
  url: string;
}

class TtsEngine {
  private disposed = false;
  private port: ReturnType<typeof browser.runtime.connect> | null = null;
  private ready: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  /** Sticky until the content↔background port drops. */
  private backendReady = false;

  private audioCtx: AudioContext | null = null;
  private gain: GainNode | null = null;
  /** Media-element path so preservesPitch can keep voice natural. */
  private media: HTMLAudioElement | null = null;
  private mediaNode: MediaElementAudioSourceNode | null = null;
  private mediaUrl: string | null = null;
  private clip: PlayClip | null = null;
  private armed: ArmedClip | null = null;
  private armingClip: PlayClip | null = null;
  private pauseOffset = 0;
  private ignoreEnd = false;
  private playbackRate = 1;

  private playGen = 0;
  private streamQueue: PlayClip[] = [];
  private streamExpectMore = false;
  private streamActive = false;
  /** True while startClip is awaiting play() — prevents double-start races. */
  private streamStarting = false;
  private playProgress = 0;
  private playedBefore = 0;
  /** Sum of durations for chunks received so far (not re-estimated). */
  private knownDuration = 0;
  private totalPlayDuration = 0;
  private expectedChunks = 0;
  private nextWordOffset = 0;
  private progressTimer: ReturnType<typeof setInterval> | null = null;
  private karaokeTimer = 0;
  private karaokeWord: number | null = null;

  private reqId = 0;
  private pending = new Map<number, PendingGen>();

  private uiLoads = 0;

  private genBusy = false;
  private genQueue: Array<{
    key: string;
    priority: number;
    run: () => Promise<GenOut>;
    resolve: (v: GenOut) => void;
    reject: (e: unknown) => void;
  }> = [];
  private inflight = new Map<string, Promise<GenOut>>();
  private inflightChunks = new Map<string, Set<ChunkListener>>();

  private listeners = new Set<StateListener>();
  private karaokeListeners = new Set<KaraokeListener>();
  private state: EngineState = { status: 'idle' };
  private settings: Settings = getSettings();
  private modelReady = false;
  private removeSettingsListener: (() => void) | null = null;

  constructor() {
    void loadSettings().then((s) => {
      if (this.disposed) return;
      this.settings = s;
      this.playbackRate = clamp(s.speed, 0.5, 1.5);
    });
    this.removeSettingsListener = onSettingsChange((s) => {
      this.settings = s;
      this.setVolume(s.volume);
      this.setSpeed(s.speed);
      if (s.karaoke && this.state.status === 'playing') {
        this.startKaraokeTimer();
      } else if (!s.karaoke) {
        this.stopKaraokeTimer();
        this.emitKaraoke(null);
      }
    });
  }

  private connect(): ReturnType<typeof browser.runtime.connect> {
    if (this.disposed) {
      throw new Error('TTS engine disposed');
    }
    if (this.port) return this.port;
    const sid =
      (globalThis as unknown as { __ttsxSid?: string }).__ttsxSid ||
      ((globalThis as unknown as { __ttsxSid: string }).__ttsxSid =
        `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);

    const port = browser.runtime.connect({ name: `ttsx-content:${sid}` });
    this.port = port;
    port.onMessage.addListener((msg) =>
      this.onBusMessage(msg as Record<string, unknown>),
    );
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return;
      this.port = null;
      this.resetBackend('TTS connection lost');
    });
    return port;
  }

  private async ensureBackend(): Promise<void> {
    this.connect();
    if (this.backendReady) return;
    if (this.ready) return this.ready;

    this.ready = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (this.backendReady) return;
        const waited = new Promise<void>((resolve, reject) => {
          this.resolveReady = resolve;
          this.rejectReady = reject;
          if (this.readyTimer != null) clearTimeout(this.readyTimer);
          this.readyTimer = setTimeout(() => {
            if (this.resolveReady) {
              this.resolveReady = null;
              this.rejectReady = null;
              this.readyTimer = null;
              reject(new Error('TTS engine ready timeout'));
            }
          }, 15000);
        });
        try {
          this.connect().postMessage({ type: 'ensure-offscreen' });
          await waited;
          return;
        } catch (e) {
          this.clearReadyWait();
          if (attempt === 1) throw e;
          // One retry after a brief pause — covers zombie offscreen docs.
          await new Promise((r) => setTimeout(r, 400));
        }
      }
    })()
      .then(() => {
        this.backendReady = true;
      })
      .catch((e) => {
        this.ready = null;
        this.backendReady = false;
        throw e;
      });

    return this.ready;
  }

  private post(msg: Record<string, unknown>): void {
    this.connect().postMessage(msg);
  }

  private clearReadyWait(): void {
    if (this.readyTimer != null) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    this.resolveReady = null;
    this.rejectReady = null;
  }

  private resetBackend(reason: string): void {
    const rejectReady = this.rejectReady;
    this.clearReadyWait();
    this.ready = null;
    this.backendReady = false;
    this.modelReady = false;
    rejectReady?.(new Error(reason));

    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(reason);
    }
  }

  /** Abort in-flight worker synth + drop queued jobs so the next tap isn't stuck. */
  private cancelGeneration(reason = 'cancelled'): void {
    try {
      this.post({ type: 'cancel' });
    } catch {
      /* port may not be up yet */
    }
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.reject(reason);
    }
    const queued = this.genQueue.splice(0);
    for (const job of queued) {
      job.reject(new Error(reason));
    }
  }

  private isCancelledError(e: unknown): boolean {
    const msg = e instanceof Error ? e.message : String(e);
    return msg === 'cancelled' || /cancelled/i.test(msg);
  }

  private ensureAudio(): AudioContext {
    if (this.audioCtx) return this.audioCtx;
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const ctx = new Ctor();
    const gain = ctx.createGain();
    gain.gain.value = this.settings.volume;
    gain.connect(ctx.destination);
    this.audioCtx = ctx;
    this.gain = gain;
    return ctx;
  }

  preload(): void {
    if (this.disposed) return;
    this.ensureBackend()
      .then(() => this.post({ type: 'load' }))
      .catch((e) =>
        this.setState({
          status: 'error',
          message: e instanceof Error ? e.message : String(e),
        }),
      );
  }

  isModelReady(): boolean {
    return this.modelReady;
  }

  /**
   * Permanently stop this isolated-world engine when WXT invalidates the
   * content script during an extension update/reload.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.playGen++;

    const port = this.port;
    this.port = null;
    try {
      port?.disconnect();
    } catch {
      /* the extension context is already gone */
    }

    const rejectReady = this.rejectReady;
    this.clearReadyWait();
    this.ready = null;
    this.backendReady = false;
    this.modelReady = false;
    rejectReady?.(new Error('cancelled'));

    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject('cancelled');
    }
    for (const job of this.genQueue.splice(0)) {
      job.reject(new Error('cancelled'));
    }
    this.inflight.clear();
    this.inflightChunks.clear();
    this.teardownPlaybackState();
    this.removeSettingsListener?.();
    this.removeSettingsListener = null;
    this.listeners.clear();
    this.karaokeListeners.clear();
  }

  /**
   * Synthesize without playing. Uses the PCM cache when possible.
   * Prefetch should pass `{ silent: true, maxChunks: 1|2 }` for a fast warm.
   */
  async synthesize(
    text: string,
    opts: PlayOptions & { onChunk?: ChunkListener } = {},
  ): Promise<GenOut> {
    await loadSettings();
    this.settings = getSettings();

    const spoken = prepareTextForSpeech(text);
    if (!spoken.trim()) {
      throw new Error('Nothing to read');
    }

    const voice = opts.voice ?? resolveVoice(this.settings) ?? DEFAULT_VOICE;
    const language = normalizeTtsLanguage(opts.language);
    const steps = normalizeGenerationSteps(opts.steps ?? this.settings.steps);
    const key = cacheKey(spoken, voice, language, steps);
    const maxChunks = opts.maxChunks;
    const startChunk = Math.max(0, opts.startChunk ?? 0);

    const hit = cacheGet(key);
    if (hit) {
      const have = hit.chunks.length;
      // Warm-only request satisfied when the requested window is present.
      if (maxChunks != null && have >= startChunk + maxChunks) {
        this.emitCachedChunks(hit, opts.onChunk, startChunk, maxChunks);
        return {
          chunks: hit.chunks.slice(startChunk, startChunk + maxChunks),
          texts: hit.texts.slice(startChunk, startChunk + maxChunks),
          wordCues: hit.wordCues.slice(startChunk, startChunk + maxChunks),
          sampleRate: hit.sampleRate,
          complete: hit.complete && have >= (hit.total || have),
          total: hit.total || have,
          startChunk,
        };
      }
      // Full play: use cache, fill remaining if incomplete.
      if (startChunk === 0 && hit.complete && have > 0) {
        this.emitCachedChunks(hit, opts.onChunk);
        return {
          chunks: hit.chunks,
          texts: hit.texts,
          wordCues: hit.wordCues,
          sampleRate: hit.sampleRate,
          complete: true,
          total: hit.total || have,
          startChunk: 0,
        };
      }
      if (startChunk === 0 && have > 0 && maxChunks == null) {
        this.emitCachedChunks(hit, opts.onChunk);
        if (hit.complete) {
          return {
            chunks: hit.chunks,
            texts: hit.texts,
            wordCues: hit.wordCues,
            sampleRate: hit.sampleRate,
            complete: true,
            total: hit.total || have,
            startChunk: 0,
          };
        }
        // Partial warm — play what we have, synth the rest.
        const rest = await this.enqueueGenerate(
          `${key}#${have}`,
          spoken,
          voice,
          language,
          steps,
          opts.silent ? 0 : 1,
          have,
          null,
          opts.onChunk,
          key,
        );
        return {
          chunks: [...hit.chunks, ...rest.chunks],
          texts: [...hit.texts, ...rest.texts],
          wordCues: [...hit.wordCues, ...rest.wordCues],
          sampleRate: rest.sampleRate || hit.sampleRate,
          complete: rest.complete,
          total: rest.total,
          startChunk: 0,
        };
      }
    }

    if (opts.onChunk) {
      let set = this.inflightChunks.get(key);
      if (!set) {
        set = new Set();
        this.inflightChunks.set(key, set);
      }
      set.add(opts.onChunk);
    }

    const silent = !!opts.silent;

    // Join any in-flight warm/full job for this text+voice so a tap can
    // start as soon as the first chunk arrives from prefetch.
    // Job keys are `${key}|w…` / `${key}|f…` / `${key}#n` — match on
    // delimiters only (bare startsWith(key) can join a different post).
    if (!silent && maxChunks == null) {
      for (const [jk, promise] of this.inflight) {
        if (!jobKeyBelongsTo(jk, key)) continue;
        for (const job of this.genQueue) {
          if (jobKeyBelongsTo(job.key, key)) job.priority = 1;
        }
        this.genQueue.sort((a, b) => b.priority - a.priority);
        this.uiLoads++;
        this.setState({
          status: 'loading',
          progress: this.modelReady ? 1 : 0,
        });
        try {
          await promise;
        } finally {
          this.uiLoads = Math.max(0, this.uiLoads - 1);
        }
        const after = cacheGet(key);
        if (after?.chunks.length) {
          this.emitCachedChunks(after, opts.onChunk);
          if (after.complete) {
            return {
              chunks: after.chunks,
              texts: after.texts,
              wordCues: after.wordCues,
              sampleRate: after.sampleRate,
              complete: true,
              total: after.total || after.chunks.length,
              startChunk: 0,
            };
          }
          const have = after.chunks.length;
          const rest = await this.enqueueGenerate(
            `${key}#${have}`,
            spoken,
            voice,
            language,
            steps,
            1,
            have,
            null,
            opts.onChunk,
            key,
          );
          return {
            chunks: [...after.chunks, ...rest.chunks],
            texts: [...after.texts, ...rest.texts],
            wordCues: [...after.wordCues, ...rest.wordCues],
            sampleRate: rest.sampleRate || after.sampleRate,
            complete: rest.complete,
            total: rest.total,
            startChunk: 0,
          };
        }
        break;
      }
    }

    const jobKey =
      maxChunks != null
        ? `${key}|w${startChunk}:${maxChunks}`
        : `${key}|f${startChunk}`;

    let shared = this.inflight.get(jobKey);
    if (!shared) {
      const priority = silent ? (maxChunks != null ? 0.5 : 0) : 1;
      shared = this.enqueueGenerate(
        jobKey,
        spoken,
        voice,
        language,
        steps,
        priority,
        startChunk,
        maxChunks ?? null,
        undefined,
        key,
      ).finally(() => {
        this.inflight.delete(jobKey);
        const hasRelatedJob = [...this.inflight.keys()].some((candidate) =>
          jobKeyBelongsTo(candidate, key),
        );
        if (!hasRelatedJob) {
          this.inflightChunks.delete(key);
        }
      });
      this.inflight.set(jobKey, shared);
    } else if (!silent) {
      for (const job of this.genQueue) {
        if (job.key === jobKey || jobKeyBelongsTo(job.key, key)) {
          job.priority = 1;
        }
      }
      this.genQueue.sort((a, b) => b.priority - a.priority);
    }

    if (!silent) {
      this.uiLoads++;
      this.setState({
        status: 'loading',
        progress: this.modelReady ? 1 : 0,
      });
      try {
        return await shared;
      } finally {
        this.uiLoads = Math.max(0, this.uiLoads - 1);
      }
    }

    return shared;
  }

  private emitCachedChunks(
    hit: CachedAudio,
    onChunk?: ChunkListener,
    from = 0,
    limit?: number,
  ): void {
    if (!onChunk) return;
    const end =
      limit != null ? Math.min(hit.chunks.length, from + limit) : hit.chunks.length;
    for (let i = from; i < end; i++) {
      const c = hit.chunks[i];
      if (c) {
        onChunk(
          c,
          hit.sampleRate,
          i,
          hit.total || hit.chunks.length,
          hit.texts[i] || undefined,
          hit.wordCues[i],
        );
      }
    }
  }

  private enqueueGenerate(
    jobKey: string,
    spoken: string,
    voice: string,
    language: string,
    steps: number,
    priority: number,
    startChunk: number,
    maxChunks: number | null,
    onChunk?: ChunkListener,
    cacheKeyForStore?: string,
  ): Promise<GenOut> {
    const storeKey = cacheKeyForStore ?? jobKey;
    return new Promise<GenOut>((resolve, reject) => {
      this.genQueue.push({
        key: jobKey,
        priority,
        resolve,
        reject,
        run: async () => {
          await this.ensureBackend();

          const id = ++this.reqId;
          const listeners =
            this.inflightChunks.get(storeKey) ?? new Set<ChunkListener>();
          if (onChunk) listeners.add(onChunk);

          const out = new Promise<GenOut>((res, rej) => {
            this.pending.set(id, {
              parts: new Map(),
              texts: new Map(),
              wordCues: new Map(),
              sampleRate: 44_100,
              startChunk,
              resolve: res,
              reject: (m) => rej(new Error(m)),
              chunkListeners: listeners,
            });
          });

          this.post({
            type: 'generate',
            id,
            text: spoken,
            voice,
            language,
            steps,
            speed: 1,
            startChunk,
            maxChunks: maxChunks ?? undefined,
            priority,
          });

          const result = await out;
          cacheMergeChunks(
            storeKey,
            result.startChunk,
            result.chunks,
            result.sampleRate,
            result.complete,
            result.total,
            result.texts,
            result.wordCues,
          );
          return result;
        },
      });
      this.genQueue.sort((a, b) => b.priority - a.priority);
      void this.drainGenQueue();
    });
  }

  private async drainGenQueue(): Promise<void> {
    if (this.genBusy) return;
    const next = this.genQueue.shift();
    if (!next) return;
    this.genBusy = true;
    try {
      next.resolve(await next.run());
    } catch (e) {
      next.reject(e);
    } finally {
      this.genBusy = false;
      if (this.genQueue.length) void this.drainGenQueue();
    }
  }

  async play(text: string, opts: PlayOptions = {}): Promise<void> {
    // Claim this invocation before the first await. A route change or stop()
    // during settings I/O must invalidate this play instead of allowing it to
    // begin after the user has already left the post.
    const gen = ++this.playGen;
    const wasActive =
      this.state.status === 'playing' ||
      this.state.status === 'paused' ||
      this.state.status === 'loading';
    this.cancelGeneration();
    this.teardownPlaybackState();
    if (wasActive) this.setState({ status: 'idle' });

    await loadSettings();
    if (gen !== this.playGen || this.disposed) return;
    this.settings = getSettings();

    const volume = clamp(opts.volume ?? this.settings.volume, 0, 2);
    this.playbackRate = clamp(opts.speed ?? this.settings.speed, 0.5, 1.5);
    this.streamQueue = [];
    this.streamExpectMore = true;
    this.streamActive = true;
    this.streamStarting = false;
    this.pauseOffset = 0;
    this.clip = null;
    this.playedBefore = 0;
    this.knownDuration = 0;
    this.totalPlayDuration = 0;
    this.expectedChunks = 0;
    this.nextWordOffset = 0;
    this.playProgress = 0;
    this.setState({
      status: 'loading',
      progress: this.modelReady ? 1 : 0,
    });

    try {
      const ctx = this.ensureAudio();
      if (ctx.state === 'suspended') await ctx.resume();
    } catch (error) {
      this.failPlayback(error, gen);
      throw error;
    }

    if (gen !== this.playGen) return;

    let started = false;
    const seen = new Set<number>();

    const onChunk: ChunkListener = (
      samples,
      sampleRate,
      index,
      total,
      chunkText,
      wordCues,
    ) => {
      if (gen !== this.playGen || !this.streamActive) return;
      if (seen.has(index)) return;
      seen.add(index);
      const clip = toClip(
        samples,
        sampleRate,
        chunkText ?? '',
        index,
        total,
        this.nextWordOffset,
        wordCues ?? [],
      );
      this.nextWordOffset += tokenizeWords(clip.text).length;

      this.knownDuration += clip.duration;
      this.expectedChunks = Math.max(this.expectedChunks, total || 0);
      if (this.expectedChunks > 0 && seen.size < this.expectedChunks) {
        const avg = this.knownDuration / seen.size;
        this.totalPlayDuration = avg * this.expectedChunks;
      } else {
        this.totalPlayDuration = this.knownDuration;
      }

      if (
        this.media ||
        this.streamStarting ||
        this.state.status === 'paused'
      ) {
        this.streamQueue.push(clip);
        // Keep one clip decoded ahead so the seam stays tight.
        if (this.media && this.streamQueue.length === 1) {
          this.maybeArmNext();
        }
        return;
      }
      started = true;
      this.clip = clip;
      this.pauseOffset = 0;
      void this.startClip(clip, 0, volume);
    };

    try {
      // Generate the utterance continuously. Normal X posts are a single
      // chunk, preserving sentence-level prosody. Long-note chunks
      // are produced eagerly so playback has a real buffer instead of waiting
      // at every boundary.
      await this.synthesize(text, { ...opts, silent: false, onChunk });
      if (gen !== this.playGen) return;
      this.streamExpectMore = false;
      if (!started) {
        this.streamActive = false;
        this.stopProgressTimer();
        this.setState({ status: 'idle' });
        return;
      }
      if (!this.media && this.state.status === 'playing' && this.streamQueue.length) {
        const next = this.streamQueue.shift()!;
        this.clip = next;
        this.pauseOffset = 0;
        void this.startClip(next, 0, volume);
        return;
      }
      if (!this.media && this.state.status === 'playing' && !this.streamQueue.length) {
        this.streamActive = false;
        this.stopProgressTimer();
        this.setState({ status: 'idle' });
      }
    } catch (e) {
      if (gen !== this.playGen || this.isCancelledError(e)) return;
      this.failPlayback(e, gen);
      throw e;
    }
  }

  pause(): void {
    if (this.state.status !== 'playing' || !this.media) return;
    this.pauseOffset = this.media.currentTime;
    this.ignoreEnd = true;
    this.media.pause();
    this.ignoreEnd = false;
    this.stopProgressTimer();
    this.stopKaraokeTimer();
    this.playProgress = this.computeProgress();
    this.setPlaybackState('paused');
  }

  async resume(): Promise<void> {
    if (this.state.status !== 'paused' || !this.clip) return;
    const ctx = this.ensureAudio();
    if (ctx.state === 'suspended') await ctx.resume();

    // Same element still loaded — just continue (keeps preservesPitch).
    if (this.media && this.media.paused) {
      applyMediaPlaybackRate(this.media, this.playbackRate);
      try {
        await this.media.play();
      } catch (err) {
        this.failPlayback(err, this.playGen);
        return;
      }
      this.startProgressTimer();
      this.playProgress = this.computeProgress();
      this.setPlaybackState('playing');
      return;
    }

    const volume = this.gain?.gain.value ?? this.settings.volume;
    await this.startClip(this.clip, this.pauseOffset, volume);
  }

  stop(): void {
    this.playGen++;
    this.cancelGeneration();
    this.teardownPlaybackState();
    if (
      this.state.status === 'playing' ||
      this.state.status === 'paused' ||
      this.state.status === 'loading'
    ) {
      this.setState({ status: 'idle' });
    }
  }

  private teardownPlaybackState(): void {
    this.streamActive = false;
    this.streamExpectMore = false;
    this.streamStarting = false;
    this.streamQueue = [];
    this.ignoreEnd = true;
    this.stopProgressTimer();
    this.stopKaraokeTimer();
    this.emitKaraoke(null);
    this.discardArmed();
    this.teardownMedia();
    this.ignoreEnd = false;
    this.clip = null;
    this.pauseOffset = 0;
    this.playedBefore = 0;
    this.knownDuration = 0;
    this.totalPlayDuration = 0;
    this.expectedChunks = 0;
    this.nextWordOffset = 0;
    this.playProgress = 0;
  }

  private failPlayback(error: unknown, gen: number): void {
    if (gen !== this.playGen) return;
    const message = error instanceof Error ? error.message : String(error);
    this.playGen++;
    this.cancelGeneration();
    this.teardownPlaybackState();
    this.setState({
      status: 'error',
      message: message || 'Audio playback failed',
    });
  }

  setVolume(volume: number): void {
    if (this.gain) this.gain.gain.value = clamp(volume, 0, 2);
  }

  setSpeed(speed: number): void {
    this.playbackRate = clamp(speed, 0.5, 1.5);
    for (const el of [this.media, this.armed?.audio]) {
      if (!el) continue;
      try {
        applyMediaPlaybackRate(el, this.playbackRate);
      } catch {
        /* ignore */
      }
    }
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  onKaraoke(listener: KaraokeListener): () => void {
    this.karaokeListeners.add(listener);
    listener(this.karaokeWord);
    return () => this.karaokeListeners.delete(listener);
  }

  getState(): EngineState {
    return this.state;
  }

  private teardownMedia(): void {
    if (this.mediaNode) {
      try {
        this.mediaNode.disconnect();
      } catch {
        /* ignore */
      }
    }
    if (this.media) {
      try {
        this.media.onended = null;
        this.media.onerror = null;
        this.media.ontimeupdate = null;
        this.media.pause();
        this.media.removeAttribute('src');
        this.media.load();
      } catch {
        /* ignore */
      }
    }
    this.media = null;
    this.mediaNode = null;
    if (this.mediaUrl) {
      URL.revokeObjectURL(this.mediaUrl);
      this.mediaUrl = null;
    }
  }

  private discardArmed(): void {
    this.armingClip = null;
    const a = this.armed;
    this.armed = null;
    if (!a) return;
    try {
      a.node.disconnect();
    } catch {
      /* ignore */
    }
    try {
      a.audio.onended = null;
      a.audio.onerror = null;
      a.audio.ontimeupdate = null;
      a.audio.pause();
      a.audio.removeAttribute('src');
      a.audio.load();
    } catch {
      /* ignore */
    }
    URL.revokeObjectURL(a.url);
  }

  /** Decode+buffer the next queued clip while the current one is still playing. */
  private maybeArmNext(): void {
    const next = this.streamQueue[0];
    if (!next) return;
    if (this.armed?.clip === next || this.armingClip === next) return;
    void this.armClip(next).catch(() => {
      if (this.armingClip === next) this.armingClip = null;
    });
  }

  private async armClip(clip: PlayClip): Promise<void> {
    const gen = this.playGen;
    if (this.armed?.clip === clip) return;
    if (this.armingClip === clip) return;
    this.armingClip = clip;
    if (this.armed) this.discardArmed();
    this.armingClip = clip;

    const ctx = this.ensureAudio();
    const url = pcmToWavUrl(clip.samples, clip.sampleRate);
    const audio = new Audio();
    audio.preload = 'auto';
    audio.src = url;
    applyMediaPlaybackRate(audio, this.playbackRate);
    let node: MediaElementAudioSourceNode;
    try {
      node = ctx.createMediaElementSource(audio);
    } catch {
      URL.revokeObjectURL(url);
      if (this.armingClip === clip) this.armingClip = null;
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        audio.removeEventListener('canplaythrough', done);
        audio.removeEventListener('error', done);
        resolve();
      };
      const timer = setTimeout(done, 600);
      audio.addEventListener('canplaythrough', done);
      audio.addEventListener('error', done);
      try {
        audio.load();
      } catch {
        done();
      }
    });

    if (gen !== this.playGen || this.armingClip !== clip) {
      try {
        node.disconnect();
      } catch {
        /* ignore */
      }
      try {
        audio.removeAttribute('src');
        audio.load();
      } catch {
        /* ignore */
      }
      URL.revokeObjectURL(url);
      return;
    }

    this.armed = { clip, audio, node, url };
    this.armingClip = null;
  }

  private wireMediaHandlers(
    audio: HTMLAudioElement,
    clip: PlayClip,
    gen: number,
  ): void {
    audio.onended = () => {
      if (this.ignoreEnd) return;
      if (this.media !== audio || gen !== this.playGen) return;
      this.playedBefore += clip.duration;

      const volume = this.gain?.gain.value ?? this.settings.volume;
      const next = this.streamQueue[0];
      if (this.streamActive && next && this.armed?.clip === next) {
        this.streamQueue.shift();
        this.ignoreEnd = true;
        this.teardownMedia();
        this.ignoreEnd = false;
        void this.promoteArmed(volume, gen);
        return;
      }

      this.teardownMedia();

      if (this.streamActive && this.streamQueue.length) {
        const clipNext = this.streamQueue.shift()!;
        this.clip = clipNext;
        this.pauseOffset = 0;
        void this.startClip(clipNext, 0, volume);
        return;
      }

      if (this.streamActive && this.streamExpectMore) {
        // Synth still catching up — stay in "playing" so the progress ring
        // remains and a second tap pauses instead of cancelling a "load".
        this.playProgress = this.computeProgress();
        this.setPlaybackState('playing');
        return;
      }

      this.clip = null;
      this.pauseOffset = 0;
      this.streamActive = false;
      this.stopProgressTimer();
      this.playProgress = 1;
      this.setState({ status: 'idle' });
    };

    audio.onerror = () => {
      if (this.ignoreEnd || this.media !== audio || gen !== this.playGen) return;
      this.failPlayback('Audio playback failed', gen);
    };

    audio.ontimeupdate = () => {
      if (this.media !== audio || gen !== this.playGen) return;
      if (this.state.status === 'playing') {
        this.playProgress = this.computeProgress();
        this.setPlaybackState('playing');
      }
      const dur = audio.duration;
      if (!Number.isFinite(dur) || dur <= 0) return;
      const remain =
        (dur - audio.currentTime) / Math.max(0.25, this.playbackRate);
      if (remain <= 0.45) this.maybeArmNext();
    };
  }

  private async promoteArmed(volume: number, gen: number): Promise<void> {
    const armed = this.armed;
    if (!armed || gen !== this.playGen) {
      this.discardArmed();
      return;
    }
    this.armed = null;
    this.streamStarting = true;

    const ctx = this.ensureAudio();
    try {
      if (ctx.state === 'suspended') await ctx.resume();
    } catch (error) {
      this.streamStarting = false;
      this.discardArmedElement(armed);
      this.failPlayback(error, gen);
      return;
    }
    if (gen !== this.playGen) {
      this.discardArmedElement(armed);
      this.streamStarting = false;
      return;
    }

    if (this.gain) this.gain.gain.value = volume;
    try {
      armed.node.connect(this.gain ?? ctx.destination);
    } catch {
      this.discardArmedElement(armed);
      this.streamStarting = false;
      if (this.streamQueue.length) {
        const next = this.streamQueue.shift()!;
        void this.startClip(next, 0, volume);
      }
      return;
    }

    applyMediaPlaybackRate(armed.audio, this.playbackRate);
    this.media = armed.audio;
    this.mediaNode = armed.node;
    this.mediaUrl = armed.url;
    this.clip = armed.clip;
    this.pauseOffset = 0;
    this.wireMediaHandlers(armed.audio, armed.clip, gen);

    try {
      await armed.audio.play();
    } catch (err) {
      this.streamStarting = false;
      if (gen !== this.playGen) return;
      this.failPlayback(err, gen);
      return;
    }

    this.streamStarting = false;
    if (gen !== this.playGen) {
      this.teardownMedia();
      return;
    }
    this.startProgressTimer();
    this.playProgress = this.computeProgress();
    this.setPlaybackState('playing');
    this.maybeArmNext();
  }

  private discardArmedElement(a: ArmedClip): void {
    try {
      a.node.disconnect();
    } catch {
      /* ignore */
    }
    try {
      a.audio.pause();
      a.audio.removeAttribute('src');
      a.audio.load();
    } catch {
      /* ignore */
    }
    URL.revokeObjectURL(a.url);
  }

  private async startClip(
    clip: PlayClip,
    offset: number,
    volume: number,
  ): Promise<void> {
    const gen = this.playGen;
    this.streamStarting = true;
    const ctx = this.ensureAudio();
    try {
      if (ctx.state === 'suspended') await ctx.resume();
    } catch (error) {
      this.streamStarting = false;
      this.failPlayback(error, gen);
      return;
    }
    if (gen !== this.playGen) {
      this.streamStarting = false;
      return;
    }

    // Resume / seamless path: pre-armed clip with no seek offset.
    if (offset <= 0.001 && this.armed?.clip === clip) {
      this.streamQueue = this.streamQueue.filter((c) => c !== clip);
      this.ignoreEnd = true;
      this.teardownMedia();
      this.ignoreEnd = false;
      await this.promoteArmed(volume, gen);
      return;
    }

    if (this.armed?.clip === clip) this.discardArmed();

    this.ignoreEnd = true;
    this.teardownMedia();
    this.ignoreEnd = false;

    const safeOffset = Math.min(
      Math.max(0, offset),
      Math.max(0, clip.duration - 0.01),
    );

    const url = pcmToWavUrl(clip.samples, clip.sampleRate);
    const audio = new Audio();
    audio.preload = 'auto';
    audio.src = url;
    applyMediaPlaybackRate(audio, this.playbackRate);

    let node: MediaElementAudioSourceNode;
    try {
      node = ctx.createMediaElementSource(audio);
      if (this.gain) this.gain.gain.value = volume;
      node.connect(this.gain ?? ctx.destination);
    } catch (error) {
      URL.revokeObjectURL(url);
      this.streamStarting = false;
      this.failPlayback(error, gen);
      return;
    }

    this.mediaUrl = url;
    this.media = audio;
    this.mediaNode = node;
    this.clip = clip;
    this.wireMediaHandlers(audio, clip, gen);

    try {
      audio.currentTime = safeOffset;
    } catch {
      /* some engines need metadata first */
    }

    try {
      await audio.play();
    } catch (err) {
      this.streamStarting = false;
      if (gen !== this.playGen) return;
      this.failPlayback(err, gen);
      return;
    }

    this.streamStarting = false;
    if (gen !== this.playGen) {
      this.teardownMedia();
      return;
    }
    this.startProgressTimer();
    this.playProgress = this.computeProgress();
    this.setPlaybackState('playing');
    this.maybeArmNext();
  }

  private currentCaption(): PlaybackCaption | undefined {
    const clip = this.clip;
    if (!clip?.text.trim()) return undefined;

    let position = clip.duration;
    if (this.media) {
      position = this.media.currentTime;
    } else if (this.state.status === 'paused') {
      position = this.pauseOffset;
    }

    const progress =
      clip.duration > 0
        ? clamp(position / clip.duration, 0, 1)
        : 0;
    const localWord = wordIndexAtCueTime(clip.wordCues, position);

    return {
      text: clip.text,
      index: clip.index,
      total: clip.total,
      progress,
      wordIndex:
        localWord == null ? null : clip.wordOffset + localWord,
    };
  }

  private setPlaybackState(status: 'playing' | 'paused'): void {
    if (status === 'playing') this.startKaraokeTimer();
    else this.stopKaraokeTimer();
    const caption = this.currentCaption();
    this.setState({
      status,
      progress: this.playProgress,
      caption,
    });
    this.emitKaraoke(caption?.wordIndex ?? null);
  }

  private startKaraokeTimer(): void {
    if (
      this.karaokeTimer ||
      !this.settings.karaoke ||
      !this.karaokeListeners.size
    ) {
      return;
    }
    const tick = () => {
      this.karaokeTimer = 0;
      if (this.state.status !== 'playing' || !this.settings.karaoke) return;
      this.emitKaraoke(this.currentCaption()?.wordIndex ?? null);
      this.karaokeTimer = window.setTimeout(tick, 40);
    };
    this.karaokeTimer = window.setTimeout(tick, 40);
  }

  private stopKaraokeTimer(): void {
    if (!this.karaokeTimer) return;
    clearTimeout(this.karaokeTimer);
    this.karaokeTimer = 0;
  }

  private emitKaraoke(wordIndex: number | null): void {
    if (wordIndex === this.karaokeWord) return;
    this.karaokeWord = wordIndex;
    for (const listener of this.karaokeListeners) listener(wordIndex);
  }

  private computeProgress(): number {
    if (this.totalPlayDuration <= 0.05) return this.playProgress;
    let pos = this.playedBefore;
    if (this.media && !this.media.ended) {
      pos += this.media.currentTime;
    } else if (this.state.status === 'paused') {
      pos += this.pauseOffset;
    }
    return clamp(pos / this.totalPlayDuration, 0, 0.999);
  }

  private startProgressTimer(): void {
    this.stopProgressTimer();
    // ~5 Hz is enough for the ring; avoid hammering setState / DOM.
    this.progressTimer = setInterval(() => {
      if (this.state.status !== 'playing') return;
      const next = this.computeProgress();
      if (Math.abs(next - this.playProgress) < 0.008) return;
      this.playProgress = next;
      this.setPlaybackState('playing');
    }, 200);
  }

  private stopProgressTimer(): void {
    if (this.progressTimer != null) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }

  private onBusMessage(data: Record<string, unknown>): void {
    switch (data?.type) {
      case 'offscreen-ready':
        this.backendReady = true;
        if (this.resolveReady) {
          const r = this.resolveReady;
          this.clearReadyWait();
          r();
        }
        break;
      case 'backend-disconnected':
        this.resetBackend('TTS backend disconnected');
        break;
      case 'loading':
        // Never stomp an active playback UI with model-load flashes.
        if (
          this.uiLoads > 0 &&
          this.state.status !== 'playing' &&
          this.state.status !== 'paused'
        ) {
          this.setState({ status: 'loading', progress: 0 });
        }
        break;
      case 'progress':
        if (
          this.uiLoads > 0 &&
          this.state.status !== 'playing' &&
          this.state.status !== 'paused'
        ) {
          this.setState({
            status: 'loading',
            progress: Number(data.progress) || 0,
          });
        }
        break;
      case 'ready':
        this.modelReady = true;
        if (this.uiLoads === 0 && this.state.status === 'loading') {
          this.setState({ status: 'idle' });
        }
        break;
      case 'audio-chunk': {
        const id = Number(data.id);
        const pending = this.pending.get(id);
        if (!pending) break;
        const samples =
          data.encoding === 'pcm-s16le-base64' &&
          typeof data.samples === 'string'
            ? decodePcm16Base64(data.samples)
            : toF32(data.samples);
        if (!samples.length) {
          this.pending.delete(id);
          pending.reject(
            `Empty audio chunk (reported length ${String(data.length)})`,
          );
          break;
        }
        const reportedLength = Number(data.length);
        if (
          Number.isInteger(reportedLength) &&
          reportedLength > 0 &&
          samples.length !== reportedLength
        ) {
          this.pending.delete(id);
          pending.reject(
            `Corrupt audio chunk (${samples.length}/${reportedLength} samples)`,
          );
          break;
        }
        const sampleRate = Number(data.sampleRate) || 44_100;
        const index = Number(data.index) || 0;
        const total = Number(data.total) || 1;
        pending.sampleRate = sampleRate;
        pending.parts.set(index, samples);
        const chunkText =
          typeof data.text === 'string' ? data.text : undefined;
        if (chunkText) pending.texts.set(index, chunkText);
        const wordCues = toWordCues(
          data.wordCues,
          chunkText ?? '',
          samples.length / sampleRate,
        );
        if (tokenizeWords(chunkText ?? '').length !== wordCues.length) {
          this.pending.delete(id);
          pending.reject(
            `Word timing metadata is incomplete for chunk ${index + 1}`,
          );
          break;
        }
        pending.wordCues.set(index, wordCues);
        for (const l of pending.chunkListeners) {
          l(samples, sampleRate, index, total, chunkText, wordCues);
        }
        break;
      }
      case 'audio-done': {
        const id = Number(data.id);
        const pending = this.pending.get(id);
        if (!pending) break;
        this.pending.delete(id);
        if (!pending.parts.size) {
          pending.reject('No audio produced');
          break;
        }
        const indices = [...pending.parts.keys()].sort((a, b) => a - b);
        const chunks = indices.map((i) => pending.parts.get(i)!);
        const texts = indices.map((i) => pending.texts.get(i) || '');
        const wordCues = indices.map((i) => pending.wordCues.get(i) || []);
        pending.resolve({
          chunks,
          texts,
          wordCues,
          sampleRate: pending.sampleRate,
          complete: data.complete !== false,
          total: Number(data.total) || chunks.length + pending.startChunk,
          startChunk: pending.startChunk,
        });
        break;
      }
      case 'audio': {
        const id = Number(data.id);
        const pending = this.pending.get(id);
        if (!pending) break;
        this.pending.delete(id);
        pending.reject('Word timing metadata is missing from audio');
        break;
      }
      case 'error': {
        const id = data.id != null ? Number(data.id) : null;
        const message = String(data.message ?? 'Unknown error');
        if (id == null && this.rejectReady) {
          const reject = this.rejectReady;
          this.clearReadyWait();
          reject(new Error(message));
          return;
        }
        if (message === 'cancelled') {
          if (id != null) {
            const pending = this.pending.get(id);
            if (pending) {
              this.pending.delete(id);
              pending.reject(message);
            }
          }
          return;
        }
        if (id != null) {
          const pending = this.pending.get(id);
          if (pending) {
            this.pending.delete(id);
            pending.reject(message);
            return;
          }
        }
        this.setState({ status: 'error', message });
        break;
      }
    }
  }

  private setState(next: EngineState): void {
    this.state = next;
    for (const l of this.listeners) l(next);
  }
}

function toF32(samples: unknown): Float32Array {
  if (samples instanceof Float32Array) return samples;
  if (!Array.isArray(samples) && !ArrayBuffer.isView(samples)) {
    return new Float32Array();
  }
  try {
    return new Float32Array(samples as ArrayLike<number>);
  } catch {
    return new Float32Array();
  }
}

function toClip(
  samples: Float32Array,
  sampleRate: number,
  text: string,
  index: number,
  total: number,
  wordOffset: number,
  wordCues: WordCue[],
): PlayClip {
  const f32 = toF32(samples);
  const rate =
    Number.isFinite(sampleRate) && sampleRate >= 8000 && sampleRate <= 96000
      ? sampleRate
      : 44_100;
  return {
    samples: f32,
    sampleRate: rate,
    duration: f32.length / rate,
    text,
    index,
    total,
    wordOffset,
    wordCues: wordCues.map((cue) => ({ ...cue })),
  };
}

function toWordCues(
  value: unknown,
  text: string,
  duration: number,
): WordCue[] {
  if (!Array.isArray(value)) return [];
  const cues: WordCue[] = [];
  let previousStart = 0;
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const cue = raw as Record<string, unknown>;
    const start = Number(cue.start);
    const end = Number(cue.end);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < previousStart ||
      end < start ||
      start < 0 ||
      end > duration + 0.05
    ) {
      return [];
    }
    cues.push({
      start: Math.min(duration, start),
      end: Math.min(duration, end),
    });
    previousStart = start;
  }
  return cues.length === tokenizeWords(text).length ? cues : [];
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** True when an inflight/queue job key is for this cache key (not a prefix sibling). */
function jobKeyBelongsTo(jobKey: string, cacheKey: string): boolean {
  return (
    jobKey === cacheKey ||
    jobKey.startsWith(`${cacheKey}|`) ||
    jobKey.startsWith(`${cacheKey}#`)
  );
}

export const engine = new TtsEngine();
