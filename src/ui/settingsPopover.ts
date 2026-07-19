/**
 * Hold-to-open settings — X Dropdown styling.
 * Fixed to the viewport (anchored to the button) so we never mutate article layout.
 * Voice row: category on the left, concrete voice on the right (no Auto).
 */
import {
  getSettings,
  loadSettings,
  onSettingsChange,
  saveSettings,
} from '../tts/settings';
import { debugHandledFailure } from '../diagnostics';
import {
  GENERATION_QUALITY_SLIDER_MAX,
  generationQualityLabel,
  generationQualitySliderPosition,
} from '../tts/quality';
import { DEFAULT_VOICE, MENU_VOICES } from '../tts/voices';
import { applyTheme, paintTtsxRoot, syncActionIconColor } from './theme';
import { bindGenerationQualityRange } from './qualityRange';
import { bindRangeFill, paintRangeFill } from './rangeFill';

let openEl: HTMLElement | null = null;
let outsideHandler: ((e: Event) => void) | null = null;
let outsideTimer: ReturnType<typeof setTimeout> | null = null;
let popoverGeneration = 0;
let openCleanup: (() => void) | null = null;

export type VoicePreviewState = 'idle' | 'loading' | 'playing';

type VoicePreviewHandler = (
  voice: string | null,
  onState: (state: VoicePreviewState) => void,
) => void;

interface ReadingControlsHandler {
  startFrom(anchor: HTMLElement): Promise<boolean>;
}

let voicePreviewHandler: VoicePreviewHandler | null = null;
let readingControlsHandler: ReadingControlsHandler | null = null;

export function registerVoicePreviewHandler(
  handler: VoicePreviewHandler,
): void {
  voicePreviewHandler = handler;
}

export function registerReadingControls(
  handler: ReadingControlsHandler,
): void {
  readingControlsHandler = handler;
}

function closePopover(): void {
  popoverGeneration++;
  if (outsideTimer != null) {
    clearTimeout(outsideTimer);
    outsideTimer = null;
  }
  if (outsideHandler) {
    document.removeEventListener('pointerdown', outsideHandler, true);
    outsideHandler = null;
  }
  const cleanup = openCleanup;
  openCleanup = null;
  cleanup?.();
  openEl?.remove();
  openEl = null;
}

function paintSpeed(n: number): string {
  return `${n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}×`;
}

function voiceMeta(id: string): { group: string; label: string } {
  const v = MENU_VOICES.find((x) => x.id === id);
  return {
    group: v?.group ?? 'Voice',
    label: v?.label ?? id,
  };
}

function resolveMenuVoice(id: string): string {
  if (MENU_VOICES.some((v) => v.id === id)) return id;
  return DEFAULT_VOICE;
}

const ICON_PREVIEW = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M8 5v14l11-7z"/>
  </svg>`;

const ICON_STOP_PREVIEW = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="7" y="7" width="10" height="10" rx="1"/>
  </svg>`;

const ICON_LOADING = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="8"/>
  </svg>`;

const ICON_PICK_WORD = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M5 3l13 9-7 2 4 7-2 1-4-7-4 4V3z"/>
  </svg>`;

export type PopoverSide = 'above' | 'below';

