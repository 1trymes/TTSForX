/**
 * Audio-grounded word timing for Supertonic output.
 *
 * Supertonic 3 exposes only an utterance duration. Whisper's cross-attention
 * DTW timestamps are computed from the finished PCM instead, so karaoke never
 * falls back to character counts or wall-clock estimates.
 */
import { tokenizeWords, type WordCue } from './karaokeCues';
import { getSharedWebGpuAdapter } from './supertonic3';

export const WORD_ALIGNER_MODEL = 'Xenova/whisper-tiny';
export const WORD_ALIGNER_REVISION =
  '5332fcc35e32a33b86612b9a57a89be7906102b1';
const ALIGNER_SAMPLE_RATE = 16_000;
const CONTENT_LENGTH_WARNING =
  'Unable to determine content-length from response headers.';

export interface RecognizedChunk {
  text: string;
  timestamp: [number, number];
}

interface TensorLike {
  dims: number[];
  tolist(): unknown;
  slice(...slices: unknown[]): TensorLike;
  dispose?(): void;
}

interface ForcedAlignmentOutput {
  sequences: TensorLike;
  cross_attentions: TensorLike[][];
  past_key_values?: Record<string, TensorLike>;
}

interface WhisperTokenizer {
  (
    text: string,
    options: { add_special_tokens: false },
  ): { input_ids: TensorLike };
  collateWordTimestamps(
    tokens: number[],
    tokenTimestamps: [number, number][],
    language?: string,
  ): RecognizedChunk[];
}

interface SourceAligner {
  processor(
    audio: Float32Array,
  ): Promise<{ input_features: TensorLike }>;
  tokenizer: WhisperTokenizer;
  model: {
    _prepare_generation_config(
      config: null,
      options: Record<string, unknown>,
    ): Record<string, unknown>;
    _retrieve_init_tokens(config: Record<string, unknown>): number[];
    _extract_token_timestamps(
      output: {
        sequences: { dims: number[] };
        cross_attentions: TensorLike[][];
      },
      heads: number[][],
      numFrames: number,
    ): TensorLike;
    generate(options: Record<string, unknown>): Promise<ForcedAlignmentOutput>;
  };
}

let aligner: SourceAligner | null = null;
let loading: Promise<SourceAligner> | null = null;

function progressLabel(value: unknown): string {
  if (!value || typeof value !== 'object') return 'Preparing word timing';
  const info = value as Record<string, unknown>;
  const file = typeof info.file === 'string' ? info.file.split('/').at(-1) : '';
  const progress = Number(info.progress);
  if (file && Number.isFinite(progress)) {
    return `${file} ${Math.max(0, Math.min(100, Math.round(progress)))}%`;
  }
  return file || 'Preparing word timing';
}

/**
 * Transformers.js emits a warning when an HTTP response is streamed without
 * Content-Length. Its growable-buffer path is intentional and lossless; keep
 * every other warning visible.
 */
async function withoutMissingLengthWarning<T>(
  run: () => Promise<T>,
): Promise<T> {
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    if (
      typeof args[0] === 'string' &&
      args[0].includes(CONTENT_LENGTH_WARNING)
    ) {
      return;
    }
    original(...args);
  };
  try {
    return await run();
  } finally {
    console.warn = original;
  }
}

