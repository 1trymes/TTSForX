/** Language conditioning supported by the official Supertonic 3 release. */

export const DEFAULT_TTS_LANGUAGE = 'en';

export const SUPPORTED_TTS_LANGUAGES = [
  'en',
  'ko',
  'ja',
  'ar',
  'bg',
  'cs',
  'da',
  'de',
  'el',
  'es',
  'et',
  'fi',
  'fr',
  'hi',
  'hr',
  'hu',
  'id',
  'it',
  'lt',
  'lv',
  'nl',
  'pl',
  'pt',
  'ro',
  'ru',
  'sk',
  'sl',
  'sv',
  'tr',
  'uk',
  'vi',
] as const;

const SUPPORTED = new Set<string>(SUPPORTED_TTS_LANGUAGES);

/** Normalize a BCP-47 value from X (for example en-GB → en). */
export function normalizeTtsLanguage(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_TTS_LANGUAGE;
  const primary = value.trim().toLowerCase().split(/[-_]/, 1)[0] ?? '';
  return SUPPORTED.has(primary) ? primary : DEFAULT_TTS_LANGUAGE;
}

export function isSupportedTtsLanguage(value: string): boolean {
  return SUPPORTED.has(value);
}
