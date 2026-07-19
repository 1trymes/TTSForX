import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cacheClear,
  cacheGet,
  cacheKey,
  cacheMergeChunks,
  cacheSetChunks,
  cacheStats,
} from '../src/tts/cache';
import {
  chunkTextForTts,
  MAX_CJK_TTS_CHUNK_CHARS,
  MAX_TTS_CHUNK_CHARS,
} from '../src/tts/chunkText';
import { normalizeTtsLanguage } from '../src/tts/languages';
import {
  locateWords,
  tokenizeWords,
  wordIndexAtCueTime,
} from '../src/tts/karaokeCues';
import {
  mapRecognizedWordCues,
  resampleForAlignment,
  trimWordCuesToSpeech,
} from '../src/tts/wordAlignment';
import {
  DEFAULT_GENERATION_STEPS,
  GENERATION_QUALITY_SLIDER_MAX,
  MAX_GENERATION_STEPS,
  MIN_GENERATION_STEPS,
  generationQualitySliderPosition,
  generationStepsAtSliderPosition,
  normalizeGenerationSteps,
} from '../src/tts/quality';
import {
  hasSpeakableText,
  prepareTextForSpeech,
} from '../src/tts/prepareText';
import {
  decodePcm16Base64,
  encodePcm16Base64,
} from '../src/tts/pcmTransport';
import {
  ALL_VOICE_IDS,
  DEFAULT_VOICE,
  defaultVoiceForLanguage,
  packForVoice,
} from '../src/tts/voices';
import { applyMediaPlaybackRate } from '../src/tts/wav';
import {
  actionIconSize,
  resolveActionIconColor,
  syncActionIconAppearance,
} from '../src/ui/theme';

afterEach(() => {
  cacheClear();
  vi.unstubAllGlobals();
});

describe('text preparation and chunking', () => {
  it('normalizes social text without leaving URL or emoji noise', () => {
    const prepared = prepareTextForSpeech(
      'Hey @alice — see https://example.com/post #Voice 🚀',
    );

    expect(prepared).toContain('Hey alice');
    expect(prepared).toContain('link Voice');
    expect(prepared).not.toMatch(/https?:|@alice|#Voice|🚀/);
    expect(hasSpeakableText('https://example.com 🚀')).toBe(false);
    expect(hasSpeakableText('Hello 🚀')).toBe(true);
  });

  it('keeps a normal X post as one continuous utterance', () => {
    const input = `${'A natural sentence with enough words to sound complete. '.repeat(5)}`.trim();
    expect(input.length).toBeLessThanOrEqual(MAX_TTS_CHUNK_CHARS);
    expect(chunkTextForTts(input)).toEqual([input]);
  });

  it('splits only long notes and preserves every character', () => {
    const input = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
    const chunks = chunkTextForTts(input);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= MAX_TTS_CHUNK_CHARS)).toBe(
      true,
    );
    expect(chunks.join(' ')).toBe(input);
  });

  it('returns no chunks for whitespace-only input', () => {
    expect(chunkTextForTts(' \n\t ')).toEqual([]);
  });

  it('uses the official shorter cap for Japanese and Korean', () => {
    const text = '文'.repeat(250);
    const chunks = chunkTextForTts(text, 'ja');
    expect(chunks.every((chunk) => chunk.length <= MAX_CJK_TTS_CHUNK_CHARS)).toBe(
      true,
    );
    expect(chunks.join('')).toBe(text);
  });

  it('normalizes X language metadata to supported model conditioning', () => {
    expect(normalizeTtsLanguage('de-DE')).toBe('de');
    expect(normalizeTtsLanguage('JA')).toBe('ja');
    expect(normalizeTtsLanguage('unsupported')).toBe('en');
  });
});

