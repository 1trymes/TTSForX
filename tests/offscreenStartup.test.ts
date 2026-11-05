import { afterEach, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ preload: vi.fn(), handleMessage: vi.fn(), dispose: vi.fn() }));
vi.mock('../src/tts/workerHost', () => ({
  TtsWorkerHost: class { constructor() { return host; } },
}));

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.resetModules(); });

it('announces the offscreen document without loading the GPU until requested', async () => {
  let receive!: (message: unknown) => void;
  const postMessage = vi.fn();
  vi.stubGlobal('browser', { runtime: { connect: () => ({
    postMessage,
    onMessage: { addListener: (fn: typeof receive) => { receive = fn; } },
    onDisconnect: { addListener() {} },
  }) } });
  await import('../src/entrypoints/offscreen/main');
  expect(postMessage).toHaveBeenCalledWith({ type: 'offscreen-ready' });
  expect(host.preload).not.toHaveBeenCalled();
  receive({ type: 'generate', sid: 'tab', id: 1 });
  expect(host.handleMessage).toHaveBeenCalledWith({ type: 'generate', sid: 'tab', id: 1 });
});
