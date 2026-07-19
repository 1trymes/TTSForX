/**
 * Owns the single Supertonic 3 worker and isolates requests from multiple tabs.
 *
 * Chromium runs this host in the offscreen document. Firefox MV2 runs the
 * same host in its background page because it has no offscreen API.
 */
import TtsWorker from './worker.ts?worker';
import { debugHandledFailure } from '../diagnostics';
import { encodePcm16Base64 } from './pcmTransport';

type BusMessage = Record<string, unknown>;
type SendMessage = (message: BusMessage) => void;
type CreateWorker = () => Worker;

interface GenerateRequest {
  sid: string;
  clientId: number;
  priority: number;
  message: BusMessage;
  cancelled: boolean;
}

interface ActiveJob {
  sid: string;
  clientId: number;
  workerId: number;
  priority: number;
}

// A cold install downloads and compiles roughly 400 MB of official model
// graphs. Do not misreport a slow first load as a worker failure.
const READY_TIMEOUT_MS = 600_000;
// Once both models are resident, no individual WebGPU chunk may remain silent
// forever. Reset the worker after 45 seconds without a routed result so the UI
// reaches a terminal error and the next click starts from a clean runtime.
const GENERATION_INACTIVITY_TIMEOUT_MS = 45_000;

export class TtsWorkerHost {
  private worker: Worker | null = null;
  private workerReady: Promise<void> | null = null;
  private active: ActiveJob | null = null;
  private pending: GenerateRequest | null = null;
  private starting: GenerateRequest | null = null;
  private pumping = false;
  private disposed = false;
  private nextWorkerId = 0;
  private activeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly sendMessage: SendMessage,
    private readonly createWorker: CreateWorker = () => new TtsWorker(),
  ) {}

  /** Start loading opportunistically without making callers await the model. */
  preload(): void {
    void this.ensureWorkerReady().catch((error) => {
      debugHandledFailure('worker preload failed', error);
    });
  }

  handleMessage(message: unknown): void {
    if (
      this.disposed ||
      !message ||
      typeof message !== 'object' ||
      Array.isArray(message)
    ) {
      return;
    }
    const msg = message as BusMessage;

    if (msg.type === 'cancel') {
      this.cancelSession(typeof msg.sid === 'string' ? msg.sid : '');
      return;
    }

    if (msg.type === 'load') {
      this.preload();
      return;
    }

    if (msg.type !== 'generate') return;

    const sid = typeof msg.sid === 'string' ? msg.sid : '';
    const clientId = Number(msg.id);
    if (!sid || !Number.isFinite(clientId)) {
      this.safeSend({
        type: 'error',
        ...(sid ? { sid } : {}),
        ...(Number.isFinite(clientId) ? { id: clientId } : {}),
        message: 'Invalid TTS generation request',
      });
      return;
    }

    const parsedPriority = Number(msg.priority);
    const priority = Number.isFinite(parsedPriority)
      ? Math.max(0, Math.min(1, parsedPriority))
      : 1;
    this.queueGenerate({
      sid,
      clientId,
      priority,
      message: { ...msg },
      cancelled: false,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending = null;
    if (this.starting) this.starting.cancelled = true;
    this.starting = null;
    if (this.active) {
      this.finishJob(this.active);
    }
    this.invalidateWorker();
  }

  private queueGenerate(request: GenerateRequest): void {
    if (this.active && request.priority < this.active.priority) {
      this.rejectRequest(request, 'cancelled');
      return;
    }
    if (this.starting && request.priority < this.starting.priority) {
      this.rejectRequest(request, 'cancelled');
      return;
    }
    if (this.pending) {
      if (request.priority < this.pending.priority) {
        this.rejectRequest(request, 'cancelled');
        return;
      }
      this.rejectRequest(this.pending, 'cancelled');
    }
    this.pending = request;
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.disposed) return;
    this.pumping = true;
    try {
      while (!this.disposed && this.pending) {
        const request = this.pending;
        this.pending = null;
        this.starting = request;
        try {
          await this.startGenerate(request);
        } catch (error) {
          if (!request.cancelled) {
            this.rejectRequest(
              request,
              error instanceof Error ? error.message : String(error),
            );
          }
        } finally {
          if (this.starting === request) this.starting = null;
        }
      }
    } finally {
      this.pumping = false;
      if (!this.disposed && this.pending) void this.pump();
    }
  }

  private async startGenerate(request: GenerateRequest): Promise<void> {
    await this.ensureWorkerReady();
    if (request.cancelled || this.disposed) return;

    // A newer job accepted while the model was loading supersedes this one.
    if (this.pending && this.pending.priority >= request.priority) {
      request.cancelled = true;
      this.rejectRequest(request, 'cancelled');
      return;
    }

    const previous = this.active;
    if (previous) {
      if (request.priority < previous.priority) {
        this.rejectRequest(request, 'cancelled');
        return;
      }

      // Supersede immediately. Supertonic checks cancellation between each
      // WebGPU graph run while keeping the compiled model resident.
      this.worker?.postMessage({ type: 'cancel' });
      this.rejectActive(previous, 'cancelled');
    }

    if (request.cancelled || this.disposed) return;
    if (this.pending && this.pending.priority >= request.priority) {
      request.cancelled = true;
      this.rejectRequest(request, 'cancelled');
      return;
    }
    if (!this.worker) throw new Error('TTS worker missing');

    const workerId = ++this.nextWorkerId;
    this.active = {
      sid: request.sid,
      clientId: request.clientId,
      workerId,
      priority: request.priority,
    };
    this.armActiveTimer(this.active);

    const workerMessage: BusMessage = {
      ...request.message,
      id: workerId,
    };
    delete workerMessage.sid;
    delete workerMessage.priority;
    this.worker.postMessage(workerMessage);
  }

  private cancelSession(sid: string): void {
    if (!sid) return;
    if (this.pending?.sid === sid) {
      this.pending.cancelled = true;
      this.pending = null;
    }
    if (this.starting?.sid === sid) {
      this.starting.cancelled = true;
    }
    if (this.active?.sid === sid) {
      this.worker?.postMessage({ type: 'cancel' });
      this.rejectActive(this.active, 'cancelled');
    }
  }

  private async ensureWorkerReady(): Promise<void> {
    if (this.disposed) throw new Error('TTS worker host disposed');
    if (this.worker && this.workerReady) return this.workerReady;
    return this.spawnAndLoadWorker();
  }

  private spawnAndLoadWorker(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('TTS worker host disposed'));
    const worker = this.createWorker();
    this.worker = worker;
    this.wireWorker(worker);

    const ready = this.waitReady(worker).catch((error) => {
      if (this.worker === worker) this.invalidateWorker();
      throw error;
    });
    this.workerReady = ready;
    return ready;
  }

  private wireWorker(worker: Worker): void {
    worker.onmessage = (event: MessageEvent) => {
      if (worker !== this.worker) return;
      this.onWorkerMessage(event.data);
    };
    worker.onerror = (event: ErrorEvent) => {
      if (worker !== this.worker) return;
      const message = event.message || 'TTS worker crashed';
      if (this.active) {
        this.rejectActive(this.active, message);
      } else {
        this.safeSend({ type: 'error', message });
      }
      this.invalidateWorker();
    };
  }

  private onWorkerMessage(raw: unknown): void {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const data = raw as BusMessage;
    const hasId = data.id != null;

    // Model lifecycle events are shared and may update every tab's load UI.
    if (!hasId) {
      this.safeSend(data);
      return;
    }

    const active = this.active;
    if (!active || Number(data.id) !== active.workerId) return;
    this.armActiveTimer(active);

    const outgoing: BusMessage = {
      ...data,
      sid: active.sid,
      id: active.clientId,
    };
    if (
      (data.type === 'audio' || data.type === 'audio-chunk') &&
      data.samples instanceof Float32Array
    ) {
      const samples = data.samples;
      outgoing.samples = encodePcm16Base64(samples);
      outgoing.encoding = 'pcm-s16le-base64';
      outgoing.length = samples.length;
    }
    this.safeSend(outgoing);

    if (data.type === 'audio-done' || data.type === 'error') {
      this.finishJob(active);
    }
  }

  private waitReady(
    worker: Worker,
    timeoutMs = READY_TIMEOUT_MS,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
      };
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      const onMessage = (event: MessageEvent) => {
        const type = event.data?.type;
        if (type === 'ready') {
          settle(resolve);
        } else if (type === 'error' && event.data?.id == null) {
          settle(() =>
            reject(
              new Error(String(event.data.message || 'Worker load failed')),
            ),
          );
        }
      };
      const onError = (event: ErrorEvent) => {
        settle(() =>
          reject(new Error(event.message || 'TTS worker crashed during load')),
        );
      };
      const timer = setTimeout(
        () => settle(() => reject(new Error('Worker ready timeout'))),
        timeoutMs,
      );
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.postMessage({ type: 'load' });
    });
  }

  private rejectRequest(request: GenerateRequest, message: string): void {
    this.safeSend({
      type: 'error',
      sid: request.sid,
      id: request.clientId,
      message,
    });
  }

  private rejectActive(job: ActiveJob, message: string): void {
    this.safeSend({
      type: 'error',
      sid: job.sid,
      id: job.clientId,
      message,
    });
    this.finishJob(job);
  }

  private finishJob(job: ActiveJob): void {
    if (this.active !== job) return;
    this.clearActiveTimer();
    this.active = null;
  }

  private armActiveTimer(job: ActiveJob): void {
    this.clearActiveTimer();
    this.activeTimer = setTimeout(() => {
      if (this.active !== job) return;
      this.safeSend({
        type: 'error',
        sid: job.sid,
        id: job.clientId,
        message: 'Voice generation timed out',
      });
      this.finishJob(job);
      this.invalidateWorker();
    }, GENERATION_INACTIVITY_TIMEOUT_MS);
  }

  private clearActiveTimer(): void {
    if (this.activeTimer == null) return;
    clearTimeout(this.activeTimer);
    this.activeTimer = null;
  }

  private invalidateWorker(): void {
    this.clearActiveTimer();
    const worker = this.worker;
    this.worker = null;
    this.workerReady = null;
    try {
      worker?.terminate();
    } catch {
      /* already gone */
    }
  }

  private safeSend(message: BusMessage): void {
    try {
      this.sendMessage(message);
    } catch (error) {
      debugHandledFailure('worker host message failed', error);
    }
  }
}
