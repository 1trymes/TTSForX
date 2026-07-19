/** Audio-grounded word selection for the morphing karaoke pill. */

export interface WordCue {
  /** Start and end on the generated PCM timeline, in seconds. */
  start: number;
  end: number;
}

export interface WordPosition {
  text: string;
  start: number;
  end: number;
}

/**
 * Return the exact character boundaries used by both playback slicing and
 * karaoke. Keeping one tokenizer prevents "start from" from selecting a
 * different word than the acoustic caption index.
 */
export function locateWords(text: string): WordPosition[] {
  const words: WordPosition[] = [];
  const pattern = /\S+/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (!/[\p{L}\p{N}]/u.test(match[0])) continue;
    words.push({
      text: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return words;
}

export function tokenizeWords(text: string): string[] {
  return locateWords(text).map((word) => word.text);
}

/**
 * Resolve a word only while the audio-derived cue is active. Gaps between
 * spoken words deliberately hide the pill instead of inventing timing.
 */
export function wordIndexAtCueTime(
  cues: readonly WordCue[],
  mediaTime: number,
): number | null {
  if (!cues.length || !Number.isFinite(mediaTime) || mediaTime < 0) return null;

  let low = 0;
  let high = cues.length - 1;
  let candidate = -1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (cues[middle]!.start <= mediaTime) {
      candidate = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (candidate < 0) return null;
  return mediaTime <= cues[candidate]!.end + 0.02 ? candidate : null;
}
