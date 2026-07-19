/**
 * Turn raw tweet text into something Supertonic 3 can speak cleanly.
 * URLs → "link", noise stripped, whitespace normalized.
 */

/** True when a post has real words to read (not empty / emoji / URL-only). */
export function hasSpeakableText(raw: string): boolean {
  const spoken = prepareTextForSpeech(raw);
  if (!spoken.trim()) return false;
  // "link" is only a stand-in for URLs — not enough to show a speaker.
  const meaningful = spoken
    .replace(/\blink\b/gi, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '');
  return meaningful.length > 0;
}

export function prepareTextForSpeech(raw: string): string {
  let t = raw.normalize('NFKC');

  // t.co / x.com / pic / generic URLs → spoken "link"
  t = t.replace(
    /https?:\/\/\S+/gi,
    ' link ',
  );
  t = t.replace(
    /\b(?:www\.)[a-z0-9][-a-z0-9.]*\.[a-z]{2,}\S*/gi,
    ' link ',
  );
  // Bare t.co / bit.ly style leftovers without scheme
  t = t.replace(
    /\b(?:t\.co|bit\.ly|buff\.ly|ow\.ly)\/\S+/gi,
    ' link ',
  );

  // pic.twitter.com / pic.x.com
  t = t.replace(/\bpic\.(?:twitter|x)\.com\/\S+/gi, ' link ');

  // Hashtags: read the word, not "hash"
  t = t.replace(/#(\w+)/g, '$1');

  // @handles: say the name, not "at"
  t = t.replace(/@(\w+)/g, '$1');

  // Cashtags: "dollar TSLA" is worse than just the ticker letters
  t = t.replace(/\$([A-Z]{1,5})\b/g, '$1');

  // Collapse emoji runs (model often mangles them)
  t = t.replace(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu, ' ');

  // Zero-width / bidi junk from copy-paste
  t = t.replace(/[\u200B-\u200D\uFEFF\u2060]/g, '');

  // Common tweet chrome
  t = t.replace(/\bshow this thread\b/gi, '');
  t = t.replace(/\breposted\b/gi, '');

  // Normalize social line breaks into spoken pauses.
  t = t.replace(/\n{2,}/g, '. ');
  t = t.replace(/\n/g, ' ');
  t = t.replace(/[^\S\n]+/g, ' ');
  t = t.replace(/(?:\s*link\s*){2,}/gi, ' link ');
  t = t.replace(/\s+([,.!?])/g, '$1');
  t = t.replace(/\.\s*\./g, '.');
  t = t.trim();

  return t;
}
