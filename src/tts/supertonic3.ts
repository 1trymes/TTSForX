/**
 * Strict browser runtime for the official Supertone/supertonic-3 export.
 *
 * The upstream browser demo is reference code rather than a published npm
 * package. This implementation keeps its four-graph inference contract while
 * avoiding the reference demo's repeated Array -> Tensor copies.
 */
import * as ort from 'onnxruntime-web/webgpu';
import {
  DEFAULT_TTS_LANGUAGE,
  isSupportedTtsLanguage,
} from './languages';
import {
  DEFAULT_GENERATION_STEPS,
  normalizeGenerationSteps,
} from './quality';

export const SUPERTONIC3_REVISION =
  '3cadd1ee6394adea1bd021217a0e650ede09a323';
export const SUPERTONIC3_MODEL_BASE =
  `https://huggingface.co/Supertone/supertonic-3/resolve/${SUPERTONIC3_REVISION}`;
export const SUPERTONIC3_SAMPLE_RATE = 44_100;
export const SUPERTONIC3_STEPS = DEFAULT_GENERATION_STEPS;
export const SUPERTONIC3_LANGUAGE = DEFAULT_TTS_LANGUAGE;

const MODEL_FILES = [
  { name: 'duration_predictor.onnx', bytes: 3_700_147 },
  { name: 'text_encoder.onnx', bytes: 36_416_150 },
  { name: 'vector_estimator.onnx', bytes: 256_534_781 },
  { name: 'vocoder.onnx', bytes: 101_424_195 },
] as const;
const MODEL_CACHE_PREFIX = 'ttsx-supertonic3-';
const MODEL_CACHE_NAME = `${MODEL_CACHE_PREFIX}${SUPERTONIC3_REVISION}`;
let modelCachePromise: Promise<Cache> | null = null;

type Session = ort.InferenceSession;
type Tensor = ort.Tensor;

interface SupertonicConfig {
  ttl: {
    latent_dim: number;
    chunk_compress_factor: number;
  };
  ae: {
    sample_rate: number;
    base_chunk_size: number;
  };
}

interface VoiceStyleJson {
  style_ttl: {
    dims: number[];
    data: unknown;
  };
  style_dp: {
    dims: number[];
    data: unknown;
  };
}

export interface SupertonicStyle {
  ttl: Tensor;
  dp: Tensor;
}

export interface SupertonicSynthesisOptions {
  speed?: number;
  steps?: number;
  language?: string;
  cancelled?: () => boolean;
}

export interface SupertonicAudio {
  samples: Float32Array;
  sampleRate: number;
  duration: number;
}

function assetUrl(path: string): string {
  return `${SUPERTONIC3_MODEL_BASE}/${path}`;
}

async function modelCache(): Promise<Cache> {
  if (modelCachePromise) return modelCachePromise;
  modelCachePromise = (async () => {
    if (!globalThis.caches) {
      throw new Error('Persistent model storage is unavailable.');
    }
    const cache = await globalThis.caches.open(MODEL_CACHE_NAME);
    const names = await globalThis.caches.keys();
    await Promise.all(
      names
        .filter(
          (name) =>
            name.startsWith(MODEL_CACHE_PREFIX) && name !== MODEL_CACHE_NAME,
        )
        .map((name) => globalThis.caches.delete(name)),
    );
    return cache;
  })().catch((error) => {
    modelCachePromise = null;
    throw error;
  });
  return modelCachePromise;
}

async function loadModelBytes(
  name: string,
  expectedBytes: number,
): Promise<Uint8Array> {
  const cache = await modelCache();
  const request = new Request(assetUrl(`onnx/${name}`), {
    credentials: 'omit',
  });
  let response = await cache.match(request);

  if (!response) {
    const network = await fetch(request, { cache: 'no-store' });
    if (!network.ok) {
      throw new Error(
        `Supertonic 3 model failed (${network.status}): ${name}`,
      );
    }
    const cacheWrite = cache.put(request, network.clone());
    const [buffer] = await Promise.all([network.arrayBuffer(), cacheWrite]);
    if (buffer.byteLength !== expectedBytes) {
      await cache.delete(request);
      throw new Error(
        `Supertonic 3 model size mismatch for ${name} ` +
          `(${buffer.byteLength}/${expectedBytes})`,
      );
    }
    return new Uint8Array(buffer);
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength !== expectedBytes) {
    await cache.delete(request);
    throw new Error(
      `Cached Supertonic 3 model is corrupt: ${name} ` +
        `(${buffer.byteLength}/${expectedBytes})`,
    );
  }
  return new Uint8Array(buffer);
}

