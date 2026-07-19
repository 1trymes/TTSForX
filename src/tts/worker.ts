/// <reference lib="webworker" />
/**
 * Supertonic 3 WebGPU worker.
 *
 * Production backend: the four official Supertone/supertonic-3 ONNX graphs.
 * There is no alternate model or execution-provider fallback.
 */
import { debugHandledFailure } from '../diagnostics';
import { chunkTextForTts } from './chunkText';
import { normalizeTtsLanguage } from './languages';
import { normalizeGenerationSteps } from './quality';
import {
  loadSupertonic3,
  SUPERTONIC3_LANGUAGE,
  SUPERTONIC3_REVISION,
  type Supertonic3,
} from './supertonic3';
import { ALL_VOICE_IDS, DEFAULT_VOICE } from './voices';
import {
  alignWordsToAudio,
  loadWordAligner,
  WORD_ALIGNER_MODEL,
} from './wordAlignment';
import type { WordCue } from './karaokeCues';

const DEVICE = 'webgpu' as const;
const MODEL = `Supertone/supertonic-3@${SUPERTONIC3_REVISION.slice(0, 8)}`;

let tts: Supertonic3 | null = null;
let loadingPromise: Promise<Supertonic3> | null = null;
let fullLoadingPromise: Promise<void> | null = null;
let fullyReady = false;

/** Incremented by cancel/new generate; only the latest epoch may emit audio. */
let generationEpoch = 0;
/** Serialize jobs without blocking cancel messages between WebGPU graph runs. */
let workChain: Promise<void> = Promise.resolve();

type MsgOut =
  | { type: 'loading'; device: string; model: string; stage?: string }
  | { type: 'ready'; device: string; model: string }
  | {
      type: 'audio-chunk';
      id: number;
      index: number;
      total: number;
      text: string;
      samples: Float32Array;
      sampleRate: number;
      length: number;
      wordCues: WordCue[];
    }
  | {
      type: 'audio-done';
      id: number;
      complete: boolean;
      nextChunk: number;
      total: number;
    }
  | { type: 'error'; id?: number; message: string };

function send(msg: MsgOut, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(msg, transfer);
}

function cancelled(epoch: number): boolean {
  return epoch !== generationEpoch;
}

function throwIfCancelled(epoch: number): void {
  if (cancelled(epoch)) throw new Error('cancelled');
}

function load(): Promise<Supertonic3> {
  if (tts) return Promise.resolve(tts);
  if (loadingPromise) return loadingPromise;

  send({ type: 'loading', device: DEVICE, model: MODEL });
  loadingPromise = loadSupertonic3((name, current, total) => {
    send({
      type: 'loading',
      device: DEVICE,
      model: MODEL,
      stage: `${current}/${total} ${name}`,
    });
  })
    .then(async (model) => {
      // All ten official styles total only a few MB. Persist and materialize
      // them during background warm-up so changing voice never adds a click-
      // time network request or JSON-to-tensor conversion.
      await Promise.all(ALL_VOICE_IDS.map((voice) => model.loadStyle(voice)));
      tts = model;
      return model;
    })
    .catch((error: unknown) => {
      loadingPromise = null;
      throw error;
    });

  return loadingPromise;
}

