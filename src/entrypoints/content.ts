/**
 * Content script — x.com / twitter.com only.
 * Tap speaker → play / pause / resume. Hold → settings.
 */
import '../ui/styles.css';
import { debugHandledFailure } from '../diagnostics';
import { cacheStats } from '../tts/cache';
import { engine } from '../tts/engine';
import { locateWords } from '../tts/karaokeCues';
import { normalizeTtsLanguage } from '../tts/languages';
import { armPrefetch, prefetchDebug, startPrefetch } from '../tts/prefetch';
import { prepareTextForSpeech } from '../tts/prepareText';
import {
  disposeSettings,
  getSettings,
  loadSettings,
  onSettingsChange,
  resolveVoice,
  saveSettings,
} from '../tts/settings';
import {
  isKaraokeActive,
  startKaraoke,
  stopKaraoke,
  updateKaraoke,
} from '../ui/karaokeHighlight';
import {
  closePopover,
  openSettingsPopover,
  registerReadingControls,
  registerVoicePreviewHandler,
  type VoicePreviewState,
} from '../ui/settingsPopover';
import {
  clearStaleSpeakerDom,
  extractFullTweetText,
  extractTweetText,
  registerPlayHandler,
  registerRemountHandler,
  setButtonState,
} from '../ui/speakerButton';
import { applyTheme, syncActionIconColor } from '../ui/theme';
import {
  startFeedWordPicker,
  startWordPicker,
  stopWordPicker,
} from '../ui/wordPicker';
import { startObserver, scheduleScan } from '../x/observer';

