/** Official Supertonic 3 preset voice styles. */

export interface Voice {
  id: string;
  name: string;
  gender: 'female' | 'male';
}

export interface LanguagePack {
  iso: string[];
  label: string;
  defaultVoice: string;
  voices: Voice[];
}

const FEMALE_VOICES: Voice[] = [
  { id: 'F1', name: 'Female 1', gender: 'female' },
  { id: 'F2', name: 'Female 2', gender: 'female' },
  { id: 'F3', name: 'Female 3', gender: 'female' },
  { id: 'F4', name: 'Female 4', gender: 'female' },
  { id: 'F5', name: 'Female 5', gender: 'female' },
];

const MALE_VOICES: Voice[] = [
  { id: 'M1', name: 'Male 1', gender: 'male' },
  { id: 'M2', name: 'Male 2', gender: 'male' },
  { id: 'M3', name: 'Male 3', gender: 'male' },
  { id: 'M4', name: 'Male 4', gender: 'male' },
  { id: 'M5', name: 'Male 5', gender: 'male' },
];

export const DEFAULT_VOICE = 'M1';

/**
 * Kept as packs for the existing settings UI contract. Supertonic 3 voices
 * are multilingual; the selected style is independent of input language.
 */
export const LANGUAGES: readonly LanguagePack[] = [
  {
    iso: ['mul'],
    label: 'Voice',
    defaultVoice: 'F1',
    voices: FEMALE_VOICES,
  },
  {
    iso: ['mul'],
    label: 'Voice',
    defaultVoice: DEFAULT_VOICE,
    voices: MALE_VOICES,
  },
];

export const ALL_VOICE_IDS: readonly string[] = [
  ...FEMALE_VOICES.map((voice) => voice.id),
  ...MALE_VOICES.map((voice) => voice.id),
];

export const MENU_VOICES: readonly {
  id: string;
  label: string;
  group: string;
}[] = [
  ...FEMALE_VOICES.map((voice) => ({
    id: voice.id,
    label: voice.name,
    group: 'Voice',
  })),
  ...MALE_VOICES.map((voice) => ({
    id: voice.id,
    label: voice.name,
    group: 'Voice',
  })),
];

export function defaultVoiceForLanguage(
  _iso: string | undefined | null,
): string {
  return DEFAULT_VOICE;
}

export function packForVoice(voiceId: string): LanguagePack | undefined {
  return LANGUAGES.find((pack) =>
    pack.voices.some((voice) => voice.id === voiceId),
  );
}