interface RectangleEdges {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface ViewportRectangle {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface PopoverPlacement {
  top: number;
  left: number;
  maxHeight: number;
  maxWidth: number;
  side: PopoverSide;
}

export function computePopoverPlacement(
  anchor: RectangleEdges,
  popWidth: number,
  popHeight: number,
  viewport: ViewportRectangle,
  preferredSide?: PopoverSide,
): PopoverPlacement {
  const padding = 8;
  const gap = 8;
  const right = viewport.left + viewport.width;
  const bottom = viewport.top + viewport.height;
  const maxWidth = Math.max(1, viewport.width - padding * 2);
  const width = Math.min(popWidth, maxWidth);
  const above = Math.max(
    0,
    anchor.top - viewport.top - padding - gap,
  );
  const below = Math.max(0, bottom - padding - anchor.bottom - gap);

  let side: PopoverSide;
  const preferredSpace = preferredSide === 'above' ? above : below;
  const alternateSpace = preferredSide === 'above' ? below : above;
  const minimumUsefulHeight = Math.min(
    popHeight,
    Math.max(1, viewport.height - padding * 2),
    160,
  );
  if (
    preferredSide &&
    (preferredSpace >= minimumUsefulHeight || preferredSpace >= alternateSpace)
  ) {
    side = preferredSide;
  } else if (popHeight <= above) {
    side = 'above';
  } else if (popHeight <= below) {
    side = 'below';
  } else {
    side = above >= below ? 'above' : 'below';
  }

  const sideHeight = side === 'above' ? above : below;
  const maxHeight = Math.max(1, Math.min(viewport.height - padding * 2, sideHeight));
  const height = Math.min(popHeight, maxHeight);
  const unclampedTop =
    side === 'above' ? anchor.top - gap - height : anchor.bottom + gap;
  const top = Math.max(
    viewport.top + padding,
    Math.min(unclampedTop, bottom - padding - height),
  );
  const left = Math.max(
    viewport.left + padding,
    Math.min(anchor.right - width, right - padding - width),
  );

  return { top, left, maxHeight, maxWidth, side };
}

function currentViewport(): ViewportRectangle {
  const visual = window.visualViewport;
  return {
    top: visual?.offsetTop ?? 0,
    left: visual?.offsetLeft ?? 0,
    width: visual?.width ?? window.innerWidth,
    height: visual?.height ?? window.innerHeight,
  };
}

/** Place the fixed panel beside its speaker without leaving the viewport. */
function placeNearAnchor(pop: HTMLElement, anchor: HTMLElement): void {
  const viewport = currentViewport();
  pop.style.maxWidth = `${Math.max(1, Math.floor(viewport.width - 16))}px`;
  pop.style.maxHeight = `${Math.max(1, Math.floor(viewport.height - 16))}px`;

  const btn = anchor.getBoundingClientRect();
  // Layout dimensions are stable while the opening animation is transforming
  // the panel; getBoundingClientRect() would measure the temporary scale and
  // cause a visible correction when the animation ends.
  const panelWidth = pop.offsetWidth;
  const panelHeight = pop.offsetHeight;
  const savedSide = pop.dataset.ttsxPlacement as PopoverSide | undefined;
  const placement = computePopoverPlacement(
    btn,
    panelWidth,
    panelHeight,
    viewport,
    savedSide,
  );

  pop.dataset.ttsxPlacement = placement.side;
  pop.style.maxWidth = `${Math.floor(placement.maxWidth)}px`;
  pop.style.maxHeight = `${Math.floor(placement.maxHeight)}px`;
  pop.style.left = `${Math.round(placement.left)}px`;
  pop.style.top = `${Math.round(placement.top)}px`;
}

export async function openSettingsPopover(
  anchor: HTMLElement,
): Promise<void> {
  closePopover();
  const generation = popoverGeneration;
  await loadSettings();
  if (generation !== popoverGeneration || !anchor.isConnected) return;
  applyTheme();
  syncActionIconColor();
  const s = getSettings();
  const voiceId = resolveMenuVoice(s.voice);
  const meta = voiceMeta(voiceId);

  const pop = document.createElement('div');
  pop.className = 'ttsx-popover';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Voice settings');

  let voiceOpen = false;

  pop.innerHTML = `
    <div class="ttsx-field ttsx-field--voice">
      <button type="button" class="ttsx-voice-btn" data-ttsx="voiceBtn" aria-haspopup="listbox" aria-expanded="false">
        <span class="ttsx-voice-cat" data-ttsx="voiceCat">${meta.group}</span>
        <span class="ttsx-voice-right">
          <span data-ttsx="voiceName">${meta.label}</span>
          <svg class="ttsx-chevron" viewBox="0 0 12 8" aria-hidden="true"><path d="M1 1l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </span>
      </button>
      <div class="ttsx-voice-list" data-ttsx="voiceList" role="listbox" hidden></div>
    </div>

    <label class="ttsx-field">
      <span class="ttsx-slider-head">
        <span class="ttsx-field-label">Speed</span>
        <em class="ttsx-val" data-ttsx="speedVal">${paintSpeed(s.speed)}</em>
      </span>
      <input class="ttsx-range" data-ttsx="speed" type="range" min="0.5" max="1.5" step="0.05" value="${s.speed}" />
    </label>

    <label class="ttsx-field">
      <span class="ttsx-slider-head">
        <span class="ttsx-field-label">Volume</span>
        <em class="ttsx-val" data-ttsx="volumeVal">${Math.round(s.volume * 100)}%</em>
      </span>
      <input class="ttsx-range" data-ttsx="volume" type="range" min="0" max="2" step="0.05" value="${s.volume}" />
    </label>

    <label class="ttsx-field">
      <span class="ttsx-slider-head">
        <span class="ttsx-field-label">Quality</span>
        <em class="ttsx-val" data-ttsx="stepsVal">${generationQualityLabel(s.steps)}</em>
      </span>
      <input class="ttsx-range" data-ttsx="steps" type="range" min="0" max="${GENERATION_QUALITY_SLIDER_MAX}" step="1" value="${generationQualitySliderPosition(s.steps)}" />
    </label>

    <label class="ttsx-field ttsx-toggle-field">
      <span class="ttsx-field-label">Karaoke captions</span>
      <input class="ttsx-check" data-ttsx="karaoke" type="checkbox" ${s.karaoke ? 'checked' : ''} />
    </label>

    <div class="ttsx-field ttsx-start-field">
      <button type="button" class="ttsx-start-btn" data-ttsx="startFrom">
        <span class="ttsx-field-label">Start from</span>
        <span class="ttsx-start-action">
          <span>Select word</span>
          ${ICON_PICK_WORD}
        </span>
      </button>
    </div>
  `;

  const list = pop.querySelector<HTMLElement>('[data-ttsx="voiceList"]')!;
  let lastGroup = '';
  for (const v of MENU_VOICES) {
    if (v.group && v.group !== lastGroup) {
      lastGroup = v.group;
      const g = document.createElement('div');
      g.className = 'ttsx-voice-group';
      g.textContent = v.group;
      list.appendChild(g);
    }
    const opt = document.createElement('div');
    opt.className = 'ttsx-voice-opt';
    opt.setAttribute('role', 'option');
    opt.dataset.value = v.id;
    if (v.id === voiceId) opt.setAttribute('aria-selected', 'true');

    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'ttsx-voice-select';
    select.dataset.value = v.id;
    select.textContent = v.label;
    select.setAttribute('aria-label', `Select ${v.label}`);

    const preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'ttsx-voice-preview';
    preview.dataset.value = v.id;
    preview.dataset.previewState = 'idle';
    preview.setAttribute('aria-label', `Preview ${v.label}`);
    preview.setAttribute('title', `Preview ${v.label}`);
    preview.innerHTML = ICON_PREVIEW;

    opt.append(select, preview);
    list.appendChild(opt);
  }

  paintTtsxRoot(pop);
  document.documentElement.appendChild(pop);
  openEl = pop;
  placeNearAnchor(pop, anchor);

  let placementFrame: number | null = null;
  const schedulePlacement = () => {
    if (placementFrame != null) cancelAnimationFrame(placementFrame);
    placementFrame = requestAnimationFrame(() => {
      placementFrame = null;
      if (
        generation === popoverGeneration &&
        pop.isConnected &&
        anchor.isConnected
      ) {
        placeNearAnchor(pop, anchor);
      }
    });
  };
  window.addEventListener('resize', schedulePlacement);
  window.visualViewport?.addEventListener('resize', schedulePlacement);
  window.visualViewport?.addEventListener('scroll', schedulePlacement);

  const voiceBtn = pop.querySelector<HTMLButtonElement>('[data-ttsx="voiceBtn"]')!;
  const voiceCatEl = pop.querySelector<HTMLElement>('[data-ttsx="voiceCat"]')!;
  const voiceNameEl = pop.querySelector<HTMLElement>('[data-ttsx="voiceName"]')!;
  const speedEl = pop.querySelector<HTMLInputElement>('[data-ttsx="speed"]')!;
  const volumeEl = pop.querySelector<HTMLInputElement>('[data-ttsx="volume"]')!;
  const stepsEl = pop.querySelector<HTMLInputElement>('[data-ttsx="steps"]')!;
  const karaokeEl = pop.querySelector<HTMLInputElement>('[data-ttsx="karaoke"]')!;
  const startFromEl = pop.querySelector<HTMLButtonElement>(
    '[data-ttsx="startFrom"]',
  )!;
  const speedVal = pop.querySelector<HTMLElement>('[data-ttsx="speedVal"]')!;
  const volumeVal = pop.querySelector<HTMLElement>('[data-ttsx="volumeVal"]')!;
  const stepsVal = pop.querySelector<HTMLElement>('[data-ttsx="stepsVal"]')!;
  let activePreviewVoice: string | null = null;

  function paintPreviewState(
    voice: string | null,
    state: VoicePreviewState,
  ): void {
    for (const preview of list.querySelectorAll<HTMLButtonElement>(
      '.ttsx-voice-preview',
    )) {
      const active = preview.dataset.value === voice && state !== 'idle';
      preview.dataset.previewState = active ? state : 'idle';
      preview.innerHTML =
        active && state === 'loading'
          ? ICON_LOADING
          : active
            ? ICON_STOP_PREVIEW
            : ICON_PREVIEW;
      const label = voiceMeta(preview.dataset.value ?? '').label;
      preview.setAttribute(
        'aria-label',
        active ? `Stop ${label} preview` : `Preview ${label}`,
      );
      preview.setAttribute(
        'title',
        active ? `Stop ${label} preview` : `Preview ${label}`,
      );
    }
  }

  function stopPreview(): void {
    if (!activePreviewVoice) return;
    activePreviewVoice = null;
    paintPreviewState(null, 'idle');
    voicePreviewHandler?.(null, () => {});
  }

  openCleanup = stopPreview;

  function paintVoice(id: string): void {
    const m = voiceMeta(id);
    voiceCatEl.textContent = m.group;
    voiceNameEl.textContent = m.label;
  }

  function setVoiceOpen(open: boolean): void {
    voiceOpen = open;
    list.hidden = !open;
    voiceBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    pop.classList.toggle('ttsx-voice-open', open);
    schedulePlacement();
  }

  voiceBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setVoiceOpen(!voiceOpen);
  });

