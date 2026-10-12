// Whisper's input: an 80-band log-mel spectrogram of 30 s of 16 kHz audio (3000 frames, 10 ms apart), exactly as
// OpenAI's and Hugging Face's feature extractors compute it (periodic Hann window of 400, hop 160, centred frames with
// reflection padding, Slaney mel filters, log10, clamped to 8 below the peak, then scaled). Shorter audio is padded
// with silence; frames that only see the padding are filled in without computing them. No DOM: runs in a worker and Node.

export const WHISPER_RATE = 16000
export const N_FFT = 400
export const HOP = 160
export const N_MELS = 80
export const FRAMES = 3000
export const MAX_SAMPLES = FRAMES * HOP // 30 s
const BINS = N_FFT / 2 + 1 // 201

const hzToMel = (f: number) => (f < 1000 ? (3 * f) / 200 : 15 + (27 * Math.log(f / 1000)) / Math.log(6.4))
const melToHz = (m: number) => (m < 15 ? (200 * m) / 3 : 1000 * Math.exp(((m - 15) * Math.log(6.4)) / 27))

/** Slaney-style triangular mel filters, normalised by width: [N_MELS][BINS]. */
export function melFilters(): Float32Array {
  const lo = hzToMel(0)
  const hi = hzToMel(WHISPER_RATE / 2)
  const edges = Array.from({ length: N_MELS + 2 }, (_, i) => melToHz(lo + ((hi - lo) * i) / (N_MELS + 1)))
  const out = new Float32Array(N_MELS * BINS)
  for (let m = 0; m < N_MELS; m++) {
    const enorm = 2 / (edges[m + 2] - edges[m])
    for (let k = 0; k < BINS; k++) {
      const f = (k * WHISPER_RATE) / N_FFT
      const down = (f - edges[m]) / (edges[m + 1] - edges[m])
      const up = (edges[m + 2] - f) / (edges[m + 2] - edges[m + 1])
      out[m * BINS + k] = Math.max(0, Math.min(down, up)) * enorm
    }
  }
  return out
}

let tables: { cos: Float32Array; sin: Float32Array; window: Float32Array; filters: Float32Array; firstBin: Int16Array; lastBin: Int16Array } | null = null

function setup() {
  if (tables) return tables
  const cos = new Float32Array(N_FFT)
  const sin = new Float32Array(N_FFT)
  for (let i = 0; i < N_FFT; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / N_FFT)
    sin[i] = Math.sin((2 * Math.PI * i) / N_FFT)
  }
  const window = new Float32Array(N_FFT)
  for (let i = 0; i < N_FFT; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT)
  const filters = melFilters()
  // Each filter only covers a few bins: skip the zeros.
  const firstBin = new Int16Array(N_MELS)
  const lastBin = new Int16Array(N_MELS)
  for (let m = 0; m < N_MELS; m++) {
    let a = BINS
    let b = -1
    for (let k = 0; k < BINS; k++) {
      if (filters[m * BINS + k] > 0) {
        a = Math.min(a, k)
        b = k
      }
    }
    firstBin[m] = a
    lastBin[m] = b
  }
  tables = { cos, sin, window, filters, firstBin, lastBin }
  return tables
}

/**
 * Log-mel features for `audio` (16 kHz mono, at most 30 s; longer is cut): [N_MELS][FRAMES], ready for the encoder.
 * `out` can be passed in to reuse it.
 */
export function logMel(audio: Float32Array, out = new Float32Array(N_MELS * FRAMES)): Float32Array {
  const { cos, sin, window, filters, firstBin, lastBin } = setup()
  const n = Math.min(audio.length, MAX_SAMPLES)
  const pad = N_FFT / 2
  // The sample at padded position p (reflection at the start; the 30 s are zero beyond the audio, and the padding
  // past 30 s reflects zeros too).
  const sample = (i: number): number => {
    if (i < 0) i = -i
    if (i >= MAX_SAMPLES) i = 2 * (MAX_SAMPLES - 1) - i
    return i < n ? audio[i] : 0
  }
  // Frames whose window only covers silence: computed below as a constant.
  const live = Math.min(FRAMES, Math.ceil((n + pad) / HOP) + 1)
  const frame = new Float32Array(N_FFT)
  const power = new Float32Array(BINS)
  let peak = -Infinity
  for (let t = 0; t < live; t++) {
    const start = t * HOP - pad
    for (let i = 0; i < N_FFT; i++) frame[i] = sample(start + i) * window[i]
    for (let k = 0; k < BINS; k++) {
      let re = 0
      let im = 0
      let idx = 0
      for (let i = 0; i < N_FFT; i++) {
        const x = frame[i]
        re += x * cos[idx]
        im -= x * sin[idx]
        idx += k
        if (idx >= N_FFT) idx -= N_FFT
      }
      power[k] = re * re + im * im
    }
    for (let m = 0; m < N_MELS; m++) {
      let sum = 0
      const row = m * BINS
      for (let k = firstBin[m]; k <= lastBin[m]; k++) sum += filters[row + k] * power[k]
      const v = Math.log10(Math.max(sum, 1e-10))
      out[m * FRAMES + t] = v
      if (v > peak) peak = v
    }
  }
  if (live < FRAMES) peak = Math.max(peak, -10)
  const floor = peak - 8
  for (let m = 0; m < N_MELS; m++) {
    const row = m * FRAMES
    for (let t = 0; t < FRAMES; t++) {
      const v = t < live ? out[row + t] : -10
      out[row + t] = (Math.max(v, floor) + 4) / 4
    }
  }
  return out
}
