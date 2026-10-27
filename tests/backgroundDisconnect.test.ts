import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('acknowledges port errors and cancels the disconnected content session', async () => {
  let onConnect!: (port: unknown) => void;
  let onDisconnect!: () => void;
  let reads = 0;
  const sent: unknown[] = [];
  vi.stubGlobal('defineBackground', (start: () => void) => start);
  vi.stubGlobal('browser', { runtime: {
    get lastError() { reads++; return { message: 'page moved into back/forward cache' }; },
    onConnect: { addListener: (fn: typeof onConnect) => { onConnect = fn; } },
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
  } });
  const background = await import('../src/entrypoints/background');
  (background.default as unknown as () => void)();
  const offscreen = {
    name: 'ttsx-offscreen',
    postMessage: (message: unknown) => sent.push(message),
    onMessage: { addListener() {} },
    onDisconnect: { addListener() {} },
    disconnect() {},
  };
  onConnect(offscreen);
  onConnect({
    name: 'ttsx-content:session',
    postMessage() {},
    onMessage: { addListener() {} },
    onDisconnect: { addListener: (fn: () => void) => { onDisconnect = fn; } },
    disconnect() {},
  });
  onDisconnect();
  expect(reads).toBe(1);
  expect(sent).toContainEqual({ type: 'cancel', sid: 'session' });
});
