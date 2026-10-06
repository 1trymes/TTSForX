import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ processor: vi.fn(), generate: vi.fn(), extract: vi.fn(), dispose: vi.fn() }));
vi.mock('../src/tts/supertonic3', () => ({ getSharedWebGpuAdapter: () => ({}) }));
vi.mock('@huggingface/transformers', () => ({
  env: { backends: { onnx: { webgpu: {} } } },
  pipeline: async () => ({
    processor: mocks.processor,
    tokenizer: () => ({ input_ids: { tolist: () => [[11]], dispose() {} } }),
    model: {
      _prepare_generation_config: () => ({ eos_token_id: 9, alignment_heads: [[0, 0]] }),
      _retrieve_init_tokens: () => [1, 2, 3, 4],
      generate: mocks.generate,
      _extract_token_timestamps: mocks.extract,
    },
  }),
}));

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe('alignment cancellation boundaries', () => {
  it('skips preprocessing for an already-cancelled chunk', async () => {
    const { alignWordsToAudio } = await import('../src/tts/wordAlignment');
    const result = alignWordsToAudio('word', new Float32Array(1600), 16000, 'en', undefined, () => true).catch(e => e.message);
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toBe('cancelled');
    expect(mocks.processor).not.toHaveBeenCalled();
  });

  it('does not submit a GPU alignment pass after cancellation during preprocessing', async () => {
    let finish!: () => void;
    mocks.processor.mockImplementation(() => new Promise(resolve => {
      finish = () => resolve({ input_features: { dispose: mocks.dispose } });
    }));
    const { alignWordsToAudio } = await import('../src/tts/wordAlignment');
    let cancelled = false;
    const result = alignWordsToAudio('word', new Float32Array(1600), 16000, 'en', undefined, () => cancelled).catch(e => e.message);
    await vi.advanceTimersByTimeAsync(10);
    expect(mocks.processor).toHaveBeenCalledOnce();
    cancelled = true;
    finish();
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toBe('cancelled');
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it('releases an already-running GPU result without doing timestamp extraction', async () => {
    mocks.processor.mockResolvedValue({ input_features: { dispose: mocks.dispose } });
    let finish!: () => void;
    mocks.generate.mockImplementation(() => new Promise(resolve => {
      finish = () => resolve({ sequences: { dispose: mocks.dispose }, cross_attentions: [[{ dispose: mocks.dispose }]] });
    }));
    const { alignWordsToAudio } = await import('../src/tts/wordAlignment');
    let cancelled = false;
    const result = alignWordsToAudio('word', new Float32Array(1600), 16000, 'en', undefined, () => cancelled).catch(e => e.message);
    await vi.advanceTimersByTimeAsync(10);
    expect(mocks.generate).toHaveBeenCalledOnce();
    cancelled = true;
    finish();
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toBe('cancelled');
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalledTimes(3);
  });
});
