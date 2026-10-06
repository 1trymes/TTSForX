import { describe, expect, it, vi } from 'vitest';
import { TtsWorkerHost } from '../src/tts/workerHost';

type Listener = (event: { data?: unknown; message?: string }) => void;

class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  readonly sent: Array<Record<string, unknown>> = [];
  terminated = false;
  private readonly messageListeners = new Set<Listener>();
  private readonly errorListeners = new Set<Listener>();

  postMessage(message: Record<string, unknown>): void {
    this.sent.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(type: string, listener: Listener): void {
    if (type === 'message') this.messageListeners.add(listener);
    if (type === 'error') this.errorListeners.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    if (type === 'message') this.messageListeners.delete(listener);
    if (type === 'error') this.errorListeners.delete(listener);
  }

  emit(message: Record<string, unknown>): void {
    const event = { data: message };
    this.onmessage?.(event);
    for (const listener of this.messageListeners) listener(event);
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('TtsWorkerHost', () => {
  it('does not let two tabs evict each other\'s background work', async () => {
    const output: Array<Record<string, unknown>> = [];
    const worker = new FakeWorker();
    const host = new TtsWorkerHost(message => output.push(message), () => worker as unknown as Worker);
    host.handleMessage({ type: 'generate', sid: 'a', id: 1, priority: 0.5 });
    await tick();
    host.handleMessage({ type: 'generate', sid: 'b', id: 1, priority: 0.5 });
    expect(output.at(-1)).toMatchObject({ sid: 'b', message: 'cancelled' });
    worker.emit({ type: 'ready' });
    await tick();
    host.handleMessage({ type: 'generate', sid: 'b', id: 2, priority: 0.5 });
    await tick();
    expect(worker.sent.filter(m => m.type === 'generate')).toHaveLength(1);
    expect(worker.sent.some(m => m.type === 'cancel')).toBe(false);
    host.dispose();
  });

  it('allows playback to preempt prefetch and ignores a stale request abort', async () => {
    const output: Array<Record<string, unknown>> = [];
    const worker = new FakeWorker();
    const host = new TtsWorkerHost(message => output.push(message), () => worker as unknown as Worker);
    host.handleMessage({ type: 'generate', sid: 'a', id: 1, priority: 0.5 });
    await tick();
    worker.emit({ type: 'ready' });
    await tick();
    host.handleMessage({ type: 'generate', sid: 'a', id: 2, priority: 1 });
    await tick();
    expect(worker.sent.slice(-2).map(m => m.type)).toEqual(['cancel', 'generate']);
    const count = worker.sent.length;
    host.handleMessage({ type: 'cancel', sid: 'a', id: 1 });
    expect(worker.sent).toHaveLength(count);
    host.handleMessage({ type: 'cancel', sid: 'a', id: 2 });
    expect(worker.sent.at(-1)?.type).toBe('cancel');
    expect(output.at(-1)).toMatchObject({ id: 2, message: 'cancelled' });
    expect(worker.terminated).toBe(false);
    host.dispose();
  });

  it('acknowledges cancellation during model loading and never starts that job', async () => {
    const output: Array<Record<string, unknown>> = [];
    const worker = new FakeWorker();
    const host = new TtsWorkerHost(message => output.push(message), () => worker as unknown as Worker);
    host.handleMessage({ type: 'generate', sid: 'a', id: 1, priority: 0.5 });
    await tick();
    host.handleMessage({ type: 'cancel', sid: 'a', id: 1 });
    expect(output.at(-1)).toMatchObject({ id: 1, message: 'cancelled' });
    worker.emit({ type: 'ready' });
    await tick();
    expect(worker.sent.some(m => m.type === 'generate')).toBe(false);
    host.dispose();
  });

  it('rewrites internal IDs and routes audio only to the requesting session', async () => {
    const output: Array<Record<string, unknown>> = [];
    const worker = new FakeWorker();
    const host = new TtsWorkerHost(
      (message) => output.push(message),
      () => worker as unknown as Worker,
    );

    host.handleMessage({
      type: 'generate',
      sid: 'tab-a',
      id: 7,
      text: 'hello',
      steps: 12,
      priority: 1,
    });
    await tick();
    expect(worker.sent.map((message) => message.type)).toEqual(['load']);

    worker.emit({ type: 'ready', device: 'webgpu' });
    await tick();
    const generate = worker.sent.find((message) => message.type === 'generate')!;
    expect(generate.id).not.toBe(7);
    expect(generate.sid).toBeUndefined();
    expect(generate.steps).toBe(12);

    worker.emit({
      type: 'audio-chunk',
      id: generate.id,
      index: 0,
      total: 1,
      samples: new Float32Array([0.1, 0.2]),
      sampleRate: 44_100,
    });
    worker.emit({
      type: 'audio-done',
      id: generate.id,
      complete: true,
      total: 1,
    });

    const audio = output.find((message) => message.type === 'audio-chunk')!;
    expect(audio).toMatchObject({
      sid: 'tab-a',
      id: 7,
      length: 2,
      encoding: 'pcm-s16le-base64',
    });
    expect(typeof audio.samples).toBe('string');
    expect(
      output.find((message) => message.type === 'audio-done'),
    ).toMatchObject({ sid: 'tab-a', id: 7 });
    host.dispose();
  });

  it('protects interactive playback from prefetch and safely preempts peers', async () => {
    const output: Array<Record<string, unknown>> = [];
    const workers: FakeWorker[] = [];
    const host = new TtsWorkerHost(
      (message) => output.push(message),
      () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
    );

    host.handleMessage({
      type: 'generate',
      sid: 'tab-a',
      id: 1,
      text: 'interactive',
      priority: 1,
    });
    await tick();
    const worker = workers[0]!;
    worker.emit({ type: 'ready', device: 'webgpu' });
    await tick();
    const first = worker.sent.find((message) => message.type === 'generate')!;

    host.handleMessage({
      type: 'generate',
      sid: 'tab-b',
      id: 2,
      text: 'prefetch',
      priority: 0.5,
    });
    expect(output.at(-1)).toMatchObject({
      type: 'error',
      sid: 'tab-b',
      id: 2,
      message: 'cancelled',
    });
    expect(worker.sent.at(-1)?.type).toBe('generate');

    host.handleMessage({
      type: 'generate',
      sid: 'tab-b',
      id: 3,
      text: 'new interactive',
      priority: 1,
    });
    await tick();
    const generations = worker.sent.filter(
      (message) => message.type === 'generate',
    );
    expect(generations).toHaveLength(2);
    expect(generations[1]!.id).not.toBe(generations[0]!.id);
    expect(
      worker.sent.slice(-2).map((message) => message.type),
    ).toEqual(['cancel', 'generate']);

    // Handoff is immediate and keeps the resident model while the old graph
    // run reaches its next cancellation boundary.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(workers).toHaveLength(1);
    expect(worker.terminated).toBe(false);

    // A late completion from the superseded job must not disturb the new one.
    worker.emit({ type: 'error', id: first.id, message: 'cancelled' });
    await tick();

    const beforeCancel = worker.sent.length;
    host.handleMessage({ type: 'cancel', sid: 'tab-a' });
    expect(worker.sent).toHaveLength(beforeCancel);
    host.handleMessage({ type: 'cancel', sid: 'tab-b' });
    expect(worker.sent.at(-1)?.type).toBe('cancel');
    host.dispose();
  });

  it('terminates a silent generation instead of leaving the UI loading forever', async () => {
    vi.useFakeTimers();
    try {
      const output: Array<Record<string, unknown>> = [];
      const worker = new FakeWorker();
      const host = new TtsWorkerHost(
        (message) => output.push(message),
        () => worker as unknown as Worker,
      );

      host.handleMessage({
        type: 'generate',
        sid: 'tab-a',
        id: 9,
        text: 'never completes',
        priority: 1,
      });
      await vi.advanceTimersByTimeAsync(0);
      worker.emit({ type: 'ready', device: 'webgpu' });
      await vi.advanceTimersByTimeAsync(0);
      expect(worker.sent.some((message) => message.type === 'generate')).toBe(
        true,
      );

      await vi.advanceTimersByTimeAsync(45_000);
      expect(output.at(-1)).toMatchObject({
        type: 'error',
        sid: 'tab-a',
        id: 9,
        message: 'Voice generation timed out',
      });
      expect(worker.terminated).toBe(true);
      host.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
