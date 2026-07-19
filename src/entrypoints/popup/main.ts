import {
  disposeSettings,
  loadSettings,
  onSettingsChange,
  saveSettings,
  type Settings,
} from '../../tts/settings';
import {
  generationQualityLabel,
  generationQualitySliderPosition,
} from '../../tts/quality';
import { DEFAULT_VOICE, MENU_VOICES } from '../../tts/voices';
import { bindGenerationQualityRange } from '../../ui/qualityRange';
import { bindRangeFill, paintRangeFill } from '../../ui/rangeFill';

const ICON_PLAY = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M8 5v14l11-7z"/>
  </svg>`;
const ICON_STOP = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="7" y="7" width="10" height="10" rx="1"/>
  </svg>`;
const ICON_LOADING = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="8"/>
  </svg>`;

const voiceButton = document.getElementById(
  'voiceButton',
) as HTMLButtonElement;
const voiceName = document.getElementById('voiceName') as HTMLElement;
const voiceList = document.getElementById('voiceList') as HTMLElement;
const speedEl = document.getElementById('speed') as HTMLInputElement;
const volumeEl = document.getElementById('volume') as HTMLInputElement;
const stepsEl = document.getElementById('steps') as HTMLInputElement;
const karaokeEl = document.getElementById('karaoke') as HTMLInputElement;
const speedVal = document.getElementById('speedVal') as HTMLElement;
const volumeVal = document.getElementById('volumeVal') as HTMLElement;
const stepsVal = document.getElementById('stepsVal') as HTMLElement;
const startFrom = document.getElementById('startFrom') as HTMLButtonElement;

let activeTabId: number | null = null;
let activePreviewVoice: string | null = null;
let previewState: 'idle' | 'loading' | 'playing' = 'idle';
let voiceOpen = false;

function resolveVoice(id: string): string {
  return MENU_VOICES.some((voice) => voice.id === id)
    ? id
    : DEFAULT_VOICE;
}

function voiceLabel(id: string): string {
  return MENU_VOICES.find((voice) => voice.id === id)?.label ?? id;
}

function paintSpeed(value: number): void {
  speedVal.textContent =
    `${value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}×`;
}

function paintVolume(value: number): void {
  volumeVal.textContent = `${Math.round(value * 100)}%`;
}

function setVoiceOpen(open: boolean): void {
  voiceOpen = open;
  voiceList.hidden = !open;
  voiceButton.setAttribute('aria-expanded', open ? 'true' : 'false');
  document.body.classList.toggle('voice-open', open);
}

function paintPreviewButtons(): void {
  for (const button of voiceList.querySelectorAll<HTMLButtonElement>(
    '.voice-preview',
  )) {
    const active =
      button.dataset.value === activePreviewVoice && previewState !== 'idle';
    button.dataset.previewState = active ? previewState : 'idle';
    button.innerHTML =
      active && previewState === 'loading'
        ? ICON_LOADING
        : active
          ? ICON_STOP
          : ICON_PLAY;
    const label = voiceLabel(button.dataset.value ?? '');
    button.setAttribute(
      'aria-label',
      active ? `Stop ${label} preview` : `Preview ${label}`,
    );
    button.title = active ? `Stop ${label} preview` : `Preview ${label}`;
  }
}

function paintVoice(id: string): void {
  const resolved = resolveVoice(id);
  voiceName.textContent = voiceLabel(resolved);
  for (const row of voiceList.querySelectorAll<HTMLElement>('.voice-option')) {
    row.setAttribute(
      'aria-selected',
      row.dataset.value === resolved ? 'true' : 'false',
    );
  }
}

function paintSettings(settings: Settings): void {
  paintVoice(settings.voice);
  if (document.activeElement !== speedEl) {
    speedEl.value = String(settings.speed);
    paintSpeed(settings.speed);
    paintRangeFill(speedEl);
  }
  if (document.activeElement !== volumeEl) {
    volumeEl.value = String(settings.volume);
    paintVolume(settings.volume);
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
}

function buildVoiceList(selected: string): void {
  voiceList.innerHTML = '';
  let lastGroup = '';
  for (const voice of MENU_VOICES) {
    if (voice.group !== lastGroup) {
      lastGroup = voice.group;
      const heading = document.createElement('div');
      heading.className = 'voice-group';
      heading.textContent = voice.group;
      voiceList.appendChild(heading);
    }

    const row = document.createElement('div');
    row.className = 'voice-option';
    row.dataset.value = voice.id;
    row.setAttribute('role', 'option');
    row.setAttribute(
      'aria-selected',
      voice.id === resolveVoice(selected) ? 'true' : 'false',
    );

    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'voice-select';
    select.dataset.value = voice.id;
    select.textContent = voice.label;
    select.setAttribute('aria-label', `Select ${voice.label}`);

    const preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'voice-preview';
    preview.dataset.value = voice.id;
    preview.dataset.previewState = 'idle';
    preview.innerHTML = ICON_PLAY;
    preview.setAttribute('aria-label', `Preview ${voice.label}`);
    preview.title = `Preview ${voice.label}`;

    row.append(select, preview);
    voiceList.appendChild(row);
  }
}

async function findActiveTab(): Promise<number | null> {
  try {
    const tabs = await browser.tabs.query({
      currentWindow: true,
    });
    const active = tabs.find(
      (tab) =>
        tab.active &&
        typeof tab.url === 'string' &&
        /^https:\/\/(?:x|twitter)\.com\//u.test(tab.url),
    );
    const xTab =
      active ??
      tabs
        .filter(
          (tab) =>
            typeof tab.url === 'string' &&
            /^https:\/\/(?:x|twitter)\.com\//u.test(tab.url),
        )
        .sort(
          (left, right) =>
            Number(right.lastAccessed ?? 0) -
            Number(left.lastAccessed ?? 0),
        )[0];
    return typeof xTab?.id === 'number' ? xTab.id : null;
  } catch {
    return null;
  }
}

async function sendToContent<T>(
  message: Record<string, unknown>,
): Promise<T | null> {
  if (activeTabId == null) return null;
  try {
    return (await browser.tabs.sendMessage(activeTabId, message)) as T;
  } catch {
    return null;
  }
}

voiceButton.addEventListener('click', () => setVoiceOpen(!voiceOpen));

voiceList.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const preview = target.closest<HTMLButtonElement>('.voice-preview');
  if (preview?.dataset.value) {
    const voice = preview.dataset.value;
    if (activePreviewVoice === voice && previewState !== 'idle') {
      activePreviewVoice = null;
      previewState = 'idle';
      paintPreviewButtons();
      void sendToContent({
        type: 'ttsx:preview-voice',
        voice: null,
      });
      return;
    }
    activePreviewVoice = voice;
    previewState = 'loading';
    paintPreviewButtons();
    void sendToContent<{ ok?: boolean }>({
      type: 'ttsx:preview-voice',
      voice,
    }).then((response) => {
      if (!response && activePreviewVoice === voice) {
        activePreviewVoice = null;
        previewState = 'idle';
        paintPreviewButtons();
      }
    });
    return;
  }

  const select = target.closest<HTMLButtonElement>('.voice-select');
  if (!select?.dataset.value) return;
  const voice = select.dataset.value;
  paintVoice(voice);
  setVoiceOpen(false);
  void saveSettings({ voice }).then(() =>
    sendToContent({
      type: 'ttsx:preview-voice',
      voice: null,
      preserveReading: true,
    }),
  );
  activePreviewVoice = null;
  previewState = 'idle';
  paintPreviewButtons();
});

speedEl.addEventListener('input', () => {
  const speed = Number(speedEl.value);
  paintSpeed(speed);
  void saveSettings({ speed });
});
volumeEl.addEventListener('input', () => {
  const volume = Number(volumeEl.value);
  paintVolume(volume);
  void saveSettings({ volume });
});
karaokeEl.addEventListener('change', () => {
  void saveSettings({ karaoke: karaokeEl.checked });
});

startFrom.addEventListener('click', () => {
  if (startFrom.disabled) return;
  startFrom.disabled = true;
  void sendToContent<{ ok?: boolean }>({
    type: 'ttsx:start-word-picker',
  }).finally(() => window.close());
});

const settings = await loadSettings();
buildVoiceList(settings.voice);
paintSettings(settings);
paintPreviewButtons();

const disposeQualityBinding = bindGenerationQualityRange(
  stepsEl,
  settings.steps,
  (steps) => {
    stepsVal.textContent = generationQualityLabel(steps);
    void saveSettings({ steps });
  },
);
const disposeRangeFills = [speedEl, volumeEl, stepsEl].map(bindRangeFill);
const removeSettingsListener = onSettingsChange(paintSettings);

activeTabId = await findActiveTab();
startFrom.disabled = activeTabId == null;

const previewMessageListener = (
  raw: unknown,
  sender: Browser.runtime.MessageSender,
): void => {
  if (sender.tab?.id !== activeTabId || !raw || typeof raw !== 'object') {
    return;
  }
  const message = raw as Record<string, unknown>;
  if (message.type !== 'ttsx:preview-state') return;
  const voice = typeof message.voice === 'string' ? message.voice : null;
  const state =
    message.state === 'loading' || message.state === 'playing'
      ? message.state
      : 'idle';
  activePreviewVoice = state === 'idle' ? null : voice;
  previewState = state;
  paintPreviewButtons();
};
browser.runtime.onMessage.addListener(previewMessageListener);

window.addEventListener(
  'pagehide',
  () => {
    if (activePreviewVoice) {
      void sendToContent({
        type: 'ttsx:preview-voice',
        voice: null,
      });
    }
    browser.runtime.onMessage.removeListener(previewMessageListener);
    removeSettingsListener();
    disposeQualityBinding();
    for (const dispose of disposeRangeFills) dispose();
    disposeSettings();
  },
  { once: true },
);
