/** One cancellable background unit after interaction has been quiet. */
export const PREFETCH_QUIET_MS = 1500;
export const PREFETCH_COOLDOWN_MS = 5000;
export const PREFETCH_RETRY_MS = 30_000;

export class QuietWork {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private idle: number | null = null;
  private active: AbortController | null = null;
  private wanted = false;
  private disposed = false;
  private quietUntil = Date.now() + PREFETCH_QUIET_MS;
  private nextStart = 0;

  constructor(
    private readonly canRun: () => boolean,
    private readonly run: (signal: AbortSignal) => Promise<'more' | 'done' | 'retry'>,
  ) {}

  request(): void {
    this.wanted = true;
    this.schedule();
  }

  activity(): void {
    this.quietUntil = Date.now() + PREFETCH_QUIET_MS;
    this.pause();
    this.request();
  }

  pause(): void {
    if (this.timer != null) clearTimeout(this.timer);
    if (this.idle != null) cancelIdleCallback(this.idle);
    this.timer = null;
    this.idle = null;
    this.active?.abort();
  }

  dispose(): void {
    this.disposed = true;
    this.pause();
  }

  private schedule(): void {
    if (this.disposed || !this.wanted || this.active || this.timer != null ||
        this.idle != null || !this.canRun()) return;
    const delay = Math.max(0, this.quietUntil - Date.now(), this.nextStart - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.canRun() || this.disposed) return;
      // No timeout: a busy renderer should never be forced to run prefetch.
      if (typeof requestIdleCallback === 'function') {
        this.idle = requestIdleCallback(() => {
          this.idle = null;
          void this.start();
        });
      } else {
        void this.start();
      }
    }, delay);
  }

  private async start(): Promise<void> {
    if (this.disposed || !this.canRun()) return;
    if (Date.now() < this.quietUntil || Date.now() < this.nextStart) {
      this.schedule();
      return;
    }
    const controller = new AbortController();
    this.active = controller;
    this.wanted = false;
    let result: 'more' | 'done' | 'retry' = 'retry';
    try {
      result = await this.run(controller.signal);
    } catch {
      // The owner records errors; an unexpected rejection also backs off.
    } finally {
      this.active = null;
      // Settings/viewport callbacks cannot turn cancellation into a retry loop.
      this.nextStart = Date.now() + (result === 'retry' && !controller.signal.aborted
        ? PREFETCH_RETRY_MS : PREFETCH_COOLDOWN_MS);
      this.wanted ||= result !== 'done' || controller.signal.aborted;
      this.schedule();
    }
  }
}
