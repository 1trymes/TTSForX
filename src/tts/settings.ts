/**
 * Persisted user preferences (chrome.storage.local — stable, not wiped by sync races).
 */
import { debugHandledFailure } from '../diagnostics';
import {
  DEFAULT_GENERATION_STEPS,
  normalizeGenerationSteps,
} from './quality';
import { ALL_VOICE_IDS, DEFAULT_VOICE } from './voices';

export interface Settings {
  /** Concrete Supertonic 3 voice-style id. */
  voice: string;
  /** Supertonic 3 flow-matching iterations: 5 fast through 12 high quality. */
  steps: number;
  /** Playback rate 0.5–1.5 (1.0 sits in the middle of the slider). */
  speed: number;
  /** Gain 0–2 — 1.0 (100%) sits in the middle of the slider. */
  volume: number;
  /** Show captions synchronized to the active media element. */
  karaoke: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  voice: DEFAULT_VOICE,
  steps: DEFAULT_GENERATION_STEPS,
  speed: 1,
  volume: 1,
  karaoke: true,
};

const KEY = 'ttsx.settings';
/** Bump only when a real migration runs — never rewrite user prefs casually. */
const REV = 9;
const REV_KEY = 'ttsx.settingsRev';

type Listener = (s: Settings, prev: Settings) => void;
const listeners = new Set<Listener>();
let cache: Settings = { ...DEFAULT_SETTINGS };
let ready: Promise<void> | null = null;
let storageBound = false;
let storageChangeListener:
  | ((
      changes: Record<string, Browser.storage.StorageChange>,
      areaName: string,
    ) => void)
  | null = null;
let pendingWrites = 0;
let writeChain: Promise<void> = Promise.resolve();

function storageArea(): typeof browser.storage.local | null {
  try {
    // Prefer local so sync merge races can't silently revert prefs.
    return browser.storage.local ?? browser.storage.sync ?? null;
  } catch {
    return null;
  }
}

function storageAreaName(): 'local' | 'sync' | null {
  try {
    if (browser.storage.local) return 'local';
    if (browser.storage.sync) return 'sync';
  } catch {
    /* unavailable */
  }
  return null;
}

function queueStorageWrite(
  area: typeof browser.storage.local,
  values: Record<string, unknown>,
): Promise<void> {
  pendingWrites++;
  const operation = writeChain
    .catch(() => {
      /* keep the queue usable after a transient storage failure */
    })
    .then(() => area.set(values));
  writeChain = operation.catch(() => {
    /* the caller still receives the original rejection */
  });
  return operation.finally(() => {
    pendingWrites = Math.max(0, pendingWrites - 1);
  });
}

function normalizeVoice(id: unknown): string {
  if (typeof id !== 'string' || !id || id === 'auto') return DEFAULT_VOICE;
  if ((ALL_VOICE_IDS as readonly string[]).includes(id)) return id;
  // Preserve the user's former gender preference when migrating from Kokoro.
  if (/^[ab]f_/.test(id)) return 'F1';
  if (/^[ab]m_/.test(id)) return 'M1';
  return DEFAULT_VOICE;
}

function applySaved(
  saved: Partial<Settings> | undefined,
  rev: number,
): { next: Settings; dirty: boolean } {
  let dirty = rev < REV;
  if (saved && typeof saved === 'object') {
    const next: Settings = {
      voice: normalizeVoice(saved.voice),
      steps: normalizeGenerationSteps(saved.steps),
      speed: clampNum(saved.speed, 0.5, 1.5, DEFAULT_SETTINGS.speed),
      volume: clampNum(saved.volume, 0, 2, DEFAULT_SETTINGS.volume),
      karaoke:
        typeof saved.karaoke === 'boolean'
          ? saved.karaoke
          : DEFAULT_SETTINGS.karaoke,
    };
    // Older builds used 0–1 with 100% pinned to the right — keep stored
    // 1.0 as the new center. Only lift the brief rev-2 50% default.
    if (rev < 3 && next.volume === 0.5) {
      next.volume = DEFAULT_SETTINGS.volume;
      dirty = true;
    }
    // Drop legacy Auto → concrete default once.
    if (saved.voice === 'auto' || saved.voice !== next.voice) {
      dirty = true;
    }
    // Rev 9 restores captions and adds bounded Supertonic quality steps.
    if (saved.steps !== next.steps || saved.karaoke !== next.karaoke) {
      dirty = true;
    }
    return { next, dirty };
  }
  return { next: { ...DEFAULT_SETTINGS }, dirty: true };
}