describe('audio cache', () => {
  it('isolates Supertonic voices', () => {
    expect(cacheKey('same text', 'M1')).not.toBe(
      cacheKey('same text', 'F1'),
    );
    expect(cacheKey('same text', 'M1', 'en')).not.toBe(
      cacheKey('same text', 'M1', 'de'),
    );
    expect(cacheKey('same text', 'M1', 'en', 5)).not.toBe(
      cacheKey('same text', 'M1', 'en', 12),
    );
  });

  it('merges partial chunks densely and preserves completed entries', () => {
    const key = cacheKey('hello world', 'M1');
    cacheSetChunks(
      key,
      [new Float32Array([0.1, 0.2])],
      44_100,
      false,
      2,
      ['hello'],
      [[{ start: 0.1, end: 0.2 }]],
    );
    cacheMergeChunks(
      key,
      1,
      [new Float32Array([0.3])],
      44_100,
      true,
      2,
      ['world'],
      [[{ start: 0.3, end: 0.4 }]],
    );

    const hit = cacheGet(key);
    expect(hit?.complete).toBe(true);
    expect(hit?.total).toBe(2);
    expect(hit?.texts).toEqual(['hello', 'world']);
    expect(hit?.wordCues).toEqual([
      [{ start: 0.1, end: 0.2 }],
      [{ start: 0.3, end: 0.4 }],
    ]);
    expect(hit?.chunks.map((chunk) => [...chunk])).toEqual([
      [expect.closeTo(0.1), expect.closeTo(0.2)],
      [expect.closeTo(0.3)],
    ]);
    expect(cacheStats()).toEqual({ size: 1, bytes: 12 });
  });

  it('does not expose mutable PCM references', () => {
    const key = cacheKey('copy me', 'M1');
    const source = new Float32Array([0.25]);
    cacheSetChunks(key, [source], 44_100, true);
    source[0] = 0.9;

    const first = cacheGet(key)!;
    first.chunks[0]![0] = 0.8;
    expect(cacheGet(key)!.chunks[0]![0]).toBeCloseTo(0.25);
  });
});

describe('Supertonic generation quality', () => {
  it('normalizes to the official production range', () => {
    expect(normalizeGenerationSteps(undefined)).toBe(
      DEFAULT_GENERATION_STEPS,
    );
    expect(normalizeGenerationSteps(1)).toBe(MIN_GENERATION_STEPS);
    expect(normalizeGenerationSteps(20)).toBe(MAX_GENERATION_STEPS);
    expect(normalizeGenerationSteps(9.6)).toBe(10);
  });

  it('centers the default without inventing an unsupported quality step', () => {
    expect(generationQualitySliderPosition(MIN_GENERATION_STEPS)).toBe(0);
    expect(generationQualitySliderPosition(DEFAULT_GENERATION_STEPS)).toBe(
      GENERATION_QUALITY_SLIDER_MAX / 2,
    );
    expect(generationQualitySliderPosition(MAX_GENERATION_STEPS)).toBe(
      GENERATION_QUALITY_SLIDER_MAX,
    );

    for (
      let steps = MIN_GENERATION_STEPS;
      steps <= MAX_GENERATION_STEPS;
      steps++
    ) {
      expect(
        generationStepsAtSliderPosition(
          generationQualitySliderPosition(steps),
        ),
      ).toBe(steps);
    }
  });
});

describe('playback controls and acoustic karaoke timing', () => {
  it('selects words only inside model-derived media-time cues', () => {
    expect(tokenizeWords('One, two three.')).toEqual([
      'One,',
      'two',
      'three.',
    ]);
    expect(locateWords('  One, — two three.')).toEqual([
      { text: 'One,', start: 2, end: 6 },
      { text: 'two', start: 9, end: 12 },
      { text: 'three.', start: 13, end: 19 },
    ]);
    const cues = [
      { start: 0.12, end: 0.31 },
      { start: 0.4, end: 0.61 },
      { start: 0.72, end: 1.05 },
    ];
    expect(wordIndexAtCueTime(cues, 0)).toBeNull();
    expect(wordIndexAtCueTime(cues, 0.2)).toBe(0);
    expect(wordIndexAtCueTime(cues, 0.35)).toBeNull();
    expect(wordIndexAtCueTime(cues, 0.5)).toBe(1);
    expect(wordIndexAtCueTime(cues, 0.9)).toBe(2);
  });

  it('maps spoken expansions to the displayed word without estimating time', () => {
    const cues = mapRecognizedWordCues(
      'Released in 2026 today',
      [
        { text: 'Released', timestamp: [0.1, 0.4] },
        { text: 'in', timestamp: [0.45, 0.55] },
        { text: 'twenty', timestamp: [0.6, 0.8] },
        { text: 'twenty', timestamp: [0.8, 1] },
        { text: 'six', timestamp: [1, 1.15] },
        { text: 'today', timestamp: [1.2, 1.5] },
      ],
      1.6,
    );

    expect(cues).toEqual([
      { start: 0.1, end: 0.4 },
      { start: 0.45, end: 0.55 },
      { start: 0.6, end: 1.15 },
      { start: 1.2, end: 1.5 },
    ]);
  });

  it('rejects incomplete acoustic alignment instead of using a fallback', () => {
    expect(() =>
      mapRecognizedWordCues(
        'one two three',
        [
          { text: 'one', timestamp: [0, 0.2] },
          { text: 'three', timestamp: [0.4, 0.6] },
        ],
        0.7,
      ),
    ).toThrow(/incomplete/);
  });

  it('band-limits PCM while preserving exact sample-time duration', () => {
    const source = new Float32Array(44_100);
    source[22_050] = 1;
    const result = resampleForAlignment(source, 44_100);
    expect(result).toHaveLength(16_000);
    expect(result.some((value) => Math.abs(value) > 0.01)).toBe(true);
  });

  it('removes real PCM silence from word tails without moving DTW boundaries', () => {
    const samples = new Float32Array(32_000);
    samples.fill(0.2, 1_600, 6_400);
    samples.fill(0.2, 16_000, 24_000);
    const cues = trimWordCuesToSpeech(
      [
        { start: 0, end: 1 },
        { start: 1, end: 2 },
      ],
      samples,
      16_000,
    );

    expect(cues[0]!.start).toBeCloseTo(0.075, 2);
    expect(cues[0]!.end).toBeLessThan(0.5);
    expect(cues[1]!.start).toBe(1);
    expect(cues[1]!.end).toBeLessThan(1.6);
  });

  it('sets effective and default media rates so source loads cannot reset speed', () => {
    const media = {
      preservesPitch: false,
      defaultPlaybackRate: 1,
      playbackRate: 1,
    } as HTMLAudioElement;

    applyMediaPlaybackRate(media, 1.35);

    expect(media.preservesPitch).toBe(true);
    expect(media.defaultPlaybackRate).toBe(1.35);
    expect(media.playbackRate).toBe(1.35);
  });
});