export default defineContentScript({
  matches: ['https://x.com/*', 'https://twitter.com/*'],
  runAt: 'document_idle',
  cssInjectionMode: 'manifest',
  async main(ctx) {
    ctx.onInvalidated(() => {
      engine.dispose();
      disposeSettings();
      closePopover();
      stopWordPicker();
      stopKaraoke();
      clearStaleSpeakerDom();
      delete (window as unknown as { __ttsx?: unknown }).__ttsx;
    });

    // Orphaned buttons from a prior inject have dead click handlers.
    clearStaleSpeakerDom();

    await loadSettings();
    if (ctx.isInvalid) return;
    applyTheme();

    const rootThemeObserver = new MutationObserver(() => applyTheme());
    rootThemeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'style', 'class'],
    });
    ctx.onInvalidated(() => rootThemeObserver.disconnect());

    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) {
      const metaThemeObserver = new MutationObserver(() => applyTheme());
      metaThemeObserver.observe(themeMeta, {
        attributes: true,
        attributeFilter: ['content'],
      });
      ctx.onInvalidated(() => metaThemeObserver.disconnect());
    }

    startPrefetch(ctx);
    startObserver(ctx);
    // Warm the model after the feed settles — immediate arm fights first paint.
    ctx.setTimeout(() => armPrefetch(), 2500);
    ctx.setTimeout(syncActionIconColor, 800);
    ctx.setTimeout(syncActionIconColor, 2500);

    interface ReadingRequest {
      article: HTMLElement;
      button: HTMLButtonElement;
      preparedText: string;
      words: string[];
      wordStarts: number[];
      language: string;
      startWord: number;
    }

    const PREVIEW_TEXT =
      'This is a preview of how this voice reads posts aloud.';

    let activeBtn: HTMLButtonElement | null = null;
    let activeArticle: HTMLElement | null = null;
    let currentReading: ReadingRequest | null = null;
    let playbackMode: 'reading' | 'preview' | null = null;
    let karaokeWords: string[] = [];
    let karaokeWordOffset = 0;
    let previewStateSink:
      | ((state: VoicePreviewState) => void)
      | null = null;
    let activePreviewVoiceId: string | null = null;
    let resumeReadingAfterPreview = false;

    function broadcastPreviewState(state: VoicePreviewState): void {
      const voice = activePreviewVoiceId;
      try {
        void browser.runtime
          .sendMessage({
            type: 'ttsx:preview-state',
            voice,
            state,
          })
          .catch(() => {
            /* toolbar popup is closed */
          });
      } catch {
        /* extension context is being invalidated */
      }
    }

    function publishPreviewState(state: VoicePreviewState): void {
      previewStateSink?.(state);
      broadcastPreviewState(state);
    }

    function languageForArticle(article: HTMLElement): string {
      return normalizeTtsLanguage(
        article
          .querySelector<HTMLElement>('[data-testid="tweetText"][lang]')
          ?.getAttribute('lang'),
      );
    }

    function makeReadingRequest(
      text: string,
      button: HTMLButtonElement,
      article: HTMLElement,
    ): ReadingRequest | null {
      const preparedText = prepareTextForSpeech(text);
      const positions = locateWords(preparedText);
      if (!preparedText || !positions.length) return null;
      return {
        article,
        button,
        preparedText,
        words: positions.map((position) => position.text),
        wordStarts: positions.map((position) => position.start),
        language: languageForArticle(article),
        startWord: 0,
      };
    }

    function clearActiveReadingUi(): void {
      stopKaraoke();
      setButtonState(activeBtn, 'idle');
      activeBtn = null;
      activeArticle = null;
      karaokeWords = [];
      karaokeWordOffset = 0;
    }

    function stopEngineBeforeModeChange(): void {
      playbackMode = null;
      if (activePreviewVoiceId) publishPreviewState('idle');
      previewStateSink = null;
      activePreviewVoiceId = null;
      engine.stop();
      clearActiveReadingUi();
    }

    function startReading(
      request: ReadingRequest,
      startWord = request.startWord,
    ): void {
      const lastWord = Math.max(0, request.words.length - 1);
      const selected = Math.max(0, Math.min(lastWord, Math.trunc(startWord)));
      const start = request.wordStarts[selected];
      if (start == null || !request.article.isConnected) return;

      stopEngineBeforeModeChange();
      resumeReadingAfterPreview = false;

      const liveButton =
        request.article.querySelector<HTMLButtonElement>(
          '.ttsx-speaker-btn',
        ) ?? request.button;
      request.button = liveButton;
      request.startWord = selected;
      currentReading = request;
      activeBtn = liveButton;
      activeArticle = request.article;
      playbackMode = 'reading';
      karaokeWords = request.words;
      karaokeWordOffset = selected;
      setButtonState(liveButton, 'loading', engine.isModelReady() ? 1 : 0);

      const spokenText = request.preparedText.slice(start);
      const voice = resolveVoice(getSettings());
      void engine
        .play(spokenText, {
          voice,
          language: request.language,
        })
        .catch((error) => {
          const message =
            error instanceof Error ? error.message : String(error);
          if (/cancelled/i.test(message)) return;
          debugHandledFailure('play failed', error);
          if (
            playbackMode !== 'reading' ||
            currentReading !== request
          ) {
            return;
          }
          stopKaraoke();
          const live =
            request.article.querySelector<HTMLButtonElement>(
              '.ttsx-speaker-btn',
            ) ?? request.button;
          setButtonState(live, 'idle');
          activeBtn = null;
          activeArticle = null;
          playbackMode = null;
        });
    }

    /**
     * X keeps the same document alive while moving between feed, post, and
     * history entries. Treat those transitions like a real page unload:
     * invalidate pending synthesis, stop media, clear karaoke, and restore the
     * old post's button before X detaches it.
     */
    function stopActivePlayback(options?: {
      forgetReading?: boolean;
      closeSettings?: boolean;
    }): void {
      const forgetReading = options?.forgetReading ?? true;
      const closeSettings = options?.closeSettings ?? true;
      stopEngineBeforeModeChange();
      resumeReadingAfterPreview = false;
      if (forgetReading) currentReading = null;
      if (closeSettings) closePopover();
    }

    ctx.addEventListener(window, 'wxt:locationchange', () => {
      stopWordPicker();
      stopActivePlayback();
    });
    ctx.addEventListener(window, 'pagehide', () => {
      stopWordPicker();
      stopActivePlayback();
    });
    ctx.addEventListener(
      document,
      'click',
      (event) => {
        if (!activeArticle) return;
        const target = event.target;
        if (!(target instanceof Element) || !activeArticle.contains(target)) {
          return;
        }
        // Post actions do not navigate. The speaker has its own playback
        // gesture, so never let this capture listener cancel that gesture.
        if (
          target.closest(
            '.ttsx-action, .ttsx-popover, button, input, textarea, select, [role="button"], [contenteditable="true"]',
          )
        ) {
          return;
        }
        stopActivePlayback();
      },
      { capture: true },
    );

    function paintKaraoke(state = engine.getState()): void {
      if (
        (state.status === 'playing' || state.status === 'paused') &&
        state.caption &&
        activeArticle &&
        getSettings().karaoke
      ) {
        if (!isKaraokeActive() && karaokeWords.length) {
          startKaraoke(activeArticle, karaokeWords);
        }
        updateKaraoke(
          state.caption.wordIndex == null
            ? null
            : state.caption.wordIndex + karaokeWordOffset,
        );
      } else if (state.status === 'idle' || state.status === 'error') {
        stopKaraoke();
      }
    }

    const removeKaraokeSettingsListener = onSettingsChange(
      (settings, previous) => {
        if (!settings.karaoke) stopKaraoke();
        else paintKaraoke();

        if (
          settings.voice !== previous.voice &&
          currentReading?.article.isConnected &&
          (playbackMode === 'reading' || resumeReadingAfterPreview)
        ) {
          startReading(currentReading, currentReading.startWord);
        }
      },
    );
    ctx.onInvalidated(removeKaraokeSettingsListener);

    const removeKaraokeListener = engine.onKaraoke((wordIndex) => {
      if (
        wordIndex != null &&
        activeArticle &&
        getSettings().karaoke &&
        !isKaraokeActive() &&
        karaokeWords.length
      ) {
        startKaraoke(activeArticle, karaokeWords);
      }
      updateKaraoke(
        wordIndex == null ? null : wordIndex + karaokeWordOffset,
      );
    });
    ctx.onInvalidated(removeKaraokeListener);

    function paintActive(): void {
      if (!activeBtn) return;
      const s = engine.getState();
      if (s.status === 'loading') setButtonState(activeBtn, 'loading', s.progress);
      else if (s.status === 'playing')
        setButtonState(activeBtn, 'playing', s.progress);
      else if (s.status === 'paused')
        setButtonState(activeBtn, 'paused', s.progress);
      else setButtonState(activeBtn, 'idle');
    }

    const removeStateListener = engine.onState((state) => {
      if (playbackMode === 'preview') {
        if (state.status === 'loading') publishPreviewState('loading');
        else if (state.status === 'playing' || state.status === 'paused') {
          publishPreviewState('playing');
        } else if (state.status === 'idle' || state.status === 'error') {
          publishPreviewState('idle');
          previewStateSink = null;
          activePreviewVoiceId = null;
          playbackMode = null;
        }
        if (state.status === 'error') {
          debugHandledFailure('voice preview failed', state.message);
        }
        return;
      }

      paintKaraoke(state);
      if (playbackMode !== 'reading' || !activeBtn) return;
      if (state.status === 'loading') {
        setButtonState(activeBtn, 'loading', state.progress);
      } else if (state.status === 'playing') {
        setButtonState(activeBtn, 'playing', state.progress);
      } else if (state.status === 'paused') {
        setButtonState(activeBtn, 'paused', state.progress);
      } else if (state.status === 'error') {
        setButtonState(activeBtn, 'idle');
        debugHandledFailure('engine error', state.message);
        activeBtn = null;
        activeArticle = null;
        playbackMode = null;
      } else if (state.status === 'idle') {
        setButtonState(activeBtn, 'idle');
        activeBtn = null;
        activeArticle = null;
        playbackMode = null;
      }
    });
    ctx.onInvalidated(removeStateListener);

    // Status pages re-render the hero action bar — reattach the live button.
    registerRemountHandler((button, article) => {
      if (currentReading?.article === article) {
        currentReading.button = button;
      }
      if (activeArticle === article) {
        activeBtn = button;
        paintActive();
      }
    });

    registerPlayHandler((text, button, article) => {
      const status = engine.getState().status;
      const samePost =
        playbackMode === 'reading' && activeArticle === article;

      if (samePost && status === 'playing') {
        engine.pause();
        return;
      }
      if (samePost && status === 'paused') {
        void engine.resume();
        return;
      }
      // Second tap while *initial* voice load cancels. (Buffer gaps between
      // chunks stay in "playing", so they pause instead of aborting.)
      if (samePost && status === 'loading') {
        stopActivePlayback({
          forgetReading: false,
          closeSettings: false,
        });
        return;
      }

      if (
        status === 'playing' ||
        status === 'paused' ||
        status === 'loading'
      ) {
        stopActivePlayback({
          forgetReading: true,
          closeSettings: false,
        });
      }

      const request = makeReadingRequest(text, button, article);
      if (request) startReading(request, 0);
    });

    function handleVoicePreview(
      voice: string | null,
      onState: (state: VoicePreviewState) => void,
      preserveReading = false,
    ): void {
      if (!voice) {
        if (!preserveReading) resumeReadingAfterPreview = false;
        if (playbackMode === 'preview') {
          playbackMode = null;
          publishPreviewState('idle');
          previewStateSink = null;
          activePreviewVoiceId = null;
          engine.stop();
        }
        return;
      }

      resumeReadingAfterPreview =
        resumeReadingAfterPreview ||
        (playbackMode === 'reading' &&
          currentReading != null &&
          (engine.getState().status === 'loading' ||
            engine.getState().status === 'playing' ||
            engine.getState().status === 'paused'));
      stopEngineBeforeModeChange();
      playbackMode = 'preview';
      previewStateSink = onState;
      activePreviewVoiceId = voice;
      publishPreviewState('loading');
      void engine
        .play(PREVIEW_TEXT, {
          voice,
          language: 'en',
        })
        .catch((error) => {
          const message =
            error instanceof Error ? error.message : String(error);
          if (/cancelled/i.test(message)) return;
          debugHandledFailure('voice preview failed', error);
          if (playbackMode === 'preview') {
            publishPreviewState('idle');
            previewStateSink = null;
            activePreviewVoiceId = null;
            playbackMode = null;
          }
        });
    }

    registerVoicePreviewHandler(handleVoicePreview);

    function readingRequestForPicker(
      article: HTMLElement,
      fallbackButton?: HTMLButtonElement,
    ): ReadingRequest | null {
      const liveButton =
        article.querySelector<HTMLButtonElement>('.ttsx-speaker-btn') ??
        fallbackButton ??
        null;
      if (!liveButton) return null;
      // Always snapshot the current rendered surface. Translators, grammar
      // tools, and X itself can replace text nodes without replacing article.
      return makeReadingRequest(extractTweetText(article), liveButton, article);
    }

    function playFromPickedWord(
      article: HTMLElement,
      pickerRequest: ReadingRequest,
      wordIndex: number,
    ): void {
      void (async () => {
        const liveButton =
          article.querySelector<HTMLButtonElement>('.ttsx-speaker-btn') ??
          pickerRequest.button;
        try {
          const needsExpand =
            article.querySelector(
              '[data-testid="tweet-text-show-more-link"]',
            ) !== null;
          if (needsExpand) setButtonState(liveButton, 'loading', 0);
          const text = needsExpand
            ? await extractFullTweetText(article)
            : pickerRequest.preparedText;
          const readingRequest = needsExpand
            ? makeReadingRequest(
                text,
                article.querySelector<HTMLButtonElement>(
                  '.ttsx-speaker-btn',
                ) ?? liveButton,
                article,
              )
            : pickerRequest;
          if (!readingRequest) {
            setButtonState(liveButton, 'idle');
            return;
          }
          startReading(readingRequest, wordIndex);
        } catch (error) {
          setButtonState(liveButton, 'idle');
          debugHandledFailure('could not start from selected word', error);
        }
      })();
    }

    async function startWordPickerForArticle(
      article: HTMLElement,
      fallbackButton?: HTMLButtonElement,
    ): Promise<boolean> {
      const pickerRequest = readingRequestForPicker(article, fallbackButton);
      if (!pickerRequest) return false;
      return startWordPicker(
        article,
        () => readingRequestForPicker(article, fallbackButton)?.words ?? null,
        (wordIndex) => {
          const currentRequest = readingRequestForPicker(
            article,
            fallbackButton,
          );
          if (currentRequest) {
            playFromPickedWord(article, currentRequest, wordIndex);
          }
        },
      );
    }

    function startPersistentFeedPicker(): void {
      startFeedWordPicker(
        (article) => readingRequestForPicker(article)?.words ?? null,
        (article, wordIndex) => {
          const pickerRequest = readingRequestForPicker(article);
          if (!pickerRequest) return;
          playFromPickedWord(article, pickerRequest, wordIndex);
        },
      );
    }

    registerReadingControls({
      async startFrom(anchor) {
        const article = anchor.closest<HTMLElement>(
          'article[data-testid="tweet"], article',
        );
        if (!article) return false;
        return startWordPickerForArticle(
          article,
          anchor instanceof HTMLButtonElement ? anchor : undefined,
        );
      },
    });

    const toolbarMessageListener = (
      raw: unknown,
    ): Promise<unknown> | unknown => {
      if (!raw || typeof raw !== 'object') return undefined;
      const message = raw as Record<string, unknown>;
      if (message.type === 'ttsx:preview-voice') {
        const voice =
          typeof message.voice === 'string' ? message.voice : null;
        handleVoicePreview(voice, () => {}, message.preserveReading === true);
        return Promise.resolve({ ok: true });
      }
      if (message.type === 'ttsx:start-word-picker') {
        startPersistentFeedPicker();
        return Promise.resolve({ ok: true });
      }
      return undefined;
    };
    browser.runtime.onMessage.addListener(toolbarMessageListener);
    ctx.onInvalidated(() => {
      browser.runtime.onMessage.removeListener(toolbarMessageListener);
    });

    ctx.setTimeout(scheduleScan, 1500);

    Object.assign(window, {
      __ttsx: {
        engine,
        play: (t: string) => engine.play(t),
        pause: () => engine.pause(),
        resume: () => engine.resume(),
        stop: () => engine.stop(),
        cacheStats,
        prefetchDebug,
        getSettings,
        saveSettings,
        openSettings: (el?: HTMLElement) =>
          openSettingsPopover(
            el ??
              document.querySelector<HTMLElement>('.ttsx-speaker-btn') ??
              document.body,
          ),
      },
    });
  },
});