function loadAll(): Promise<void> {
  if (fullyReady) return Promise.resolve();
  if (fullLoadingPromise) return fullLoadingPromise;

  fullLoadingPromise = (async () => {
    await load();
    await loadWordAligner((stage) => {
      send({
        type: 'loading',
        device: DEVICE,
        model: WORD_ALIGNER_MODEL,
        stage,
      });
    });
    fullyReady = true;
    send({ type: 'ready', device: DEVICE, model: MODEL });
  })().catch((error: unknown) => {
    fullLoadingPromise = null;
    send({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  });

  return fullLoadingPromise;
}

function peakOk(samples: Float32Array): boolean {
  let peak = 0;
  const step = Math.max(1, (samples.length / 200) | 0);
  for (let i = 0; i < samples.length; i += step) {
    const value = Math.abs(samples[i]!);
    if (value > peak) peak = value;
  }
  return peak > 1e-5 && Number.isFinite(peak);
}

async function runGenerate(msg: {
  id: number;
  text: string;
  voice: string;
  language: string;
  steps: number;
  startChunk: number;
  maxChunks: number | null;
  epoch: number;
}): Promise<void> {
  const { id, text, voice, language, steps, startChunk, maxChunks, epoch } = msg;
  if (!text.trim()) {
    send({ type: 'error', id, message: 'No text to read.' });
    return;
  }

  throwIfCancelled(epoch);
  await loadAll();
  const model = tts;
  if (!model) throw new Error('TTS model is not ready');
  const style = await model.loadStyle(voice);
  throwIfCancelled(epoch);

  const chunks = chunkTextForTts(text, language);
  if (!chunks.length) {
    send({ type: 'error', id, message: 'No text to read.' });
    return;
  }

  const end =
    maxChunks != null
      ? Math.min(chunks.length, startChunk + maxChunks)
      : chunks.length;

  for (let index = startChunk; index < end; index++) {
    throwIfCancelled(epoch);
    const chunkText = chunks[index]!;
    const audio = await model.synthesize(chunkText, style, {
      language,
      steps,
      speed: 1.05,
      cancelled: () => cancelled(epoch),
    });
    throwIfCancelled(epoch);

    if (!audio.samples.length || !peakOk(audio.samples)) {
      send({
        type: 'error',
        id,
        message: `Chunk ${index + 1}/${chunks.length} produced empty audio`,
      });
      return;
    }

    const samples = audio.samples;
    const wordCues = await alignWordsToAudio(
      chunkText,
      samples,
      audio.sampleRate,
      language,
      (stage) => {
        send({
          type: 'loading',
          device: DEVICE,
          model: WORD_ALIGNER_MODEL,
          stage,
        });
      },
    );
    throwIfCancelled(epoch);
    send(
      {
        type: 'audio-chunk',
        id,
        index,
        total: chunks.length,
        text: chunkText,
        samples,
        sampleRate: audio.sampleRate,
        length: samples.length,
        wordCues,
      },
      [samples.buffer as ArrayBuffer],
    );
  }

  throwIfCancelled(epoch);
  send({
    type: 'audio-done',
    id,
    complete: end >= chunks.length,
    nextChunk: end,
    total: chunks.length,
  });
}

function enqueueWork(fn: () => Promise<void>): void {
  workChain = workChain.then(fn).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'cancelled') return;
    debugHandledFailure('Supertonic 3 worker job failed', error);
  });
}

self.onmessage = (event: MessageEvent) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'cancel') {
    generationEpoch++;
    return;
  }

  if (msg.type === 'load') {
    enqueueWork(loadAll);
    return;
  }

  if (msg.type !== 'generate') return;

  const epoch = ++generationEpoch;
  const id = Number(msg.id);
  const voice =
    typeof msg.voice === 'string' && ALL_VOICE_IDS.includes(msg.voice)
      ? msg.voice
      : DEFAULT_VOICE;
  const job = {
    id,
    text: String(msg.text ?? ''),
    voice,
    language: normalizeTtsLanguage(msg.language ?? SUPERTONIC3_LANGUAGE),
    steps: normalizeGenerationSteps(msg.steps),
    startChunk: Math.max(0, Number(msg.startChunk) || 0),
    maxChunks:
      msg.maxChunks != null && Number(msg.maxChunks) > 0
        ? Number(msg.maxChunks)
        : null,
    epoch,
  };

  enqueueWork(async () => {
    if (cancelled(epoch)) {
      send({ type: 'error', id, message: 'cancelled' });
      return;
    }
    try {
      await runGenerate(job);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send({ type: 'error', id, message });
    }
  });
};
