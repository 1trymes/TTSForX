# Karaoke jumps on Unicode-styled words

## Report and observation

Reported post: https://x.com/Voxyz_ai/status/2107184044228452491

Inspected the existing Chrome tab on 2026-10-06. Its opening contains
`𝗰𝗮𝗰𝗵𝗲 𝗰𝗼𝘂𝗻𝘁𝗱𝗼𝘄𝗻`, followed by ordinary occurrences of `cache` and `count`.
Later text also uses Unicode bold letters. These are distinct Unicode
characters, rather than ordinary letters with CSS font weight.

## Cause

`prepareTextForSpeech` applies NFKC normalization before generating speech.
`alignPreparedWordsToDom` previously lowercased DOM words without applying
the same normalization. Its forward scan therefore missed the styled words.
Substring matching then allowed the prepared `countdown` to match `count`.

The regression using the opening 70 words produced DOM indices
`[0, 1, 2, 3, 31, 46, -1, ...]`: the fifth spoken word highlighted the 32nd
visible word, then the sixth highlighted the 47th. A subsequent unsuccessful
search consumed the remaining DOM cursor, leaving following words unmapped.

## Fix

- Apply NFKC before case folding in the shared prepared-to-DOM comparison.
  Preserve original DOM text nodes and character ranges for accurate geometry.
- Advance the shared cursor only after a successful match, so an absent word
  does not discard every later word.
- The shared mapping also corrects Start from word picking for styled words.

No audio generation, acoustic timestamps, or animation timing changed.

## Validation

- Added three regression tests: the reported post opening, compatibility
  letters/digits, and recovery after an unmapped word.
- All three failed against the original implementation, then passed after the
  fix. The reported opening now maps to all 70 original word positions.
- `npm test`: 56 tests passed.
- `npm run typecheck`: passed.
- `npm run build`: passed, including production CSP, WebGPU provider, and
  packaged runtime asset verification.
- `git diff --check`: passed.

The refreshed unpacked build is in `.output/chrome-mv3`. Live playback with
the rebuilt extension remains unverified: browser automation blocks navigation
to `chrome://extensions/`. The user must reload TTSForX there, then refresh
the X tab to activate the new content script.