export function loadWordAligner(
  onProgress?: (stage: string) => void,
): Promise<SourceAligner> {
  if (aligner) return Promise.resolve(aligner);
  if (loading) return loading;

  loading = withoutMissingLengthWarning(async () => {
    const { env, pipeline } = await import('@huggingface/transformers');
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.useBrowserCache = true;
    env.backends.onnx.logLevel = 'error';
    const webgpu = env.backends.onnx.webgpu;
    const adapter = getSharedWebGpuAdapter();
    if (!webgpu) {
      throw new Error('Transformers WebGPU runtime is unavailable');
    }
    if (!adapter) {
      throw new Error('Shared WebGPU adapter is unavailable');
    }
    // The build integration removes Transformers.js's deprecated adapter
    // preference assignment before this module is packaged.
    if (!webgpu.adapter) webgpu.adapter = adapter;

    const value = await pipeline(
      'automatic-speech-recognition',
      WORD_ALIGNER_MODEL,
      {
        revision: WORD_ALIGNER_REVISION,
        device: 'webgpu',
        dtype: {
          encoder_model: 'fp16',
          decoder_model_merged: 'fp16',
        },
        // The WebGPU provider intentionally assigns shape-only bookkeeping
        // nodes to CPU. Keep genuine errors while silencing that expected
        // session-creation warning in chrome://extensions.
        session_options: { logSeverityLevel: 3 },
        progress_callback: (info: unknown) => onProgress?.(progressLabel(info)),
      },
    );
    return value as unknown as SourceAligner;
  })
    .then((value) => {
      aligner = value;
      return value;
    })
    .catch((error) => {
      loading = null;
      throw error;
    });

  return loading;
}

function numericRow(tensor: TensorLike, label: string): number[] {
  const rows = tensor.tolist();
  if (!Array.isArray(rows) || !Array.isArray(rows[0])) {
    throw new Error(`Word alignment returned invalid ${label}`);
  }
  const result = rows[0].map(Number);
  if (!result.length || result.some((value) => !Number.isFinite(value))) {
    throw new Error(`Word alignment returned invalid ${label}`);
  }
  return result;
}

function whisperWordLanguage(language: string): string | undefined {
  if (language === 'ja') return 'japanese';
  return undefined;
}

function disposeAlignmentOutput(output: ForcedAlignmentOutput | null): void {
  if (!output) return;
  output.sequences?.dispose?.();
  for (const layers of output.cross_attentions ?? []) {
    for (const tensor of layers) tensor.dispose?.();
  }
  for (const tensor of Object.values(output.past_key_values ?? {})) {
    tensor.dispose?.();
  }
}

function sinc(value: number): number {
  if (Math.abs(value) < 1e-8) return 1;
  const angle = Math.PI * value;
  return Math.sin(angle) / angle;
}

/**
 * Band-limited Lanczos resampling. Keeping the complete waveform (including
 * leading silence) preserves the timestamp origin used by media.currentTime.
 */
export function resampleForAlignment(
  samples: Float32Array,
  sourceRate: number,
  targetRate = ALIGNER_SAMPLE_RATE,
): Float32Array {
  if (
    !samples.length ||
    !Number.isFinite(sourceRate) ||
    !Number.isFinite(targetRate) ||
    sourceRate <= 0 ||
    targetRate <= 0
  ) {
    return new Float32Array();
  }
  if (sourceRate === targetRate) return new Float32Array(samples);

  const outputLength = Math.max(
    1,
    Math.round((samples.length * targetRate) / sourceRate),
  );
  const output = new Float32Array(outputLength);
  const sourcePerOutput = sourceRate / targetRate;
  const cutoff = Math.min(1, targetRate / sourceRate);
  const lobes = 8;
  const radius = lobes / cutoff;

  for (let index = 0; index < outputLength; index++) {
    const center = index * sourcePerOutput;
    const first = Math.max(0, Math.ceil(center - radius));
    const last = Math.min(samples.length - 1, Math.floor(center + radius));
    let weighted = 0;
    let weightSum = 0;
    for (let sourceIndex = first; sourceIndex <= last; sourceIndex++) {
      const distance = sourceIndex - center;
      const scaled = distance * cutoff;
      const weight = cutoff * sinc(scaled) * sinc(scaled / lobes);
      weighted += samples[sourceIndex]! * weight;
      weightSum += weight;
    }
    output[index] =
      Math.abs(weightSum) > 1e-8 ? weighted / weightSum : 0;
  }
  return output;
}

