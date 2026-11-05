import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ env: { webgpu: {} as { adapter?: unknown }, logLevel: '' } }));
vi.mock('onnxruntime-web/webgpu', () => runtime);

beforeEach(() => {
  vi.resetModules();
  runtime.env.webgpu = {};
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('model download reached')));
  vi.stubGlobal('caches', { open: async () => ({ match: async () => undefined }), keys: async () => [] });
});
afterEach(() => vi.unstubAllGlobals());

describe('WebGPU availability', () => {
  it('rejects unsupported browsers before downloading models', async () => {
    vi.stubGlobal('self', { navigator: {} });
    const { loadSupertonic3 } = await import('../src/tts/supertonic3');
    await expect(loadSupertonic3()).rejects.toThrow('requires WebGPU');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('handles an absent adapter once, with no model download or automatic retry', async () => {
    const requestAdapter = vi.fn().mockResolvedValue(null);
    vi.stubGlobal('self', { navigator: { gpu: { requestAdapter } } });
    const { loadSupertonic3 } = await import('../src/tts/supertonic3');
    await expect(loadSupertonic3()).rejects.toThrow('GPU acceleration is unavailable. Restart your browser and try again.');
    expect(requestAdapter).toHaveBeenCalledExactlyOnceWith();
    expect(fetch).not.toHaveBeenCalled();
    expect(runtime.env.webgpu.adapter).toBeUndefined();
  });

  it('handles a rejected adapter request and preserves the original cause', async () => {
    const cause = new Error('No available adapters.');
    const requestAdapter = vi.fn().mockRejectedValue(cause);
    vi.stubGlobal('self', { navigator: { gpu: { requestAdapter } } });
    const { loadSupertonic3 } = await import('../src/tts/supertonic3');
    await expect(loadSupertonic3()).rejects.toMatchObject({
      message: expect.stringContaining('GPU acceleration is unavailable.'), cause,
    });
    expect(requestAdapter).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('can acquire the shared adapter on a later explicit attempt after recovery', async () => {
    const adapter = { features: new Set(['shader-f16']) };
    const requestAdapter = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(adapter);
    vi.stubGlobal('self', { navigator: { gpu: { requestAdapter } } });
    const { loadSupertonic3, getSharedWebGpuAdapter } = await import('../src/tts/supertonic3');
    await expect(loadSupertonic3()).rejects.toThrow('GPU acceleration is unavailable.');
    await expect(loadSupertonic3()).rejects.toThrow('model download reached');
    expect(requestAdapter).toHaveBeenCalledTimes(2);
    expect(runtime.env.webgpu.adapter).toBe(adapter);
    expect(getSharedWebGpuAdapter()).toBe(adapter);
  });
});