describe('PCM extension transport', () => {
  it('round-trips signed 16-bit audio without JSON float expansion', () => {
    const source = new Float32Array([-1, -0.25, 0, 0.25, 1]);
    const encoded = encodePcm16Base64(source);
    const decoded = decodePcm16Base64(encoded);

    expect(encoded).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect([...decoded]).toEqual([
      expect.closeTo(-1, 4),
      expect.closeTo(-0.25, 4),
      0,
      expect.closeTo(0.25, 4),
      expect.closeTo(1, 4),
    ]);
  });

  it('rejects malformed payloads', () => {
    expect(decodePcm16Base64('not base64')).toHaveLength(0);
    expect(decodePcm16Base64('AA==')).toHaveLength(0);
  });
});

describe('voice catalogue', () => {
  it('resolves the official Supertonic 3 styles', () => {
    expect(ALL_VOICE_IDS).toEqual([
      'F1',
      'F2',
      'F3',
      'F4',
      'F5',
      'M1',
      'M2',
      'M3',
      'M4',
      'M5',
    ]);
    expect(defaultVoiceForLanguage('en-GB')).toBe(DEFAULT_VOICE);
    expect(defaultVoiceForLanguage('unknown')).toBe(DEFAULT_VOICE);
    expect(packForVoice('F3')?.label).toBe('Voice');
    expect(packForVoice('M4')?.label).toBe('Voice');
  });
});

describe('X action icon matching', () => {
  it('uses the neighboring action glyph size in compact rows', () => {
    expect(actionIconSize(18.75, 18.75)).toBe(18.75);
    expect(actionIconSize(20, 18.75)).toBe(18.75);
    expect(actionIconSize(0, 0)).toBeNull();
    expect(actionIconSize(34.75, 34.75)).toBeNull();
  });

  it('prefers the painted SVG color over a button text color', () => {
    expect(
      resolveActionIconColor([
        'none',
        'rgba(0, 0, 0, 0)',
        'rgb(113, 118, 123)',
        'rgb(231, 233, 234)',
      ]),
    ).toBe('rgb(113, 118, 123)');
  });

  it('copies the neighboring X icon appearance to the speaker root', () => {
    const setProperty = vi.fn();
    const painted = {};
    const svg = {
      querySelector: () => painted,
      getBoundingClientRect: () => ({ width: 18.75, height: 18.75 }),
    };
    const source = { querySelector: () => svg };
    vi.stubGlobal('getComputedStyle', (element: unknown) =>
      element === painted
        ? { fill: 'rgb(113, 118, 123)', stroke: 'none', color: 'white' }
        : { fill: 'none', stroke: 'none', color: 'white' },
    );

    syncActionIconAppearance(
      { style: { setProperty } } as unknown as HTMLElement,
      source as unknown as ParentNode,
    );

    expect(setProperty).toHaveBeenCalledWith(
      '--ttsx-dim',
      'rgb(113, 118, 123)',
    );
    expect(setProperty).toHaveBeenCalledWith('--ttsx-icon-size', '18.75px');
  });
});
