/**
 * Per-tweet Read aloud control.
 *  - Tap  → play / pause / resume
 *  - Hold → settings (voice, speed, volume)
 * Placement:
 *  - Home / status posts with Grok + ⋯: top-right — speaker · Grok · ⋯
 *  - Compact replies (no Grok): action bar left of bookmark
 */
import { debugHandledFailure } from '../diagnostics';
import { hasSpeakableText } from '../tts/prepareText';
import { MARKED_ATTR, SELECTORS } from '../x/selectors';
import { readingTextRoots } from '../x/textRoot';
import { closePopover, openSettingsPopover } from './settingsPopover';
import { paintTtsxRoot, syncActionIconAppearance } from './theme';

const HOLD_MS = 420;

export interface SpeakerPressGesture {
  held: boolean;
  played: boolean;
  suppressClick: boolean;
}

export function createSpeakerPressGesture(): SpeakerPressGesture {
  return { held: false, played: false, suppressClick: false };
}

export function beginSpeakerPressGesture(state: SpeakerPressGesture): void {
  state.held = false;
  state.played = false;
  state.suppressClick = false;
}

export function markSpeakerHold(state: SpeakerPressGesture): void {
  state.held = true;
  state.played = true;
  state.suppressClick = true;
}

export function finishSpeakerPointer(state: SpeakerPressGesture): boolean {
  const shouldPlay = !state.held && !state.played;
  state.held = false;
  if (shouldPlay) {
    state.played = true;
    state.suppressClick = true;
  }
  return shouldPlay;
}

export function consumeSpeakerClick(state: SpeakerPressGesture): boolean {
  if (state.suppressClick) {
    state.suppressClick = false;
    state.played = false;
    return false;
  }
  if (state.held || state.played) return false;
  state.played = true;
  return true;
}

const ICON_SPEAKER = `
<svg viewBox="0 0 24 24" aria-hidden="true" class="ttsx-icon">
  <path d="M11 5 6 9H2v6h4l5 4V5z"/>
  <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
  <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
</svg>`;

const ICON_PAUSE = `
<svg viewBox="0 0 24 24" aria-hidden="true" class="ttsx-icon">
  <rect x="6" y="5" width="4" height="14" rx="1"/>
  <rect x="14" y="5" width="4" height="14" rx="1"/>
</svg>`;

const ICON_PLAY = `
<svg viewBox="0 0 24 24" aria-hidden="true" class="ttsx-icon">
  <path d="M8 5v14l11-7z"/>
</svg>`;

const ICON_LOADING = `
<svg viewBox="0 0 24 24" aria-hidden="true" class="ttsx-icon ttsx-loading-spinner">
  <circle cx="12" cy="12" r="8"/>
</svg>`;

let playHandler:
  | ((text: string, button: HTMLButtonElement, article: HTMLElement) => void)
  | null = null;

let remountHandler:
  | ((button: HTMLButtonElement, article: HTMLElement) => void)
  | null = null;

/** Buttons wired in this content-script world (dies on reload — DOM may not). */
const wiredButtons = new WeakSet<HTMLButtonElement>();

export function registerPlayHandler(
  fn: (text: string, button: HTMLButtonElement, article: HTMLElement) => void,
): void {
  playHandler = fn;
}

export function registerRemountHandler(
  fn: (button: HTMLButtonElement, article: HTMLElement) => void,
): void {
  remountHandler = fn;
}

/**
 * Drop speaker DOM left by a previous content-script instance (extension
 * reload / HMR). Orphaned nodes keep MARKED_ATTR but have dead listeners —
 * clicks then do nothing until we remount.
 */
export function clearStaleSpeakerDom(): void {
  for (const el of document.querySelectorAll('.ttsx-action, .ttsx-hold-hint, .ttsx-popover')) {
    el.remove();
  }
  for (const el of document.querySelectorAll(`[${MARKED_ATTR}]`)) {
    el.removeAttribute(MARKED_ATTR);
  }
}

function findActionBar(article: HTMLElement): HTMLElement | null {
  const reply = article.querySelector<HTMLElement>(SELECTORS.replyButton);
  return (
    reply?.closest<HTMLElement>(SELECTORS.actionBarGroup) ??
    article.querySelector<HTMLElement>(SELECTORS.actionBarGroup)
  );
}

/**
 * Top-right row with Grok + ⋯ (home timeline + status hero).
 * Must be a tight actions-only row — never a parent that also owns the
 * display name or tweet body (inserting there blows vertical spacing).
 */
