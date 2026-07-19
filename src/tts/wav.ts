/**
 * Encode mono Float32 PCM as a WAV Blob URL for HTMLAudioElement playback.
 * Used so we can set preservesPitch (tempo without pitch shift).
 */

export function pcmToWavUrl(samples: Float32Array, sampleRate: number): string {
  const rate =
    Number.isFinite(sampleRate) && sampleRate >= 8000 && sampleRate <= 96000
      ? sampleRate
      : 44_100;
  const n = samples.length;
  const bytes = new ArrayBuffer(44 + n * 2);
  const view = new DataView(bytes);

  writeStr(view, 0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  writeStr(view, 8, 'WAVE');
  writeStr(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits
  writeStr(view, 36, 'data');
  view.setUint32(40, n * 2, true);

  let o = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    o += 2;
  }

  return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
}

function writeStr(view: DataView, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) {
    view.setUint8(offset + i, s.charCodeAt(i));
  }
}

export function applyPreservesPitch(audio: HTMLAudioElement): void {
  audio.preservesPitch = true;
  const any = audio as HTMLAudioElement & {
    mozPreservesPitch?: boolean;
    webkitPreservesPitch?: boolean;
  };
  any.mozPreservesPitch = true;
  any.webkitPreservesPitch = true;
}

/**
 * Apply both media-rate properties after assigning the source. Chromium may
 * restore playbackRate from defaultPlaybackRate when a new resource loads.
 */
export function applyMediaPlaybackRate(
  audio: HTMLAudioElement,
  value: number,
): void {
  const rate = Number.isFinite(value)
    ? Math.min(1.5, Math.max(0.5, value))
    : 1;
  applyPreservesPitch(audio);
  audio.defaultPlaybackRate = rate;
  audio.playbackRate = rate;
}