  list.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const preview = target.closest<HTMLButtonElement>(
      '.ttsx-voice-preview',
    );
    if (preview?.dataset.value) {
      e.preventDefault();
      e.stopPropagation();
      const value = preview.dataset.value;
      if (activePreviewVoice === value) {
        stopPreview();
        return;
      }
      activePreviewVoice = value;
      paintPreviewState(value, 'loading');
      voicePreviewHandler?.(value, (state) => {
        if (
          generation !== popoverGeneration ||
          !pop.isConnected ||
          activePreviewVoice !== value
        ) {
          return;
        }
        if (state === 'idle') activePreviewVoice = null;
        paintPreviewState(
          state === 'idle' ? null : value,
          state,
        );
      });
      return;
    }

    const btn = target.closest<HTMLButtonElement>('.ttsx-voice-select');
    if (!btn?.dataset.value) return;
    e.preventDefault();
    e.stopPropagation();
    const value = btn.dataset.value;
    for (const o of list.querySelectorAll('.ttsx-voice-opt')) {
      o.removeAttribute('aria-selected');
    }
    btn.closest('.ttsx-voice-opt')?.setAttribute('aria-selected', 'true');
    paintVoice(value);
    setVoiceOpen(false);
    void saveSettings({ voice: value });
    stopPreview();
  });

  speedEl.addEventListener('input', () => {
    const v = Number(speedEl.value);
    speedVal.textContent = paintSpeed(v);
    void saveSettings({ speed: v });
  });
  volumeEl.addEventListener('input', () => {
    const v = Number(volumeEl.value);
    volumeVal.textContent = `${Math.round(v * 100)}%`;
    void saveSettings({ volume: v });
  });
  const disposeQualityBinding = bindGenerationQualityRange(
    stepsEl,
    s.steps,
    (v) => {
    stepsVal.textContent = generationQualityLabel(v);
    void saveSettings({ steps: v });
    },
  );
  const disposeRangeFills = [speedEl, volumeEl, stepsEl].map(bindRangeFill);
  karaokeEl.addEventListener('change', () => {
    void saveSettings({ karaoke: karaokeEl.checked });
  });

  const removeLiveSettings = onSettingsChange((settings) => {
    const nextVoice = resolveMenuVoice(settings.voice);
    paintVoice(nextVoice);
    for (const row of list.querySelectorAll<HTMLElement>('.ttsx-voice-opt')) {
      row.setAttribute(
        'aria-selected',
        row.dataset.value === nextVoice ? 'true' : 'false',
      );
    }
    if (document.activeElement !== speedEl) {
      speedEl.value = String(settings.speed);
      speedVal.textContent = paintSpeed(settings.speed);
      paintRangeFill(speedEl);
    }
    if (document.activeElement !== volumeEl) {
      volumeEl.value = String(settings.volume);
      volumeVal.textContent = `${Math.round(settings.volume * 100)}%`;
      paintRangeFill(volumeEl);
    }
    if (document.activeElement !== stepsEl) {
      stepsEl.value = String(
        generationQualitySliderPosition(settings.steps),
      );
      stepsEl.dataset.qualitySteps = String(settings.steps);
      stepsEl.setAttribute('aria-valuenow', String(settings.steps));
      stepsEl.setAttribute(
        'aria-valuetext',
        generationQualityLabel(settings.steps),
      );
      stepsVal.textContent = generationQualityLabel(settings.steps);
      paintRangeFill(stepsEl);
    }
    karaokeEl.checked = settings.karaoke;
  });
  const previousCleanup = openCleanup;
  openCleanup = () => {
    previousCleanup?.();
    window.removeEventListener('resize', schedulePlacement);
    window.visualViewport?.removeEventListener('resize', schedulePlacement);
    window.visualViewport?.removeEventListener('scroll', schedulePlacement);
    if (placementFrame != null) cancelAnimationFrame(placementFrame);
    removeLiveSettings();
    disposeQualityBinding();
    for (const dispose of disposeRangeFills) dispose();
  };

  startFromEl.disabled = !readingControlsHandler;
  startFromEl.addEventListener('click', async () => {
    if (!readingControlsHandler || startFromEl.disabled) return;
    startFromEl.disabled = true;
    try {
      const started = await readingControlsHandler.startFrom(anchor);
      if (started) closePopover();
    } catch (error) {
      debugHandledFailure('could not start word selection', error);
    } finally {
      if (generation === popoverGeneration && pop.isConnected) {
        startFromEl.disabled = false;
      }
    }
  });

  pop.addEventListener('pointerdown', (e) => e.stopPropagation());

  outsideHandler = (e: Event) => {
    const t = e.target as Node | null;
    if (t && (pop.contains(t) || anchor.contains(t))) return;
    closePopover();
  };
  outsideTimer = setTimeout(() => {
    outsideTimer = null;
    const handler = outsideHandler;
    if (handler && generation === popoverGeneration) {
      document.addEventListener('pointerdown', handler, true);
    }
  }, 0);
}

export function isSettingsOpen(): boolean {
  return openEl != null;
}

export { closePopover };
