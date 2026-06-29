// Browser-side audio decoding + slicing so the workflow can cut the (possibly
// enhanced) working audio into per-segment WAV clips without any server round-trip.

export interface DecodedAudio {
  sampleRate: number;
  data: Float32Array; // mono
  duration: number;
}

export async function decodeAudio(blob: Blob): Promise<DecodedAudio> {
  const arrayBuf = await blob.arrayBuffer();
  const AC: typeof AudioContext =
    (window as any).AudioContext || (window as any).webkitAudioContext;
  const ctx = new AC();
  try {
    const audioBuf = await ctx.decodeAudioData(arrayBuf.slice(0));
    const ch = audioBuf.numberOfChannels;
    const len = audioBuf.length;
    const mono = new Float32Array(len);
    for (let c = 0; c < ch; c++) {
      const d = audioBuf.getChannelData(c);
      for (let i = 0; i < len; i++) mono[i] += d[i] / ch;
    }
    return { sampleRate: audioBuf.sampleRate, data: mono, duration: audioBuf.duration };
  } finally {
    ctx.close();
  }
}

// Encode a [start,end] (seconds) slice to a 16k mono PCM WAV Blob.
export function sliceWav(dec: DecodedAudio, start: number, end: number, targetRate = 16000): Blob {
  const srcRate = dec.sampleRate;
  const s = Math.max(0, Math.floor(start * srcRate));
  const e = Math.min(dec.data.length, Math.ceil(end * srcRate));
  const srcSlice = dec.data.subarray(s, Math.max(s, e));
  const resampled = resample(srcSlice, srcRate, targetRate);
  return encodeWav(resampled, targetRate);
}

function resample(data: Float32Array, from: number, to: number): Float32Array {
  if (from === to || data.length === 0) return data;
  const ratio = to / from;
  const outLen = Math.max(1, Math.round(data.length * ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(data.length - 1, i0 + 1);
    const frac = srcPos - i0;
    out[i] = data[i0] * (1 - frac) + data[i1] * frac;
  }
  return out;
}

function encodeWav(samples: Float32Array, rate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    off += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

// Concatenate several mono PCM clips into one WAV (used to reassemble chunked
// enhance output into a single track). A short linear fade at each join suppresses
// boundary clicks. Assumes a common sample rate (the enhancer emits 16k mono).
export function concatToWav(parts: { data: Float32Array; sampleRate: number }[], fadeMs = 5): Blob {
  if (!parts.length) return encodeWav(new Float32Array(0), 16000);
  const rate = parts[0].sampleRate;
  const fade = Math.max(0, Math.floor((fadeMs / 1000) * rate));
  const total = parts.reduce((n, p) => n + p.data.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (let pi = 0; pi < parts.length; pi++) {
    const d = parts[pi].data;
    out.set(d, off);
    const f = Math.min(fade, d.length);
    if (pi > 0) for (let i = 0; i < f; i++) out[off + i] *= i / f; // fade-in (not first)
    if (pi < parts.length - 1) for (let i = 0; i < f; i++) out[off + d.length - 1 - i] *= i / f; // fade-out (not last)
    off += d.length;
  }
  return encodeWav(out, rate);
}

// Run an async mapper with bounded concurrency, preserving input order.
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const cur = i++;
      out[cur] = await fn(items[cur], cur);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
