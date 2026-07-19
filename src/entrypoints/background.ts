/**
 * Port bus: content script ↔ offscreen TTS document.
 * Offscreen cannot talk to content scripts directly.
 */
import type { TtsWorkerHost } from '../tts/workerHost';
import { debugHandledFailure } from '../diagnostics';

export default defineBackground(() => {
  type Pipe = {
    content?: ReturnType<typeof browser.runtime.connect>;
  };

  /** sessionId → content port (the worker backend is shared). */
  const sessions = new Map<string, Pipe>();
  let offscreenPort: ReturnType<typeof browser.runtime.connect> | null = null;
  let backgroundHost: TtsWorkerHost | null = null;
  let creating: Promise<void> | null = null;

  function postToContent(
    port: ReturnType<typeof browser.runtime.connect> | undefined,
    message: unknown,
  ): void {
    try {
      port?.postMessage(message);
    } catch {
      /* dead content port */
    }
  }

  function routeBackendMessage(raw: unknown): void {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const message = raw as Record<string, unknown>;
    const sid = typeof message.sid === 'string' ? message.sid : '';
    if (sid) {
      postToContent(sessions.get(sid)?.content, message);
      return;
    }
    for (const pipe of sessions.values()) {
      postToContent(pipe.content, message);
    }
  }

  function backendAvailable(): boolean {
    return !!offscreenPort || !!backgroundHost;
  }

  /** Firefox MV2 has a background page with Worker, but no offscreen API. */
  async function ensureBackgroundHost(): Promise<boolean> {
    if (backgroundHost) return true;
    if (
      import.meta.env.BROWSER !== 'firefox' ||
      typeof Worker === 'undefined'
    ) {
      return false;
    }
    try {
      const { TtsWorkerHost } = await import('../tts/workerHost');
      backgroundHost = new TtsWorkerHost(routeBackendMessage);
      backgroundHost.preload();
      for (const pipe of sessions.values()) {
        postToContent(pipe.content, { type: 'offscreen-ready' });
      }
      return true;
    } catch (error) {
      backgroundHost = null;
      debugHandledFailure('Firefox background worker failed', error);
      return false;
    }
  }

  /** Create offscreen + start model download without waiting for a page. */
  function warmOffscreen(): void {
    void ensureOffscreen().catch((error) => {
      debugHandledFailure('offscreen warm failed', error);
    });
  }

  function sessionPipe(sid: string): Pipe {
    let p = sessions.get(sid);
    if (!p) {
      p = {};
      sessions.set(sid, p);
    }
    return p;
  }

  async function ensureOffscreen(): Promise<boolean> {
    const api = (
      browser as unknown as {
        offscreen?: {
          createDocument: (o: {
            url: string;
            reasons: string[];
            justification: string;
          }) => Promise<void>;
          closeDocument?: () => Promise<void>;
        };
      }
    ).offscreen;
    if (!api?.createDocument) return ensureBackgroundHost();
    if (offscreenPort) return true;

    let hasDoc = false;
    try {
      const contexts = await (
        browser.runtime as unknown as {
          getContexts?: (f: { contextTypes: string[] }) => Promise<unknown[]>;
        }
      ).getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      hasDoc = !!(contexts && contexts.length > 0);
    } catch {
      /* ignore */
    }

    // Document exists but the port died (common after extension reload) —
    // close and recreate so content isn't stuck waiting for offscreen-ready.
    if (hasDoc && !offscreenPort && api.closeDocument) {
      try {
        await api.closeDocument();
      } catch {
        /* ignore */
      }
      hasDoc = false;
    }

    if (hasDoc && offscreenPort) return true;

    if (creating) {
      await creating;
      return backendAvailable() || hasDoc;
    }

    creating = api
      .createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: 'Run Supertonic 3 WebGPU TTS off the page thread',
      })
      .finally(() => {
        creating = null;
      });

    await creating;
    return true;
  }

  browser.runtime.onConnect.addListener((port) => {
    const name = port.name || '';

    if (name === 'ttsx-offscreen') {
      const previousPort = offscreenPort;
      if (previousPort && previousPort !== port) {
        for (const pipe of sessions.values()) {
          postToContent(pipe.content, { type: 'backend-disconnected' });
        }
      }
      offscreenPort = port;
      previousPort?.disconnect();
      backgroundHost?.dispose();
      backgroundHost = null;

      port.onMessage.addListener(routeBackendMessage);
      port.onDisconnect.addListener(() => {
        if (offscreenPort !== port) return;
        offscreenPort = null;
        for (const pipe of sessions.values()) {
          postToContent(pipe.content, { type: 'backend-disconnected' });
        }
      });

      for (const pipe of sessions.values()) {
        postToContent(pipe.content, { type: 'offscreen-ready' });
      }
      return;
    }

    const m = /^ttsx-content:(.+)$/.exec(name);
    if (m) {
      const sid = m[1]!;
      const slot = sessionPipe(sid);
      const previousPort = slot.content;
      slot.content = port;
      previousPort?.disconnect();

      port.onMessage.addListener((msg) => {
        if (msg?.type === 'ensure-offscreen') {
          void ensureOffscreen()
            .then((ok) => {
              if (!ok) {
                port.postMessage({
                  type: 'error',
                  message: 'Offscreen API unavailable in this browser',
                });
                return;
              }
              postToContent(port, { type: 'offscreen-ensured' });
              if (backendAvailable()) {
                postToContent(port, { type: 'offscreen-ready' });
              }
            })
            .catch((e) => {
              postToContent(port, {
                type: 'error',
                message: e instanceof Error ? e.message : String(e),
              });
            });
          return;
        }

        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
        const routed: Record<string, unknown> = {
          ...(msg as Record<string, unknown>),
          sid,
        };
        try {
          if (offscreenPort) {
            offscreenPort.postMessage(routed);
          } else if (backgroundHost) {
            backgroundHost.handleMessage(routed);
          } else {
            postToContent(port, { type: 'backend-disconnected' });
            if (routed.type === 'generate') {
              postToContent(port, {
                type: 'error',
                id: routed.id,
                message: 'TTS backend disconnected',
              });
            }
            warmOffscreen();
          }
        } catch (error) {
          postToContent(port, {
            type: 'error',
            id: routed.id,
            message:
              error instanceof Error ? error.message : 'TTS engine not ready',
          });
        }
      });

      port.onDisconnect.addListener(() => {
        if (slot.content !== port) return;
        slot.content = undefined;
        sessions.delete(sid);
        try {
          const cancel = { type: 'cancel', sid };
          if (offscreenPort) offscreenPort.postMessage(cancel);
          else backgroundHost?.handleMessage(cancel);
        } catch {
          /* backend is already gone */
        }
      });

      if (backendAvailable()) {
        postToContent(port, { type: 'offscreen-ready' });
      }
    }
  });

  // Install / browser start: spin up offscreen so the model downloads in the
  // background instead of punishing the first tweet tap.
  browser.runtime.onInstalled.addListener(() => warmOffscreen());
  browser.runtime.onStartup.addListener(() => warmOffscreen());
  warmOffscreen();
});
