/**
 * Split speech text to Supertonic 3's official browser inference limit.
 *
 * A normal X post is one utterance. Splitting it into a short "fast opening"
 * and continuations makes the model restart prosody and insert audible pauses
 * inside sentences. Only long notes are split, on punctuation where possible.
 */
export const MAX_TTS_CHUNK_CHARS = 300;
export const MAX_CJK_TTS_CHUNK_CHARS = 120;

export function chunkTextForTts(text: string, language = 'en'): string[] {
  const maxChars =
    language === 'ko' || language === 'ja'
      ? MAX_CJK_TTS_CHUNK_CHARS
      : MAX_TTS_CHUNK_CHARS;
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];
  if (cleaned.length <= maxChars) return [cleaned];

  const sentences = flattenSentences(cleaned, maxChars);
  if (!sentences.length) return [];

  const chunks: string[] = [];
  let cur = '';
  for (const sentence of sentences) {
    const next = cur ? `${cur} ${sentence}` : sentence;
    if (next.length > maxChars) {
      if (cur) chunks.push(cur);
      cur = sentence;
    } else {
      cur = next;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** Sentences, with oversize ones hard-split to the interactive latency cap. */
function flattenSentences(text: string, maxChars: number): string[] {
  const raw = text.split(/(?<=[.!?…])\s+/).filter(Boolean);
  const out: string[] = [];
  for (const sentence of raw) {
    if (sentence.length <= maxChars) {
      out.push(sentence);
      continue;
    }
    const bits = sentence.split(/(?<=[,;:])\s+|\s+/);
    let piece = '';
    for (const bit of bits) {
      const next = piece ? `${piece} ${bit}` : bit;
      if (next.length > maxChars) {
        if (piece) out.push(piece);
        if (bit.length > maxChars) {
          for (let i = 0; i < bit.length; i += maxChars) {
            out.push(bit.slice(i, i + maxChars));
          }
          piece = '';
        } else {
          piece = bit;
        }
      } else {
        piece = next;
      }
    }
    if (piece) out.push(piece);
  }
  return out;
}