async function fetchJson<T>(url: string): Promise<T> {
  const cache = await modelCache();
  const request = new Request(url, { credentials: 'omit' });
  const cached = await cache.match(request);
  if (cached) {
    try {
      return (await cached.json()) as T;
    } catch {
      await cache.delete(request);
      throw new Error('Cached Supertonic 3 JSON asset is corrupt');
    }
  }

  const response = await fetch(request, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Supertonic 3 asset failed (${response.status})`);
  }
  const text = await response.text();
  let parsed: T;
  try {
    parsed = JSON.parse(text) as T;
  } catch {
    throw new Error('Supertonic 3 JSON asset is invalid');
  }
  await cache.put(
    request,
    new Response(text, {
      headers: { 'content-type': 'application/json' },
    }),
  );
  return parsed;
}

function throwIfCancelled(cancelled?: () => boolean): void {
  if (cancelled?.()) throw new Error('cancelled');
}

function disposeTensor(tensor: Tensor | undefined): void {
  try {
    tensor?.dispose();
  } catch {
    // Cleanup must not mask the synthesis result or the original graph error.
  }
}

function flattenNumbers(value: unknown, out: number[]): void {
  if (Array.isArray(value)) {
    for (const item of value) flattenNumbers(item, out);
    return;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error('Supertonic 3 voice style contains invalid data');
  }
  out.push(number);
}

function checkedTensor(
  data: unknown,
  dims: number[],
  label: string,
): Tensor {
  if (
    !dims.length ||
    dims.some((dim) => !Number.isInteger(dim) || dim <= 0)
  ) {
    throw new Error(`Supertonic 3 ${label} has invalid dimensions`);
  }
  const flat: number[] = [];
  flattenNumbers(data, flat);
  const expected = dims.reduce((product, dim) => product * dim, 1);
  if (flat.length !== expected) {
    throw new Error(
      `Supertonic 3 ${label} size mismatch (${flat.length}/${expected})`,
    );
  }
  return new ort.Tensor('float32', Float32Array.from(flat), dims);
}

/** Box-Muller normal distribution, filled without intermediate JS arrays. */
function fillGaussian(target: Float32Array): void {
  for (let i = 0; i < target.length; i += 2) {
    const u1 = Math.max(Number.EPSILON, Math.random());
    const u2 = Math.random();
    const radius = Math.sqrt(-2 * Math.log(u1));
    const angle = 2 * Math.PI * u2;
    target[i] = radius * Math.cos(angle);
    if (i + 1 < target.length) {
      target[i + 1] = radius * Math.sin(angle);
    }
  }
}

function normalizeText(text: string, language: string): string {
  if (!isSupportedTtsLanguage(language)) {
    throw new Error(`Supertonic 3 language is unsupported: ${language}`);
  }

  let normalized = text
    .normalize('NFKD')
    .replace(
      /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu,
      '',
    )
    .replace(/[‐‑–—]/g, '-')
    .replace(/[_\[\]|/#→←]/g, ' ')
    .replace(/[“”]/g, '"')
    .replace(/[‘’´`]/g, "'")
    .replace(/[♥☆♡©\\]/g, '')
    .replace(/@/g, ' at ')
    .replace(/\be\.g\.,/gi, 'for example, ')
    .replace(/\bi\.e\.,/gi, 'that is, ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/"{2,}/g, '"')
    .replace(/'{2,}/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) throw new Error('No text to read.');
  if (!/[.!?;:,'")\]}…。、』」】〉》›»]$/u.test(normalized)) {
    normalized += '.';
  }
  return `<${language}>${normalized}</${language}>`;
}

class UnicodeProcessor {
  constructor(private readonly indexer: number[]) {}

  encode(
    text: string,
    language: string,
  ): { textIds: Tensor; textMask: Tensor } {
    const normalized = normalizeText(text, language);
    const codePoints = Array.from(normalized, (char) => char.codePointAt(0)!);
    const ids = new BigInt64Array(codePoints.length);
    const mask = new Float32Array(codePoints.length);

    for (let i = 0; i < codePoints.length; i++) {
      const token = this.indexer[codePoints[i]!] ?? -1;
      ids[i] = BigInt(token);
      mask[i] = 1;
    }

    return {
      textIds: new ort.Tensor('int64', ids, [1, ids.length]),
      textMask: new ort.Tensor('float32', mask, [1, 1, mask.length]),
    };
  }
}

export class Supertonic3 {
  readonly sampleRate: number;
  private readonly styles = new Map<string, Promise<SupertonicStyle>>();

  constructor(
    private readonly config: SupertonicConfig,
    private readonly processor: UnicodeProcessor,
    private readonly durationPredictor: Session,
    private readonly textEncoder: Session,
    private readonly vectorEstimator: Session,
    private readonly vocoder: Session,
  ) {
    this.sampleRate = config.ae.sample_rate;
    if (this.sampleRate !== SUPERTONIC3_SAMPLE_RATE) {
      throw new Error(`Unexpected Supertonic 3 sample rate: ${this.sampleRate}`);
    }
  }

  loadStyle(voice: string): Promise<SupertonicStyle> {
    let promise = this.styles.get(voice);
    if (promise) return promise;

    promise = fetchJson<VoiceStyleJson>(
      assetUrl(`voice_styles/${voice}.json`),
    )
      .then((json) => ({
        ttl: checkedTensor(json.style_ttl.data, json.style_ttl.dims, 'TTL style'),
        dp: checkedTensor(json.style_dp.data, json.style_dp.dims, 'DP style'),
      }))
      .catch((error) => {
        this.styles.delete(voice);
        throw error;
      });
    this.styles.set(voice, promise);
    return promise;
  }

  async synthesize(
    text: string,
    style: SupertonicStyle,
    options: SupertonicSynthesisOptions = {},
  ): Promise<SupertonicAudio> {
    const cancelled = options.cancelled;
    const language = options.language ?? SUPERTONIC3_LANGUAGE;
    const speed = Math.min(1.5, Math.max(0.8, options.speed ?? 1.05));
    const steps = normalizeGenerationSteps(options.steps);
    const { textIds, textMask } = this.processor.encode(text, language);
    let textEmbedding: Tensor | undefined;
    let latent: Tensor | undefined;
    let latentMask: Tensor | undefined;
    let totalStep: Tensor | undefined;

    try {
      throwIfCancelled(cancelled);
      const durationOutput = await this.durationPredictor.run({
        text_ids: textIds,
        style_dp: style.dp,
        text_mask: textMask,
      });
      const durationTensor = durationOutput.duration;
      const rawDuration = Number(durationTensor?.data[0]);
      disposeTensor(durationTensor);
      throwIfCancelled(cancelled);
      const duration = rawDuration / speed;
      if (!Number.isFinite(duration) || duration <= 0 || duration > 900) {
        throw new Error(`Supertonic 3 produced invalid duration: ${duration}`);
      }

      const textOutput = await this.textEncoder.run({
        text_ids: textIds,
        style_ttl: style.ttl,
        text_mask: textMask,
      });
      textEmbedding = textOutput.text_emb;
      if (!textEmbedding) {
        throw new Error('Supertonic 3 text encoder returned no embedding');
      }
      throwIfCancelled(cancelled);

      const chunkSize =
        this.config.ae.base_chunk_size *
        this.config.ttl.chunk_compress_factor;
      const latentLength = Math.max(
        1,
        Math.ceil((duration * this.sampleRate) / chunkSize),
      );
      const latentChannels =
        this.config.ttl.latent_dim *
        this.config.ttl.chunk_compress_factor;

      const latentData = new Float32Array(latentChannels * latentLength);
      fillGaussian(latentData);
      latent = new ort.Tensor(
        'float32',
        latentData,
        [1, latentChannels, latentLength],
      );
      latentMask = new ort.Tensor(
        'float32',
        new Float32Array(latentLength).fill(1),
        [1, 1, latentLength],
      );
      totalStep = new ort.Tensor(
        'float32',
        Float32Array.of(steps),
        [1],
      );

      for (let step = 0; step < steps; step++) {
        throwIfCancelled(cancelled);
        const currentStep = new ort.Tensor(
          'float32',
          Float32Array.of(step),
          [1],
        );
        let output: ort.InferenceSession.OnnxValueMapType;
        try {
          output = await this.vectorEstimator.run({
            noisy_latent: latent,
            text_emb: textEmbedding,
            style_ttl: style.ttl,
            latent_mask: latentMask,
            text_mask: textMask,
            current_step: currentStep,
            total_step: totalStep,
          });
        } finally {
          disposeTensor(currentStep);
        }
        const next = output.denoised_latent;
        if (!next || next.type !== 'float32') {
          throw new Error('Supertonic 3 vector estimator returned no latent');
        }
        const previous = latent;
        latent = next;
        if (previous !== next) disposeTensor(previous);
        throwIfCancelled(cancelled);
      }

      const vocoderOutput = await this.vocoder.run({ latent });
      const wavTensor = vocoderOutput.wav_tts;
      const raw = wavTensor?.data;
      if (!(raw instanceof Float32Array)) {
        disposeTensor(wavTensor);
        throw new Error('Supertonic 3 vocoder returned invalid audio');
      }
      if (cancelled?.()) {
        disposeTensor(wavTensor);
        throw new Error('cancelled');
      }

      const expectedLength = Math.floor(duration * this.sampleRate);
      const length = Math.min(expectedLength, raw.length);
      if (length <= 0) {
        disposeTensor(wavTensor);
        throw new Error('Supertonic 3 produced empty audio');
      }
      const samples = raw.slice(0, length);
      disposeTensor(wavTensor);

      return {
        samples,
        sampleRate: this.sampleRate,
        duration,
      };
    } finally {
      disposeTensor(latent);
      disposeTensor(latentMask);
      disposeTensor(totalStep);
      disposeTensor(textEmbedding);
      disposeTensor(textIds);
      disposeTensor(textMask);
    }
  }
}

type WebGpuAdapter = typeof ort.env.webgpu.adapter;
let sharedWebGpuAdapter: WebGpuAdapter | null = null;

/** Reuse one adapter across the TTS and alignment runtimes. */
export function getSharedWebGpuAdapter(): WebGpuAdapter | null {
  return sharedWebGpuAdapter;
}

async function configureWebGpuRuntime(): Promise<void> {
  const gpu = (
    self.navigator as Navigator & {
      gpu?: { requestAdapter: () => Promise<WebGpuAdapter | null> };
    }
  ).gpu;
  if (!gpu) {
    throw new Error('Supertonic 3 requires WebGPU in this browser.');
  }
  const adapter = await gpu.requestAdapter();
  if (!adapter) {
    throw new Error('Supertonic 3 could not acquire a WebGPU adapter.');
  }

  // Reuse the adapter acquired above. Otherwise ONNX Runtime performs a
  // duplicate requestAdapter() call whose options trigger a Chromium warning
  // on Windows. Keep real runtime failures visible while suppressing expected
  // graph-placement warnings from ONNX Runtime's WebGPU backend.
  sharedWebGpuAdapter = adapter;
  ort.env.webgpu.adapter = adapter;
  ort.env.logLevel = 'error';
}

export async function loadSupertonic3(
  onModel?: (name: string, current: number, total: number) => void,
): Promise<Supertonic3> {
  await configureWebGpuRuntime();

  const [config, indexer] = await Promise.all([
    fetchJson<SupertonicConfig>(assetUrl('onnx/tts.json')),
    fetchJson<number[]>(assetUrl('onnx/unicode_indexer.json')),
  ]);
  if (!Array.isArray(indexer) || !indexer.length) {
    throw new Error('Supertonic 3 Unicode index is invalid');
  }
  if (
    config.ae?.sample_rate !== SUPERTONIC3_SAMPLE_RATE ||
    !Number.isInteger(config.ae?.base_chunk_size) ||
    config.ae.base_chunk_size <= 0 ||
    !Number.isInteger(config.ttl?.latent_dim) ||
    config.ttl.latent_dim <= 0 ||
    !Number.isInteger(config.ttl?.chunk_compress_factor) ||
    config.ttl.chunk_compress_factor <= 0
  ) {
    throw new Error('Supertonic 3 configuration is incompatible');
  }

  const sessions: Session[] = [];
  try {
    for (let i = 0; i < MODEL_FILES.length; i++) {
      const file = MODEL_FILES[i]!;
      onModel?.(file.name, i + 1, MODEL_FILES.length);
      const bytes = await loadModelBytes(file.name, file.bytes);
      sessions.push(
        await ort.InferenceSession.create(bytes, {
          executionProviders: ['webgpu'],
          graphOptimizationLevel: 'all',
          // ORT deliberately keeps shape-only nodes on CPU while all tensor
          // inference stays on WebGPU. Do not surface that expected placement
          // diagnostic as a Chrome extension error.
          logSeverityLevel: 3,
        }),
      );
    }
  } catch (error) {
    await Promise.allSettled(sessions.map((session) => session.release()));
    throw error;
  }

  return new Supertonic3(
    config,
    new UnicodeProcessor(indexer),
    sessions[0]!,
    sessions[1]!,
    sessions[2]!,
    sessions[3]!,
  );
}