function normalizedToken(value: string): string {
  return value
    .normalize('NFKD')
    .toLocaleLowerCase()
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function editDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;

  let previous = new Uint16Array(right.length + 1);
  let current = new Uint16Array(right.length + 1);
  for (let index = 0; index <= right.length; index++) previous[index] = index;

  for (let row = 1; row <= left.length; row++) {
    current[0] = row;
    for (let column = 1; column <= right.length; column++) {
      const substitution =
        previous[column - 1]! +
        (left.charCodeAt(row - 1) === right.charCodeAt(column - 1) ? 0 : 1);
      current[column] = Math.min(
        previous[column]! + 1,
        current[column - 1]! + 1,
        substitution,
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[right.length]!;
}

function tokenCost(source: string, recognized: string): number {
  const a = normalizedToken(source);
  const b = normalizedToken(recognized);
  if (!a.length || !b.length) return a === b ? 0 : 1;
  return editDistance(a, b) / Math.max(a.length, b.length);
}

function checkedRecognizedChunks(
  chunks: readonly RecognizedChunk[],
  audioDuration: number,
): RecognizedChunk[] {
  const out: RecognizedChunk[] = [];
  let previousStart = 0;
  for (const chunk of chunks) {
    const start = Number(chunk.timestamp?.[0]);
    const rawEnd = Number(chunk.timestamp?.[1]);
    if (!Number.isFinite(start) || !Number.isFinite(rawEnd)) continue;
    const text = chunk.text.trim();
    if (!normalizedToken(text)) continue;
    const safeStart = Math.max(previousStart, Math.min(audioDuration, start));
    const safeEnd = Math.max(safeStart, Math.min(audioDuration, rawEnd));
    out.push({ text, timestamp: [safeStart, safeEnd] });
    previousStart = safeStart;
  }
  return out;
}

/**
 * Monotonically assigns one or more acoustically timestamped Whisper words to
 * each displayed word. This handles spoken expansions such as "2026" while
 * retaining the model's real start/end boundaries.
 */
export function mapRecognizedWordCues(
  sourceText: string,
  recognizedInput: readonly RecognizedChunk[],
  audioDuration: number,
): WordCue[] {
  const source = tokenizeWords(sourceText);
  if (!source.length) return [];
  if (!Number.isFinite(audioDuration) || audioDuration <= 0) {
    throw new Error('Word alignment received invalid audio duration');
  }

  const recognized = checkedRecognizedChunks(recognizedInput, audioDuration);
  if (recognized.length < source.length) {
    throw new Error(
      `Word alignment incomplete (${recognized.length}/${source.length} words)`,
    );
  }

  const rows = source.length + 1;
  const columns = recognized.length + 1;
  const cost = Array.from(
    { length: rows },
    () => new Float64Array(columns).fill(Number.POSITIVE_INFINITY),
  );
  const previous = Array.from(
    { length: rows },
    () => new Int32Array(columns).fill(-1),
  );
  cost[0]![0] = 0;

  for (let sourceIndex = 0; sourceIndex < source.length; sourceIndex++) {
    const remainingSource = source.length - sourceIndex - 1;
    for (
      let recognizedStart = sourceIndex;
      recognizedStart < recognized.length;
      recognizedStart++
    ) {
      const base = cost[sourceIndex]![recognizedStart]!;
      if (!Number.isFinite(base)) continue;
      const maxTake =
        recognized.length - recognizedStart - remainingSource;
      let combined = '';
      for (let take = 1; take <= maxTake; take++) {
        combined += recognized[recognizedStart + take - 1]!.text;
        const next = recognizedStart + take;
        const candidate =
          base +
          tokenCost(source[sourceIndex]!, combined) +
          Math.max(0, take - 1) * 0.04;
        if (candidate < cost[sourceIndex + 1]![next]!) {
          cost[sourceIndex + 1]![next] = candidate;
          previous[sourceIndex + 1]![next] = recognizedStart;
        }
      }
    }
  }

  if (!Number.isFinite(cost[source.length]![recognized.length]!)) {
    throw new Error('Word alignment could not map the complete transcript');
  }

  const groups = new Array<[number, number]>(source.length);
  let end = recognized.length;
  for (let sourceIndex = source.length; sourceIndex > 0; sourceIndex--) {
    const start = previous[sourceIndex]![end]!;
    if (start < 0 || start >= end) {
      throw new Error('Word alignment produced an invalid path');
    }
    groups[sourceIndex - 1] = [start, end];
    end = start;
  }
  if (end !== 0) {
    throw new Error('Word alignment did not consume the complete transcript');
  }

  return groups.map(([start, groupEnd]) => {
    const first = recognized[start]!;
    const last = recognized[groupEnd - 1]!;
    return {
      start: first.timestamp[0],
      end: Math.max(first.timestamp[0], last.timestamp[1]),
    };
  });
}

/**
 * Cross-attention locates monotonic word boundaries. Trim only genuine
 * low-energy PCM at the edges of those boundaries so punctuation pauses hide
 * the pill instead of making the preceding word appear to last through them.
 */
export function trimWordCuesToSpeech(
  cues: readonly WordCue[],
  samples: Float32Array,
  sampleRate: number,
): WordCue[] {
  if (!cues.length || !samples.length || sampleRate <= 0) {
    return cues.map((cue) => ({ ...cue }));
  }

  const frameSize = Math.max(1, Math.round(sampleRate * 0.02));
  const hopSize = Math.max(1, Math.round(sampleRate * 0.01));
  const energy: number[] = [];
  let peakRms = 0;
  for (let start = 0; start < samples.length; start += hopSize) {
    const end = Math.min(samples.length, start + frameSize);
    let sum = 0;
    for (let index = start; index < end; index++) {
      const value = samples[index]!;
      sum += value * value;
    }
    const rms = Math.sqrt(sum / Math.max(1, end - start));
    energy.push(rms);
    peakRms = Math.max(peakRms, rms);
  }

  if (peakRms < 1e-5) return cues.map((cue) => ({ ...cue }));
  const threshold = Math.max(0.00035, peakRms * 0.035);
  const frameSeconds = frameSize / sampleRate;
  const hopSeconds = hopSize / sampleRate;
  const padding = 0.015;

  return cues.map((cue) => {
    const firstFrame = Math.max(0, Math.ceil(cue.start / hopSeconds));
    const lastFrame = Math.min(
      energy.length - 1,
      Math.max(
        firstFrame,
        Math.floor((cue.end - frameSeconds) / hopSeconds),
      ),
    );
    let firstActive = -1;
    let lastActive = -1;
    for (let frame = firstFrame; frame <= lastFrame; frame++) {
      if (energy[frame]! < threshold) continue;
      if (firstActive < 0) firstActive = frame;
      lastActive = frame;
    }
    if (firstActive < 0 || lastActive < firstActive) return { ...cue };

    const activeStart = Math.max(
      cue.start,
      firstActive * hopSeconds - padding,
    );
    const activeEnd = Math.min(
      cue.end,
      lastActive * hopSeconds + frameSeconds + padding,
    );
    const start =
      activeStart - cue.start >= 0.04 ? activeStart : cue.start;
    const end =
      cue.end - activeEnd >= 0.04 ? activeEnd : cue.end;
    if (end - start < 0.04) return { ...cue };
    return { start, end };
  });
}

export async function alignWordsToAudio(
  text: string,
  samples: Float32Array,
  sampleRate: number,
  language: string,
  onProgress?: (stage: string) => void,
): Promise<WordCue[]> {
  const words = tokenizeWords(text);
  if (!words.length) return [];
  if (!samples.length) throw new Error('Word alignment received empty audio');

  const audio = resampleForAlignment(samples, sampleRate);
  if (!audio.length) throw new Error('Word alignment could not resample audio');

  const audioDuration = samples.length / sampleRate;
  if (audioDuration >= 29.5) {
    throw new Error(
      `Word alignment audio exceeds Whisper's 30-second window (${audioDuration.toFixed(1)}s)`,
    );
  }

  const sourceAligner = await loadWordAligner(onProgress);
  const tokenized = sourceAligner.tokenizer(text, {
    add_special_tokens: false,
  });
  const textTokens = numericRow(tokenized.input_ids, 'source tokens');
  tokenized.input_ids.dispose?.();

  // OpenAI Whisper's forced word alignment runs one teacher-forced decoder
  // pass over [SOT, language, task, no-timestamps, known text, EOT]. This is
  // both deterministic and much faster than re-transcribing generated audio.
  const generationOptions: Record<string, unknown> = {
    language,
    task: 'transcribe',
    return_timestamps: false,
    output_attentions: true,
    return_dict_in_generate: true,
    max_new_tokens: 1,
  };
  const generationConfig =
    sourceAligner.model._prepare_generation_config(null, generationOptions);
  const initTokens =
    sourceAligner.model._retrieve_init_tokens(generationConfig);
  const eosToken = Number(generationConfig.eos_token_id);
  const alignmentHeads = generationConfig.alignment_heads;
  if (
    !initTokens.length ||
    !Number.isInteger(eosToken) ||
    !Array.isArray(alignmentHeads) ||
    !alignmentHeads.length
  ) {
    throw new Error('Word alignment model configuration is incomplete');
  }

  const processed = await sourceAligner.processor(audio);
  let output: ForcedAlignmentOutput | null = null;
  const slicedAttentions: TensorLike[][] = [];
  let boundaryTensor: TensorLike | null = null;
  try {
    output = await sourceAligner.model.generate({
      inputs: processed.input_features,
      generation_config: generationConfig,
      decoder_input_ids: [...initTokens, ...textTokens, eosToken],
      ...generationOptions,
    });
    if (!output.cross_attentions?.length) {
      throw new Error('Word alignment model returned no cross-attention');
    }

    // Cross-attention at the no-timestamps input predicts the first text
    // token. Keep that row through the last text token, matching Whisper's
    // official find_alignment() matrix construction.
    const tokenStart = initTokens.length - 1;
    const tokenEnd = tokenStart + textTokens.length + 1;
    for (const step of output.cross_attentions) {
      slicedAttentions.push(
        step.map((tensor) =>
          tensor.slice(null, null, [tokenStart, tokenEnd], null),
        ),
      );
    }

    // Transformers.js 3.x does not apply Whisper's encoder stride when
    // cropping num_frames. Pass the real 50 Hz encoder length explicitly.
    const encoderFrames = Math.max(
      1,
      Math.min(1500, Math.floor(audio.length / 320)),
    );
    boundaryTensor = sourceAligner.model._extract_token_timestamps(
      {
        sequences: { dims: [1, textTokens.length + 2] },
        cross_attentions: slicedAttentions,
      },
      alignmentHeads as number[][],
      encoderFrames,
    );
    const timestampRow = numericRow(boundaryTensor, 'token timestamps');
    const boundaries = timestampRow.slice(1, textTokens.length + 2);
    if (
      boundaries.length !== textTokens.length + 1 ||
      boundaries.some(
        (value, index) =>
          value < 0 ||
          value > audioDuration + 0.05 ||
          (index > 0 && value < boundaries[index - 1]!),
      )
    ) {
      throw new Error('Word alignment produced invalid token boundaries');
    }

    const tokenTimestamps = textTokens.map(
      (_, index) =>
        [
          Math.min(audioDuration, boundaries[index]!),
          Math.min(audioDuration, boundaries[index + 1]!),
        ] as [number, number],
    );
    const chunks = sourceAligner.tokenizer.collateWordTimestamps(
      textTokens,
      tokenTimestamps,
      whisperWordLanguage(language),
    );
    return trimWordCuesToSpeech(
      mapRecognizedWordCues(text, chunks, audioDuration),
      audio,
      ALIGNER_SAMPLE_RATE,
    );
  } finally {
    processed.input_features.dispose?.();
    boundaryTensor?.dispose?.();
    for (const step of slicedAttentions) {
      for (const tensor of step) tensor.dispose?.();
    }
    disposeAlignmentOutput(output);
  }
}
