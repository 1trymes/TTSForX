/**
 * Chunk-aware PCM cache.
 * Prefetch can store only the first chunk so taps start instantly;
 * play fills the rest. Speed is playback-only — not part of the key.
 */

import {
  DEFAULT_GENERATION_STEPS,
  normalizeGenerationSteps,
} from './quality';
import type { WordCue } from './karaokeCues';

export interface CachedAudio {
  chunks: Float32Array[];
  sampleRate: number;
  /** True when every Supertonic 3 chunk for this text is present. */
  complete: boolean;
  /** Known total chunk count (0 if unknown). */
  total: number;
  /** Per-chunk source text (same order as chunks). */
  texts: string[];
  /** Per-chunk word boundaries measured from the generated PCM. */
  wordCues: WordCue[][];
}

interface Entry {
  key: string;
  chunks: Float32Array[];
  texts: string[];
  wordCues: WordCue[][];
  sampleRate: number;
  complete: boolean;
  total: number;
  bytes: number;
  lastAccess: number;
}

const MAX_ENTRIES = 10;
const MAX_BYTES = 48 * 1024 * 1024;

const entries = new Map<string, Entry>();
let totalBytes = 0;

export function cacheKey(
  text: string,
  voice: string,
  language = 'en',
  steps = DEFAULT_GENERATION_STEPS,
): string {
  // Version both synthesis and acoustic alignment. Cached PCM is valid only
  // when its word-cue contract was produced by this pinned aligner revision.
  return `supertonic3-3cadd1ee+xenova-whisper-tiny-forced-v2|q${normalizeGenerationSteps(steps)}|${language}|${voice}|${hashText(text)}`;
}

export function cacheHas(key: string): boolean {
  return entries.has(key);
}

/** True when at least the first chunk is ready to start playback. */
export function cacheHasStart(key: string): boolean {
  return cacheChunkCount(key) > 0;
}

/** How many PCM chunks are cached for this key. */
export function cacheChunkCount(key: string): number {
  const e = entries.get(key);
  if (!e) return 0;
  let n = 0;
  for (const c of e.chunks) if (c) n++;
  return n;
}

export function cacheGet(key: string): CachedAudio | null {
  const e = entries.get(key);
  if (!e) return null;
  e.lastAccess = Date.now();
  entries.delete(key);
  entries.set(key, e);
  return {
    chunks: e.chunks.map((c) => new Float32Array(c)),
    sampleRate: e.sampleRate,
    complete: e.complete,
    total: e.total,
    texts: e.texts.slice(),
    wordCues: e.wordCues.map((cues) => cues.map((cue) => ({ ...cue }))),
  };
}

export function cacheSetChunks(
  key: string,
  chunks: Float32Array[],
  sampleRate: number,
  complete: boolean,
  total = chunks.length,
  texts: string[] = [],
  wordCues: WordCue[][] = [],
): void {
  if (!chunks.length) return;
  const copies = chunks.map((c) => new Float32Array(c));
  const bytes = copies.reduce((n, c) => n + c.byteLength, 0);
  if (bytes > MAX_BYTES) return;

  const prev = entries.get(key);
  if (prev) {
    totalBytes -= prev.bytes;
    entries.delete(key);
  }

  while (
    (entries.size >= MAX_ENTRIES || totalBytes + bytes > MAX_BYTES) &&
    entries.size > 0
  ) {
    evictOldest();
  }

  const textCopy = texts.slice(0, copies.length);
  while (textCopy.length < copies.length) textCopy.push('');
  const cueCopy = wordCues
    .slice(0, copies.length)
    .map((cues) => cues.map((cue) => ({ ...cue })));
  while (cueCopy.length < copies.length) cueCopy.push([]);

  entries.set(key, {
    key,
    chunks: copies,
    texts: textCopy,
    wordCues: cueCopy,
    sampleRate,
    complete,
    total: Math.max(total, copies.length),
    bytes,
    lastAccess: Date.now(),
  });
  totalBytes += bytes;
}

/** Merge newly synthesized chunks into an existing (possibly partial) entry. */
export function cacheMergeChunks(
  key: string,
  startIndex: number,
  newChunks: Float32Array[],
  sampleRate: number,
  complete: boolean,
  total: number,
  newTexts: string[] = [],
  newWordCues: WordCue[][] = [],
): void {
  const existing = entries.get(key);
  const merged: Float32Array[] = existing ? [...existing.chunks] : [];
  const mergedTexts: string[] = existing ? [...existing.texts] : [];
  const mergedWordCues: WordCue[][] = existing
    ? existing.wordCues.map((cues) => cues.map((cue) => ({ ...cue })))
    : [];
  for (let i = 0; i < newChunks.length; i++) {
    merged[startIndex + i] = newChunks[i]!;
    const t = newTexts[i];
    if (typeof t === 'string' && t) mergedTexts[startIndex + i] = t;
    const cues = newWordCues[i];
    if (cues?.length) {
      mergedWordCues[startIndex + i] = cues.map((cue) => ({ ...cue }));
    }
  }
  const dense: Float32Array[] = [];
  const denseTexts: string[] = [];
  const denseWordCues: WordCue[][] = [];
  for (let i = 0; i < merged.length; i++) {
    if (!merged[i]) break;
    dense.push(merged[i]!);
    denseTexts.push(mergedTexts[i] || '');
    denseWordCues.push(
      (mergedWordCues[i] || []).map((cue) => ({ ...cue })),
    );
  }
  cacheSetChunks(
    key,
    dense,
    sampleRate || existing?.sampleRate || 44_100,
    complete || existing?.complete || false,
    Math.max(total || 0, existing?.total || 0, dense.length),
    denseTexts,
    denseWordCues,
  );
}

export function cacheClear(): void {
  entries.clear();
  totalBytes = 0;
}

export function cacheStats(): { size: number; bytes: number } {
  return { size: entries.size, bytes: totalBytes };
}

function evictOldest(): void {
  const first = entries.keys().next().value as string | undefined;
  if (first == null) return;
  const e = entries.get(first);
  if (e) totalBytes -= e.bytes;
  entries.delete(first);
}

function hashText(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${text.length.toString(36)}_${(h >>> 0).toString(36)}`;
}