function findGrokButton(article: HTMLElement): HTMLElement | null {
  for (const el of article.querySelectorAll<HTMLElement>('a, button, div[role="button"]')) {
    const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('href') || ''}`;
    if (/grok/i.test(label)) return el;
  }
  return null;
}

function findGrokCaretRow(
  article: HTMLElement,
): { row: HTMLElement; grokCell: Element } | null {
  const caret = article.querySelector('[data-testid="caret"]');
  if (!caret) return null;

  const grokEl = findGrokButton(article);
  if (!grokEl) return null;

  let cur: HTMLElement | null = caret.parentElement;
  let best: { row: HTMLElement; grokCell: Element } | null = null;
  for (let i = 0; i < 8 && cur && cur !== article; i++) {
    if (cur.contains(grokEl) && cur.contains(caret) && cur.children.length >= 2) {
      // Reject rows that participate in the author/body column.
      if (
        cur.querySelector('[data-testid="User-Name"]') ||
        cur.querySelector('[data-testid="tweetText"]')
      ) {
        cur = cur.parentElement;
        continue;
      }
      const grokCell = barCellFor(cur, grokEl);
      if (grokCell) {
        // Prefer the shallowest (tightest) safe row.
        best = { row: cur, grokCell };
        break;
      }
    }
    cur = cur.parentElement;
  }
  return best;
}

const SHOW_MORE = '[data-testid="tweet-text-show-more-link"]';

/** Read the rendered surface so speech and Start from see identical words. */
export function readPrimaryTweetText(
  node: Pick<HTMLElement, 'innerText' | 'textContent'>,
): string {
  return (node.innerText ?? node.textContent ?? '').trim();
}

/** Ordered text nodes shared by speech extraction and karaoke rendering. */
function primaryTweetTextNodes(article: HTMLElement): HTMLElement[] {
  return readingTextRoots(article);
}

function showMoreControl(article: HTMLElement): HTMLElement | null {
  return article.querySelector<HTMLElement>(SHOW_MORE);
}

/**
 * X keeps the tail of long posts out of the DOM until "Show more" is
 * clicked (label is localized — Mehr anzeigen, Show more, もっと見る, …).
 * Click the stable testid and wait for the body to grow.
 */
export async function expandTweetText(article: HTMLElement): Promise<void> {
  const btn = showMoreControl(article);
  if (!btn || !article.isConnected) return;

  const before = primaryTweetTextNodes(article).reduce(
    (length, node) => length + (node.textContent?.length ?? 0),
    0,
  );

  try {
    btn.click();
  } catch {
    return;
  }

  for (let i = 0; i < 24; i++) {
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    if (!article.isConnected) return;
    const still = showMoreControl(article);
    const after = primaryTweetTextNodes(article).reduce(
      (length, node) => length + (node.textContent?.length ?? 0),
      0,
    );
    if (!still || after > before + 8) {
      await new Promise((r) => setTimeout(r, 50));
      return;
    }
  }
}

/** Drop whatever localized label the show-more control currently has. */
function stripShowMoreLabel(article: HTMLElement, text: string): string {
  const btn = showMoreControl(article);
  const label = (btn?.innerText ?? btn?.textContent ?? '').trim();
  if (!label) return text;
  if (text.endsWith(label)) return text.slice(0, -label.length).trim();
  return text.split(label).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Visible (or already-expanded) body text for this article only.
 * Call {@link expandTweetText} first when you need the full long post.
 */
export function extractTweetText(article: HTMLElement): string {
  const roots = primaryTweetTextNodes(article);
  const sections: string[] = [];

  // Hidden continuation spans (when X keeps them in the primary node).
  for (const root of roots) {
    let section = readPrimaryTweetText(root);
    for (const h of root.querySelectorAll<HTMLElement>(
      'span[aria-hidden="true"]',
    )) {
      const t = (h.innerText ?? h.textContent ?? '').trim();
      if (t && !section.includes(t)) section = `${section} ${t}`.trim();
    }
    if (section) sections.push(section);
  }

  let text = sections.join('\n');
  text = stripShowMoreLabel(article, text);
  return text.replace(/\s+\n/g, '\n').trim();
}

/** Expand truncated posts, then return the full body. */
export async function extractFullTweetText(
  article: HTMLElement,
): Promise<string> {
  await expandTweetText(article);
  return extractTweetText(article);
}

function createActionCell(kind: 'bar' | 'header'): {
  cell: HTMLDivElement;
  button: HTMLButtonElement;
} {
  const cell = document.createElement('div');
  cell.className =
    kind === 'header' ? 'ttsx-action ttsx-action--header' : 'ttsx-action';
  cell.setAttribute('data-ttsx', 'action');
  paintTtsxRoot(cell);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ttsx-speaker-btn';
  button.setAttribute('aria-label', 'Read aloud');
  button.setAttribute('title', 'Read aloud · hold for settings');
  button.dataset.ttsxState = 'idle';
  button.innerHTML = `<div class="ttsx-hit">${ICON_SPEAKER}</div>`;

  cell.appendChild(button);
  return { cell, button };
}

function liveSpeakerButton(
  article: HTMLElement,
  fallback: HTMLButtonElement,
): HTMLButtonElement {
  // Show-more expand often rebuilds the article — prefer the live node.
  return (
    article.querySelector<HTMLButtonElement>('.ttsx-speaker-btn') ?? fallback
  );
}

function firePlay(button: HTMLButtonElement, article: HTMLElement): void {
  if (article.dataset.ttsxArming === '1') return;
  article.dataset.ttsxArming = '1';

  void (async () => {
    try {
      const needsExpand = !!showMoreControl(article);
      if (needsExpand) setButtonState(button, 'loading', 0);

      const text = await extractFullTweetText(article);
      // Expand mutates X's DOM — remount so we don't bind a detached button.
      mountSpeakerButton(article);
      const live = liveSpeakerButton(article, button);

      if (!text || !playHandler) {
        setButtonState(live, 'idle');
        return;
      }
      playHandler(text, live, article);
    } catch (error) {
      const live = liveSpeakerButton(article, button);
      setButtonState(live, 'idle');
      debugHandledFailure('could not read post text', error);
    } finally {
      delete article.dataset.ttsxArming;
    }
  })();
}

function wirePress(
  button: HTMLButtonElement,
  article: HTMLElement,
): void {
  if (wiredButtons.has(button)) return;
  wiredButtons.add(button);

  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  const gesture = createSpeakerPressGesture();
  let startX = 0;
  let startY = 0;

  const clearHold = () => {
    if (holdTimer != null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  };

  const onDown = (e: PointerEvent) => {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    beginSpeakerPressGesture(gesture);
    startX = e.clientX;
    startY = e.clientY;
    button.setPointerCapture?.(e.pointerId);
    holdTimer = setTimeout(() => {
      markSpeakerHold(gesture);
      button.classList.add('ttsx-holding');
      void openSettingsPopover(button);
    }, HOLD_MS);
  };

  const onMove = (e: PointerEvent) => {
    if (holdTimer == null) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (dx * dx + dy * dy > 36) clearHold();
  };

  const onUp = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    button.classList.remove('ttsx-holding');
    clearHold();
    try {
      button.releasePointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    if (!finishSpeakerPointer(gesture)) return;
    firePlay(button, article);
  };

  const onCancel = () => {
    clearHold();
    gesture.held = false;
    button.classList.remove('ttsx-holding');
  };

  button.addEventListener('pointerdown', onDown, true);
  button.addEventListener('pointermove', onMove, true);
  button.addEventListener('pointerup', onUp, true);
  button.addEventListener('pointercancel', onCancel, true);
  // Fallback when pointerup is swallowed (some Chromium builds / capture quirks).
  button.addEventListener(
    'click',
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (!consumeSpeakerClick(gesture)) return;
      clearHold();
      firePlay(button, article);
    },
    true,
  );
  button.addEventListener(
    'contextmenu',
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      void openSettingsPopover(button);
    },
    true,
  );
}

function barCellFor(bar: HTMLElement, el: Element | null): Element | null {
  if (!el) return null;
  let cur: Element | null = el;
  while (cur && cur.parentElement !== bar) cur = cur.parentElement;
  return cur?.parentElement === bar ? cur : null;
}

/**
 * Copy sibling margins for timeline rhythm, but NEVER grow like status-page
 * bookmark cells (flex:1) — that made our speaker ~100px wide.
 */
function syncCellLayout(cell: HTMLElement, sibling: Element): void {
  const cs = getComputedStyle(sibling);
  syncActionIconAppearance(cell, sibling);
  cell.style.flex = '0 0 auto';
  cell.style.flexGrow = '0';
  cell.style.flexShrink = '0';
  cell.style.flexBasis = 'auto';
  cell.style.marginLeft = cs.marginLeft;
  cell.style.marginRight = cs.marginRight;
  cell.style.minWidth = '0';
  cell.style.justifyContent = 'center';
  cell.style.alignItems = 'center';
  cell.style.width = 'auto';
}

/** Header icons sit in a flex row with gap — match Grok cell, no extra margin. */
function syncHeaderCell(cell: HTMLElement, grokCell: Element): void {
  syncCellLayout(cell, grokCell);
  cell.style.flex = '0 0 auto';
  cell.style.flexGrow = '0';
  cell.style.flexShrink = '0';
  cell.style.marginLeft = '0';
  cell.style.marginRight = '0';
  cell.style.minWidth = '0';
  cell.style.width = 'auto';
}

function clearSpeaker(article: HTMLElement): void {
  article.querySelector('.ttsx-action')?.remove();
  article.removeAttribute(MARKED_ATTR);
}

function mountInActionBar(article: HTMLElement): HTMLButtonElement | null {
  const bar = findActionBar(article);
  if (!bar) return null;

  const { cell, button } = createActionCell('bar');
  wirePress(button, article);

  const bookmark = bar.querySelector('[data-testid="bookmark"]');
  const bookmarkCell = barCellFor(bar, bookmark);
  if (bookmarkCell) {
    syncCellLayout(cell, bookmarkCell);
    bar.insertBefore(cell, bookmarkCell);
  } else {
    const share =
      bar.querySelector('[aria-label="Share post"]') ||
      bar.querySelector('[data-testid="share"]');
    const shareCell = barCellFor(bar, share) ?? bar.lastElementChild;
    if (shareCell) {
      syncCellLayout(cell, shareCell);
      bar.insertBefore(cell, shareCell);
    } else {
      bar.appendChild(cell);
    }
  }
  return button;
}

/**
 * Placement rules:
 *  - Home / status posts that expose Grok + ⋯ → always beside Grok (header).
 *  - Nested replies / compact posts with no Grok → action bar beside bookmark.
 * Re-check on every mount: Grok often appears after the first paint, and an
 * early bar mount must move up once the header row exists.
 */
export function mountSpeakerButton(article: HTMLElement): void {
  // Media / emoji / URL-only posts — no speaker (nothing useful to read).
  // Truncated posts still count: show-more expands on play.
  if (!hasSpeakableText(extractTweetText(article))) {
    clearSpeaker(article);
    return;
  }

  const header = findGrokCaretRow(article);
  const wantHeader = !!header;
  const existing = article.querySelector<HTMLElement>('.ttsx-action');
  const btn = existing?.querySelector<HTMLButtonElement>('.ttsx-speaker-btn');
  const isHeader = !!existing?.classList.contains('ttsx-action--header');
  const correctSlot = !!existing && wantHeader === isHeader && existing.isConnected;

  // Hot path: already in the right slot + wired — skip layout work.
  if (
    correctSlot &&
    btn &&
    article.hasAttribute(MARKED_ATTR) &&
    wiredButtons.has(btn)
  ) {
    return;
  }

  // Same slot but needs a light rebind / re-seat next to Grok.
  if (correctSlot && existing && article.hasAttribute(MARKED_ATTR)) {
    paintTtsxRoot(existing);
    if (header && isHeader) {
      syncHeaderCell(existing, header.grokCell);
      if (
        existing.parentElement !== header.row ||
        existing.nextElementSibling !== header.grokCell
      ) {
        header.row.insertBefore(existing, header.grokCell);
      }
    } else if (!header) {
      const bar = findActionBar(article);
      const bookmark = bar?.querySelector('[data-testid="bookmark"]');
      const bookmarkCell = bar && bookmark ? barCellFor(bar, bookmark) : null;
      if (bookmarkCell) {
        syncCellLayout(existing, bookmarkCell);
        if (existing.parentElement !== bar || existing.nextElementSibling !== bookmarkCell) {
          bar!.insertBefore(existing, bookmarkCell);
        }
      }
    }
    const liveBtn =
      existing.querySelector<HTMLButtonElement>('.ttsx-speaker-btn');
    if (liveBtn) {
      wirePress(liveBtn, article);
      remountHandler?.(liveBtn, article);
    }
    return;
  }

  // Wrong slot (Grok appeared/disappeared) or wiped — rebuild.
  existing?.remove();
  article.removeAttribute(MARKED_ATTR);

  // Prefer header whenever Grok + ⋯ exist — never fall back to the action bar
  // just because of a transient layout gap (that caused the flip-flop on Home).
  if (header) {
    const { cell, button } = createActionCell('header');
    wirePress(button, article);
    syncHeaderCell(cell, header.grokCell);
    header.row.insertBefore(cell, header.grokCell);
    article.setAttribute(MARKED_ATTR, '1');
    remountHandler?.(button, article);
    maybeShowHoldHint(button);
    return;
  }

  const button = mountInActionBar(article);
  if (!button) return;
  article.setAttribute(MARKED_ATTR, '1');
  remountHandler?.(button, article);
  maybeShowHoldHint(button);
}

export type ButtonState = 'idle' | 'loading' | 'playing' | 'paused';

const RING = 56.5; // 2πr for r=9

function progressRing(progress: number, inner: string): string {
  const pct = Math.max(0, Math.min(1, progress));
  const dash = pct * RING;
  return `
    <svg viewBox="0 0 24 24" class="ttsx-icon ttsx-progress" aria-hidden="true">
      <circle cx="12" cy="12" r="9" class="ttsx-spinner-track"/>
      <circle cx="12" cy="12" r="9" class="ttsx-spinner-head"
        stroke-dasharray="${dash} ${RING}"/>
    </svg>
    <span class="ttsx-progress-icon">${inner}</span>`;
}

export function setButtonState(
  btn: HTMLButtonElement | null,
  state: ButtonState,
  progress?: number,
): void {
  if (!btn?.dataset) return;
  const prev = btn.dataset.ttsxState;
  const prevProg = btn.dataset.ttsxProgress;
  const prog = progress ?? 0;
  // Avoid thrashing SVG when only progress ticks during play.
  if (
    prev === state &&
    (state === 'playing' || state === 'paused') &&
    prevProg != null &&
    Math.abs(Number(prevProg) - prog) < 0.02 &&
    btn.querySelector('.ttsx-progress')
  ) {
    const head = btn.querySelector<SVGCircleElement>('.ttsx-spinner-head');
    if (head) {
      head.setAttribute(
        'stroke-dasharray',
        `${Math.max(0, Math.min(1, prog)) * RING} ${RING}`,
      );
      btn.dataset.ttsxProgress = String(prog);
      return;
    }
  }

  btn.dataset.ttsxState = state;
  btn.dataset.ttsxProgress = String(prog);
  const hit = btn.querySelector('.ttsx-hit');
  if (!hit) return;

  if (state === 'playing') {
    btn.setAttribute('aria-label', 'Pause');
    btn.setAttribute('title', 'Pause · hold for settings');
    hit.innerHTML = progressRing(prog, ICON_PAUSE);
  } else if (state === 'paused') {
    btn.setAttribute('aria-label', 'Resume');
    btn.setAttribute('title', 'Resume · hold for settings');
    hit.innerHTML = progressRing(prog, ICON_PLAY);
  } else if (state === 'loading') {
    btn.setAttribute('aria-label', 'Loading voice…');
    btn.setAttribute('title', 'Loading voice…');
    hit.innerHTML = ICON_LOADING;
  } else {
    btn.setAttribute('aria-label', 'Read aloud');
    btn.setAttribute('title', 'Read aloud · hold for settings');
    hit.innerHTML = ICON_SPEAKER;
  }
}

const HINT_KEY = 'ttsx.holdHint';

/** One-time tip near the first mounted speaker: hold opens settings. */
export function maybeShowHoldHint(anchor: HTMLElement): void {
  try {
    if (localStorage.getItem(HINT_KEY)) return;
    localStorage.setItem(HINT_KEY, '1');
  } catch {
    return;
  }
  const tip = document.createElement('div');
  tip.className = 'ttsx-hold-hint';
  tip.textContent = 'Hold for settings';
  tip.setAttribute('role', 'status');
  paintTtsxRoot(tip);
  document.documentElement.appendChild(tip);
  const aRect = anchor.getBoundingClientRect();
  tip.style.left = `${Math.round(aRect.left + aRect.width / 2)}px`;
  tip.style.top = `${Math.round(aRect.top - 8)}px`;
  requestAnimationFrame(() => tip.classList.add('ttsx-hold-hint--in'));
  window.setTimeout(() => {
    tip.classList.remove('ttsx-hold-hint--in');
    tip.classList.add('ttsx-hold-hint--out');
    window.setTimeout(() => tip.remove(), 220);
  }, 2800);
}

export { closePopover };