function bindStorageListener(): void {
  if (storageBound) return;
  try {
    const area = browser.storage?.onChanged;
    if (!area) return;
    storageBound = true;
    storageChangeListener = (changes, areaName) => {
      if (areaName !== storageAreaName() || pendingWrites > 0) return;
      const ch = changes[KEY];
      if (!ch || !ch.newValue || typeof ch.newValue !== 'object') return;
      const next = mergeSettings(
        DEFAULT_SETTINGS,
        ch.newValue as Partial<Settings>,
      );
      if (settingsEqual(cache, next)) return;
      const prev = { ...cache };
      cache = next;
      for (const l of listeners) l(cache, prev);
    };
    area.addListener(storageChangeListener);
  } catch {
    storageBound = false;
    storageChangeListener = null;
    /* ignore */
  }
}

export function loadSettings(): Promise<Settings> {
  if (!ready) {
    const task = (async () => {
      bindStorageListener();
      const area = storageArea();
      if (!area) return;
      const raw = await area.get([KEY, REV_KEY]);
      const saved = raw?.[KEY] as Partial<Settings> | undefined;
      const rev = Number(raw?.[REV_KEY] ?? 0);
      const { next, dirty } = applySaved(saved, rev);
      cache = next;

      if (dirty) {
        await queueStorageWrite(area, { [KEY]: cache, [REV_KEY]: REV });
      }
    })().catch((error) => {
      ready = null;
      debugHandledFailure('settings storage unavailable', error);
    });
    ready = task;
  }
  return ready.then(() => ({ ...cache }));
}

export function getSettings(): Settings {
  return { ...cache };
}

function mergeSettings(base: Settings, patch: Partial<Settings>): Settings {
  return {
    voice:
      patch.voice !== undefined ? normalizeVoice(patch.voice) : base.voice,
    steps:
      patch.steps !== undefined
        ? normalizeGenerationSteps(patch.steps)
        : base.steps,
    speed:
      patch.speed !== undefined
        ? clampNum(patch.speed, 0.5, 1.5, base.speed)
        : base.speed,
    volume:
      patch.volume !== undefined
        ? clampNum(patch.volume, 0, 2, base.volume)
        : base.volume,
    karaoke:
      patch.karaoke !== undefined ? patch.karaoke === true : base.karaoke,
  };
}

function settingsEqual(a: Settings, b: Settings): boolean {
  return (
    a.voice === b.voice &&
    a.steps === b.steps &&
    a.speed === b.speed &&
    a.volume === b.volume &&
    a.karaoke === b.karaoke
  );
}

/**
 * Persist settings. Cache is updated synchronously before any await so
 * playback never races a microtask and sees stale controls.
 */
export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const optimistic = mergeSettings(cache, patch);
  if (!settingsEqual(cache, optimistic)) {
    const prev = { ...cache };
    cache = optimistic;
    for (const l of listeners) l(cache, prev);
  }

  await loadSettings();

  // Re-apply patch on top of disk so a slow first-load can't wipe the toggle.
  const next = mergeSettings(cache, patch);
  if (!settingsEqual(cache, next)) {
    const prev = { ...cache };
    cache = next;
    for (const l of listeners) l(cache, prev);
  }

  const area = storageArea();
  if (area) {
    const snapshot = { ...cache };
    await queueStorageWrite(area, { [KEY]: snapshot, [REV_KEY]: REV });
  }
  return { ...cache };
}

export function onSettingsChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Release extension API listeners owned by an invalidated content bundle. */
export function disposeSettings(): void {
  if (storageChangeListener) {
    try {
      browser.storage.onChanged.removeListener(storageChangeListener);
    } catch {
      /* the extension context is already gone */
    }
  }
  storageChangeListener = null;
  storageBound = false;
  listeners.clear();
}

/** Resolve the concrete voice selected by the user. */
export function resolveVoice(settings: Settings): string {
  return normalizeVoice(settings.voice);
}

function clampNum(
  n: unknown,
  lo: number,
  hi: number,
  fallback: number,
): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}
