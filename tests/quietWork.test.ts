import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuietWork, PREFETCH_QUIET_MS, PREFETCH_COOLDOWN_MS, PREFETCH_RETRY_MS } from '../src/tts/quietWork';

let work: QuietWork;
beforeEach(() => vi.useFakeTimers());
afterEach(() => { work?.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('quiet background work', () => {
  it('starts no work during sustained scrolling and waits for the last input', async () => {
    const run = vi.fn(async () => 'done' as const);
    work = new QuietWork(() => true, run);
    work.request();
    for (let i = 0; i < 300; i++) {
      work.activity();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PREFETCH_QUIET_MS - 101);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('aborts running work and backs off before resuming', async () => {
    const signals: AbortSignal[] = [];
    const run = vi.fn((signal: AbortSignal) => new Promise<'more'>(resolve => {
      signals.push(signal);
      signal.addEventListener('abort', () => resolve('more'), { once: true });
    }));
    work = new QuietWork(() => true, run);
    work.request();
    await vi.advanceTimersByTimeAsync(PREFETCH_QUIET_MS);
    work.activity();
    expect(signals[0]!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(PREFETCH_COOLDOWN_MS - 1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('keeps hidden, unfocused and playback-busy tabs dormant', async () => {
    let allowed = false;
    const run = vi.fn(async () => 'more' as const);
    work = new QuietWork(() => allowed, run);
    work.request();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).not.toHaveBeenCalled();
    allowed = true;
    work.activity();
    await vi.advanceTimersByTimeAsync(PREFETCH_QUIET_MS);
    expect(run).toHaveBeenCalledTimes(1);
    allowed = false;
    work.pause();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not let viewport churn or settings callbacks bypass error backoff', async () => {
    const run = vi.fn(async () => 'retry' as const);
    work = new QuietWork(() => true, run);
    work.request();
    await vi.advanceTimersByTimeAsync(PREFETCH_QUIET_MS);
    for (let i = 0; i < 29; i++) {
      work.request();
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('cancels an idle callback when input resumes and never forces it with a timeout', async () => {
    const requestIdle = vi.fn(() => 9);
    const cancelIdle = vi.fn();
    vi.stubGlobal('requestIdleCallback', requestIdle);
    vi.stubGlobal('cancelIdleCallback', cancelIdle);
    const run = vi.fn(async () => 'done' as const);
    work = new QuietWork(() => true, run);
    work.request();
    await vi.advanceTimersByTimeAsync(PREFETCH_QUIET_MS);
    expect(requestIdle.mock.calls[0]).toHaveLength(1);
    work.activity();
    expect(cancelIdle).toHaveBeenCalledWith(9);
    expect(run).not.toHaveBeenCalled();
  });

  it('stops pending work permanently on invalidation', async () => {
    const run = vi.fn(async () => 'more' as const);
    work = new QuietWork(() => true, run);
    work.request();
    work.dispose();
    work.activity();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).not.toHaveBeenCalled();
  });
});
