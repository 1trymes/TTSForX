import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadSettings: vi.fn(async () => ({})),
  settings: { voice: 'M1', steps: 8, speed: 1, volume: 1, karaoke: true },
}));
vi.mock('../src/tts/settings', () => ({
  getSettings: () => mocks.settings,
  resolveVoice: () => 'M1',
  loadSettings: mocks.loadSettings,
  onSettingsChange: () => () => {},
}));

let engine: (typeof import('../src/tts/engine'))['engine'];
let receive: (message: Record<string, unknown>) => void;
let sent: Record<string, unknown>[];
const flush = async () => { await vi.advanceTimersByTimeAsync(0); };

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  mocks.loadSettings.mockResolvedValue({});
  sent = [];
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  vi.stubGlobal('browser', { runtime: { connect: () => ({
    postMessage: (message: Record<string, unknown>) => sent.push(message),
    onMessage: { addListener: (listener: typeof receive) => { receive = listener; } },
    onDisconnect: { addListener: () => {} },
    disconnect: () => {},
  }) } });
  engine = (await import('../src/tts/engine')).engine;
});
afterEach(() => { engine.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('speculative generation cancellation', () => {
  it('starts explicit playback without waiting for the prefetch cooldown', async () => {
    class AudioContextStub {
      state = 'running';
      destination = {};
      createGain() { return { gain: { value: 1 }, connect() {} }; }
    }
    Object.assign(window, { AudioContext: AudioContextStub });
    const controller = new AbortController();
    const warm = engine.synthesize('same post', { silent: true, maxChunks: 1, signal: controller.signal }).catch(e => e.message);
    await flush();
    receive({ type: 'offscreen-ready' });
    await flush();
    const warmId = sent.at(-1)!.id;
    const playback = engine.play('same post');
    await flush();
    expect(await warm).toBe('cancelled');
    const request = sent.at(-1)!;
    expect(request).toMatchObject({ type: 'generate', text: 'same post', priority: 1 });
    expect(request.id).not.toBe(warmId);
    const count = sent.length;
    controller.abort();
    expect(sent).toHaveLength(count);
    receive({ type: 'error', id: request.id, message: 'cancelled' });
    await playback;
  });

  it('never opens the backend if aborted during settings loading', async () => {
    let loaded!: () => void;
    mocks.loadSettings.mockImplementationOnce(() => new Promise(resolve => { loaded = () => resolve({}); }));
    const controller = new AbortController();
    const result = engine.synthesize('warm post', { silent: true, maxChunks: 1, signal: controller.signal }).catch(e => e.message);
    controller.abort();
    loaded();
    expect(await result).toBe('cancelled');
    expect(sent).toEqual([]);
  });

  it('does not send a delayed warm request after the backend becomes ready', async () => {
    const controller = new AbortController();
    const result = engine.synthesize('warm post', { silent: true, maxChunks: 1, signal: controller.signal }).catch(e => e.message);
    await flush();
    expect(sent.some(m => m.type === 'ensure-offscreen')).toBe(true);
    controller.abort();
    expect(await result).toBe('cancelled');
    receive({ type: 'offscreen-ready' });
    await flush();
    expect(sent.some(m => m.type === 'generate')).toBe(false);
  });

  it('cancels only the running request and ignores its late audio', async () => {
    const controller = new AbortController();
    const result = engine.synthesize('warm post', { silent: true, maxChunks: 1, signal: controller.signal }).catch(e => e.message);
    await flush();
    receive({ type: 'offscreen-ready' });
    await flush();
    const generate = sent.find(m => m.type === 'generate')!;
    expect(generate.priority).toBe(0.5);
    controller.abort();
    expect(await result).toBe('cancelled');
    expect(sent.at(-1)).toEqual({ type: 'cancel', id: generate.id });
    receive({ type: 'audio-done', id: generate.id });
    const next = engine.synthesize('foreground post', { silent: false }).catch(e => e.message);
    await flush();
    expect(sent.at(-1)).toMatchObject({ type: 'generate', priority: 1, text: 'foreground post' });
    receive({ type: 'error', id: sent.at(-1)!.id, message: 'cancelled' });
    await next;
  });

  it('drops queued speculative work without cancelling foreground synthesis', async () => {
    const foreground = engine.synthesize('foreground', { silent: false }).catch(e => e.message);
    await flush();
    receive({ type: 'offscreen-ready' });
    await flush();
    const id = sent.at(-1)!.id;
    const controller = new AbortController();
    const background = engine.synthesize('background', { silent: true, signal: controller.signal }).catch(e => e.message);
    await flush();
    const count = sent.length;
    controller.abort();
    expect(await background).toBe('cancelled');
    expect(sent).toHaveLength(count);
    receive({ type: 'error', id, message: 'cancelled' });
    await foreground;
    await flush();
    expect(sent.filter(m => m.type === 'generate')).toHaveLength(1);
  });
});
