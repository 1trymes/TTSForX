/**
 * Compact PCM transport for Chromium extension ports.
 *
 * Chromium runtime messaging JSON-serializes values, so Float32Array either
 * loses its payload or expands into an enormous object/number array. Audio is
 * ultimately written to a 16-bit WAV; transporting the same signed PCM format
 * as base64 keeps messages compact without adding another quantization step.
 */

const BINARY_CHUNK_BYTES = 0x8000;

export function encodePcm16Base64(samples: Float32Array): string {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]!));
    pcm[i] = value < 0 ? Math.round(value * 32_768) : Math.round(value * 32_767);
  }

  const bytes = new Uint8Array(pcm.buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BINARY_CHUNK_BYTES) {
    const part = bytes.subarray(
      offset,
      Math.min(bytes.length, offset + BINARY_CHUNK_BYTES),
    );
    binary += String.fromCharCode(...part);
  }
  return btoa(binary);
}

export function decodePcm16Base64(encoded: string): Float32Array {
  if (!encoded) return new Float32Array();

  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    return new Float32Array();
  }
  if (binary.length === 0 || binary.length % 2 !== 0) {
    return new Float32Array();
  }

  const out = new Float32Array(binary.length / 2);
  for (let i = 0; i < out.length; i++) {
    const lo = binary.charCodeAt(i * 2);
    const hi = binary.charCodeAt(i * 2 + 1);
    let value = lo | (hi << 8);
    if (value & 0x8000) value -= 0x1_0000;
    out[i] = value < 0 ? value / 32_768 : value / 32_767;
  }
  return out;
}
