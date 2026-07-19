/**
 * Cap prefetch / warm work so the x.com tab stays responsive.
 * Synth runs in an offscreen document, but PCM still crosses into the
 * content script for caching — aggressive warm shows up as "tab slowing
 * your browser" in Helium/Chrome.
 */

export interface HardwareBudget {
  /** How many nearby posts to first-chunk warm. */
  warmPosts: number;
  /** Chunks to warm per post (1–2 sentences → instant tap + lookahead). */
  warmChunks: number;
  /** How many of those may be fully synthesized after warm. */
  fullPosts: number;
  /** IntersectionObserver rootMargin (prefetch ahead of scroll). */
  rootMargin: string;
  /** Skip *full* prefetch above this prepared-text length. Warm still runs. */
  maxPrefetchChars: number;
}

export function hardwareBudget(): HardwareBudget {
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    connection?: { saveData?: boolean; effectiveType?: string };
  };
  const mem = nav.deviceMemory; // GiB, Chrome-only
  const cores = navigator.hardwareConcurrency || 4;
  const saveData = !!nav.connection?.saveData;
  const slowNet =
    nav.connection?.effectiveType === '2g' ||
    nav.connection?.effectiveType === 'slow-2g';

  // Conservative defaults: warm only the nearest post(s), never full-synth
  // the feed. Supertonic 3 uses four WebGPU graphs per utterance.
  if (saveData || slowNet || (mem != null && mem <= 2) || cores <= 2) {
    return {
      warmPosts: 1,
      warmChunks: 1,
      fullPosts: 0,
      rootMargin: '60px 0px',
      maxPrefetchChars: 320,
    };
  }
  if ((mem != null && mem <= 4) || cores <= 4) {
    return {
      warmPosts: 1,
      warmChunks: 1,
      fullPosts: 0,
      rootMargin: '120px 0px',
      maxPrefetchChars: 600,
    };
  }
  return {
    warmPosts: 2,
    warmChunks: 1,
    fullPosts: 0,
    rootMargin: '160px 0px',
    maxPrefetchChars: 900,
  };
}
