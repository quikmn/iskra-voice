// Offline measurements of the voice chain: runs real audio through the same code the worklets run (DeepFilterNet3,
// the input-volume stage, Silero VAD and its gate, the receiver's leveler) in 128-sample blocks at 48 kHz, and
// compares what comes out with what went in. Used by quality.test.ts (thresholds) and scripts/audio-quality.mjs
// (the table in docs/voice-processing.md). No DOM, no Node APIs: callers pass the files in.
import { df_create, df_process_frame, initSync } from '../../../vendor/deepfilternet/deepfilter.js'
import { createDeepFilter } from './strength'
import { Framer } from './framer'
import { Leveler, Limiter, SEND_CEILING } from './leveler'
import { Downsampler } from './resample'
import { parseOnnxWeights, SILERO_FRAME, SILERO_RATE, SileroVad } from './silero'
import { VadGate } from './vadGate'
import { Gate } from '../micGate'

export const RATE = 48000
const BLOCK = 128

// ── Signals ──────────────────────────────────────────────────────────────

/** 16-bit mono PCM from a WAV file. */
export function readWav(bytes: ArrayBuffer): { rate: number; pcm: Float32Array } {
  const view = new DataView(bytes)
  let o = 12
  let rate = 0
  while (o + 8 <= view.byteLength) {
    const id = String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3))
    const size = view.getUint32(o + 4, true)
    if (id === 'fmt ') rate = view.getUint32(o + 12, true)
    if (id === 'data') {
      const pcm = new Float32Array(size / 2)
      for (let i = 0; i < pcm.length; i++) pcm[i] = view.getInt16(o + 8 + i * 2, true) / 32768
      return { rate, pcm }
    }
    o += 8 + size
  }
  throw new Error('no data')
}

/** Band-limited (windowed-sinc) upsampling by an integer factor, so the test signal has no imaging. */
export function upsample(x: Float32Array, factor: number, taps = 32): Float32Array {
  const out = new Float32Array(x.length * factor)
  for (let n = 0; n < out.length; n++) {
    const p = n / factor
    const c = Math.floor(p)
    let acc = 0
    for (let k = c - taps + 1; k <= c + taps; k++) {
      if (k < 0 || k >= x.length) continue
      const d = p - k
      const sinc = d === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d)
      const w = 0.5 + 0.5 * Math.cos((Math.PI * d) / (taps + 1))
      acc += x[k] * sinc * w
    }
    out[n] = acc
  }
  return out
}

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32
  }
}

/** Pink noise (Paul Kellet's filter) at `db` dBFS RMS: a fan or air conditioning. */
export function pinkNoise(n: number, db: number, seed = 1): Float32Array {
  const r = rng(seed)
  const out = new Float32Array(n)
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0
  for (let i = 0; i < n; i++) {
    const w = r() * 2 - 1
    b0 = 0.99886 * b0 + w * 0.0555179
    b1 = 0.99332 * b1 + w * 0.0750759
    b2 = 0.969 * b2 + w * 0.153852
    b3 = 0.8665 * b3 + w * 0.3104856
    b4 = 0.55 * b4 + w * 0.5329522
    b5 = -0.7616 * b5 - w * 0.016898
    out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362
    b6 = w * 0.115926
  }
  return scaleTo(out, db)
}

/** Keyboard clicks: short decaying bursts of bright noise, a few per second, peaking around `peakDb`. */
export function keyboard(n: number, rate: number, peakDb: number, seed = 2): Float32Array {
  const r = rng(seed)
  const out = new Float32Array(n)
  const peak = Math.pow(10, peakDb / 20)
  let t = Math.floor(r() * 0.2 * rate)
  while (t < n) {
    const amp = peak * (0.5 + 0.5 * r())
    const len = Math.floor(0.012 * rate)
    let prev = 0
    for (let i = 0; i < len && t + i < n; i++) {
      const w = r() * 2 - 1
      const hp = w - prev // brighter
      prev = w
      out[t + i] += amp * hp * 0.5 * Math.exp(-i / (0.002 * rate))
    }
    t += Math.floor((0.08 + r() * 0.25) * rate)
  }
  return out
}

export function rmsDb(x: Float32Array, from = 0, to = x.length): number {
  let s = 0
  for (let i = from; i < to; i++) s += x[i] * x[i]
  return 10 * Math.log10(Math.max(1e-20, s / Math.max(1, to - from)))
}

function scaleTo(x: Float32Array, db: number): Float32Array {
  const g = Math.pow(10, (db - rmsDb(x)) / 20)
  for (let i = 0; i < x.length; i++) x[i] *= g
  return x
}

export function mix(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts[0].length)
  for (const p of parts) for (let i = 0; i < out.length; i++) out[i] += p[i] ?? 0
  return out
}

export function gain(x: Float32Array, db: number): Float32Array {
  const g = Math.pow(10, db / 20)
  return x.map((v) => v * g)
}

// ── The chain ────────────────────────────────────────────────────────────

export interface Engines {
  /**
   * A fresh DeepFilterNet3 state with this attenuation limit (dB; 100 = none), as a frame function. `legacy`: libDF's
   * own thresholds, as before they were set (for before/after numbers).
   */
  deepFilter(attenLimDb: number, legacy?: boolean): (frame: Float32Array) => Float32Array
  /** A fresh Silero VAD. */
  silero(): SileroVad
}

/** Loads the bundled engines from their bytes. */
export function loadEngines(deepFilterWasm: BufferSource, deepFilterModel: ArrayBuffer, sileroModel: ArrayBuffer): Engines {
  initSync({ module: deepFilterWasm })
  const weights = parseOnnxWeights(sileroModel)
  return {
    deepFilter(attenLimDb, legacy) {
      const bytes = new Uint8Array(deepFilterModel)
      const state = legacy ? df_create(bytes, attenLimDb) : createDeepFilter(bytes, attenLimDb)
      return (frame) => df_process_frame(state, frame)
    },
    silero: () => new SileroVad(weights),
  }
}

export interface ChainOptions {
  /** DeepFilterNet3 on the mic with this attenuation limit (dB); null: no noise removal. */
  deepFilter: number | null
  /** DeepFilterNet with libDF's own thresholds (how it ran before). */
  legacyThresholds?: boolean
  /** Silero's gate on the mic (automatic sensitivity); false = push-to-talk (never gated). */
  gate: boolean
  /** The listener's "Even out voices". */
  leveler: boolean
  /** Input volume (0–2). */
  inputVolume?: number
  /** Other implementations of the gate and the leveler (earlier versions, for before/after numbers). */
  impl?: { VadGate?: typeof VadGate; Leveler?: typeof Leveler }
}

export interface ChainRun {
  /** What's sent (after the mic path). */
  sent: Float32Array
  /** What the listener hears (after leveling, if on). */
  heard: Float32Array
  /** The gate's state per 128-sample block. */
  open: Uint8Array
}

/** Runs `input` (48 kHz) through the chain block by block, the way the worklets do. */
export function runChain(input: Float32Array, engines: Engines, opts: ChainOptions): ChainRun {
  const blocks = Math.floor(input.length / BLOCK)
  const sent = new Float32Array(blocks * BLOCK)
  const heard = new Float32Array(blocks * BLOCK)
  const open = new Uint8Array(blocks)
  const framer = opts.deepFilter === null ? null : new Framer(480, RATE, engines.deepFilter(opts.deepFilter, opts.legacyThresholds))
  const level = new Gate(RATE)
  level.params = { gain: opts.inputVolume ?? 1, threshold: -50, gating: false }
  const vadGate = new (opts.impl?.VadGate ?? VadGate)(RATE)
  vadGate.params = { ...vadGate.params, gating: opts.gate }
  const vad = engines.silero()
  const down = new Downsampler(RATE, SILERO_RATE, SILERO_FRAME, (frame) => vadGate.setProbability(vad.process(frame)))
  const leveler = opts.leveler ? new (opts.impl?.Leveler ?? Leveler)(RATE) : null
  const limiter = opts.impl ? null : new Limiter(RATE, SEND_CEILING)
  const a = new Float32Array(BLOCK)
  const b = new Float32Array(BLOCK)
  const c = new Float32Array(BLOCK)
  for (let k = 0; k < blocks; k++) {
    const block = input.subarray(k * BLOCK, (k + 1) * BLOCK)
    if (framer) framer.push(block, a)
    else a.set(block)
    level.process(a, b)
    down.push(b)
    vadGate.process(b, c)
    if (limiter) for (let i = 0; i < BLOCK; i++) c[i] = limiter.step(c[i])
    open[k] = vadGate.open ? 1 : 0
    sent.set(c, k * BLOCK)
    if (leveler) {
      leveler.process(c, a)
      heard.set(a, k * BLOCK)
    } else heard.set(c, k * BLOCK)
  }
  return { sent, heard, open }
}

// ── Metrics ──────────────────────────────────────────────────────────────

/**
 * The e2e speech fixture is a real recording: it opens with a second of room noise (about -28 dBFS) and has a noise
 * floor around -42 dBFS between words. Speech is judged from here on, and only where it's well above that floor.
 */
export const SPEECH_FROM_S = 1
/** 10 ms frames where `ref` is speech, from SPEECH_FROM_S on: louder than `floorDb`, widened by `widen` frames. */
export function voicedFrames(ref: Float32Array, floorDb = -45, widen = 5, frame = RATE / 100): Uint8Array {
  const n = Math.floor(ref.length / frame)
  const raw = new Uint8Array(n)
  for (let f = Math.round(SPEECH_FROM_S * 100); f < n; f++) raw[f] = rmsDb(ref, f * frame, (f + 1) * frame) > floorDb ? 1 : 0
  const out = new Uint8Array(n)
  for (let f = 0; f < n; f++) if (raw[f]) for (let d = -widen; d <= widen; d++) if (f + d >= 0 && f + d < n) out[f + d] = 1
  return out
}

/** The gain (out/in, dB) per 10 ms frame of speech: its median and its 5th percentile (the parts turned down most). */
export function speechGain(ref: Float32Array, out: Float32Array, lag: number, speech: Uint8Array): { median: number; p5: number } {
  const frame = RATE / 100
  const gains: number[] = []
  for (let f = 0; f < speech.length; f++) {
    const from = f * frame
    if (!speech[f] || from + lag + frame > out.length) continue
    gains.push(rmsDb(out, from + lag, from + lag + frame) - rmsDb(ref, from, from + frame))
  }
  gains.sort((a, b) => a - b)
  const at = (p: number) => gains[Math.floor(p * (gains.length - 1))] ?? 0
  return { median: at(0.5), p5: at(0.05) }
}

function decimate(x: Float32Array, by: number): Float32Array {
  const out = new Float32Array(Math.floor(x.length / by))
  for (let i = 0; i < out.length; i++) {
    let s = 0
    for (let j = 0; j < by; j++) s += x[i * by + j]
    out[i] = s / by
  }
  return out
}

function bestLag(ref: Float32Array, out: Float32Array, from: number, to: number, minLag: number, maxLag: number, step = 1): { lag: number; corr: number } {
  let best = minLag
  let bestC = -Infinity
  let refE = 0
  for (let i = from; i < to; i++) refE += ref[i] * ref[i]
  for (let lag = minLag; lag <= maxLag; lag += step) {
    let c = 0
    let e = 0
    for (let i = from; i < to; i++) {
      const y = out[i + lag] ?? 0
      c += ref[i] * y
      e += y * y
    }
    const norm = c / Math.sqrt(Math.max(1e-20, refE * e))
    if (norm > bestC) {
      bestC = norm
      best = lag
    }
  }
  return { lag: best, corr: bestC }
}

/** The output's delay against the input (samples), from cross-correlation: coarse at 6 kHz, then exact. */
export function findLag(ref: Float32Array, out: Float32Array, maxMs = 400, from = 0, to = ref.length): { lag: number; corr: number } {
  const by = 8
  const r = decimate(ref, by)
  const o = decimate(out, by)
  const coarse = bestLag(r, o, Math.floor(from / by), Math.floor(Math.min(to, ref.length - (maxMs * RATE) / 1000) / by), 0, Math.round((maxMs * RATE) / 1000 / by))
  const end = Math.min(to, out.length - coarse.lag * by - 2 * by)
  return bestLag(ref, out, from, end, Math.max(0, coarse.lag * by - 2 * by), coarse.lag * by + 2 * by)
}

/** Scale-invariant signal-to-distortion ratio (dB) of `out` (already aligned) against `ref`, over the voiced frames. */
export function siSdr(ref: Float32Array, out: Float32Array, lag: number, voiced?: Uint8Array): number {
  const frame = RATE / 100
  let dot = 0
  let rr = 0
  const use = (i: number) => !voiced || voiced[Math.floor(i / frame)] === 1
  for (let i = 0; i + lag < out.length && i < ref.length; i++) {
    if (!use(i)) continue
    dot += ref[i] * out[i + lag]
    rr += ref[i] * ref[i]
  }
  const a = dot / Math.max(1e-20, rr)
  let t = 0
  let e = 0
  for (let i = 0; i + lag < out.length && i < ref.length; i++) {
    if (!use(i)) continue
    const target = a * ref[i]
    t += target * target
    const d = out[i + lag] - target
    e += d * d
  }
  return 10 * Math.log10(Math.max(1e-20, t) / Math.max(1e-20, e))
}

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k)
        const wi = Math.sin(ang * k)
        const xr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi
        const xi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr
        re[i + k + len / 2] = re[i + k] - xr
        im[i + k + len / 2] = im[i + k] - xi
        re[i + k] += xr
        im[i + k] += xi
      }
    }
  }
}

/**
 * Log-spectral distance (dB) between `ref` and the aligned `out`, over voiced 1024-sample frames and 100 Hz–7.5 kHz
 * (what the fixture holds), both scaled to the same overall level first.
 */
export function logSpectralDistance(ref: Float32Array, out: Float32Array, lag: number, voiced: Uint8Array): number {
  const N = 1024
  const hop = 512
  const lo = Math.ceil((100 * N) / RATE)
  const hi = Math.floor((7500 * N) / RATE)
  const scale = Math.pow(10, (rmsDb(ref) - rmsDb(out.subarray(lag))) / 20)
  const win = new Float64Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N))
  const spec = (x: Float32Array, at: number, g: number) => {
    const re = new Float64Array(N)
    const im = new Float64Array(N)
    for (let i = 0; i < N; i++) re[i] = (x[at + i] ?? 0) * g * win[i]
    fft(re, im)
    const p = new Float64Array(hi - lo + 1)
    for (let k = lo; k <= hi; k++) p[k - lo] = 10 * Math.log10(re[k] * re[k] + im[k] * im[k] + 1e-9)
    return p
  }
  let total = 0
  let frames = 0
  for (let at = 0; at + N + lag <= out.length && at + N <= ref.length; at += hop) {
    if (!voiced[Math.floor((at + N / 2) / (RATE / 100))]) continue
    const a = spec(ref, at, 1)
    const b = spec(out, at + lag, scale)
    let s = 0
    for (let k = 0; k < a.length; k++) s += (a[k] - b[k]) ** 2
    total += Math.sqrt(s / a.length)
    frames++
  }
  return frames ? total / frames : 0
}

/** Samples at or beyond full scale (they'd clip when converted to 16 bits). */
export function clipped(x: Float32Array): number {
  let n = 0
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) >= 32767 / 32768) n++
  return n
}

/**
 * How much the level the chain applies moves around while someone talks: the gain (out/in, dB) per 10 ms frame over
 * voiced frames. Returns its frame-to-frame change: RMS and the largest step (dB per 10 ms).
 */
export function gainMotion(ref: Float32Array, out: Float32Array, lag: number, voiced: Uint8Array): { rms: number; max: number } {
  const frame = RATE / 100
  let prev: number | null = null
  let s = 0
  let n = 0
  let max = 0
  for (let f = 0; f < voiced.length; f++) {
    const from = f * frame
    if (!voiced[f] || from + frame + lag > out.length) {
      prev = null
      continue
    }
    const g = rmsDb(out, from + lag, from + lag + frame) - rmsDb(ref, from, from + frame)
    if (prev !== null) {
      const d = g - prev
      s += d * d
      n++
      max = Math.max(max, Math.abs(d))
    }
    prev = g
  }
  return { rms: n ? Math.sqrt(s / n) : 0, max }
}

/**
 * Timing: the delay measured locally (200 ms windows of speech) along the run. If the chain never drops or repeats
 * audio it stays the same; the spread is how much audio went missing (or came twice) while someone talked.
 */
export function lagSpread(ref: Float32Array, out: Float32Array, voiced: Uint8Array, maxMs = 400): { min: number; max: number; windows: number } {
  const win = RATE / 5
  const lags: number[] = []
  for (let at = 0; at + win < ref.length - (maxMs * RATE) / 1000; at += win) {
    const f0 = Math.floor(at / (RATE / 100))
    let v = 0
    for (let f = f0; f < f0 + 20; f++) v += voiced[f] ?? 0
    if (v < 20 || rmsDb(ref, at, at + win) < -35) continue
    const { lag, corr } = findLag(ref, out, maxMs, at, at + win)
    if (corr > 0.6) lags.push(lag)
  }
  return { min: lags.length ? Math.min(...lags) : 0, max: lags.length ? Math.max(...lags) : 0, windows: lags.length }
}

/** Gate openings and closings, and how many 10 ms frames of speech went out while it was closed. */
export function gateStats(open: Uint8Array, voiced: Uint8Array, lagBlocks: number): { transitions: number; speechCutMs: number } {
  let transitions = 0
  for (let k = 1; k < open.length; k++) if (open[k] !== open[k - 1]) transitions++
  const perFrame = RATE / 100 / BLOCK
  let cut = 0
  for (let f = 0; f < voiced.length; f++) {
    if (!voiced[f]) continue
    const k = Math.floor(f * perFrame) + lagBlocks
    if (k < open.length && !open[k]) cut++
  }
  return { transitions, speechCutMs: cut * 10 }
}

export interface Report {
  latencyMs: number
  /** Median gain on speech (dB): how much the voice as a whole was turned up or down. */
  speechGainDb: number
  /** 5th percentile of the gain on speech (dB) relative to the median: the syllables turned down most. */
  speechDipDb: number
  sdr: number
  lsd: number
  clipped: number
  gainRms: number
  gainMax: number
  /** Audio dropped (or repeated) while talking, from the spread of the local delay, ms. */
  timingMs: number
  transitions: number
  speechCutMs: number
  /** Noise in the pauses, in minus out (dB): only with a noisy input. */
  noiseReductionDb?: number
}

/**
 * Compares a run with the clean reference. `noisy` is the input when it had noise added: noise reduction is then the
 * pause level in minus out.
 */
export function measure(clean: Float32Array, run: ChainRun, which: 'sent' | 'heard', noisy?: Float32Array): Report {
  const out = run[which]
  // Speech well above the recording's noise floor (for the sound), and anywhere someone talks (for timing, gating).
  const speech = voicedFrames(clean, rmsDb(clean) - 7, 0)
  const voiced = voicedFrames(clean, rmsDb(clean) - 20)
  const { lag } = findLag(clean, out, 400, Math.round(SPEECH_FROM_S * RATE))
  const timing = lagSpread(clean, out, voiced)
  const gm = gainMotion(clean, out, lag, speech)
  const sg = speechGain(clean, out, lag, speech)
  const report: Report = {
    latencyMs: (lag / RATE) * 1000,
    speechGainDb: sg.median,
    speechDipDb: sg.p5 - sg.median,
    sdr: siSdr(clean, out, lag, speech),
    lsd: logSpectralDistance(clean, out, lag, speech),
    clipped: clipped(out),
    gainRms: gm.rms,
    gainMax: gm.max,
    timingMs: ((timing.max - timing.min) / RATE) * 1000,
    ...gateStats(run.open, voiced, Math.round(lag / BLOCK)),
  }
  if (noisy) {
    // Pauses: frames that are quiet in the clean speech, away from the start-up.
    const frame = RATE / 100
    let inS = 0
    let outS = 0
    for (let f = Math.round(SPEECH_FROM_S * 100); f < voiced.length; f++) {
      if (voiced[f]) continue
      for (let i = f * frame; i < (f + 1) * frame; i++) {
        const n = noisy[i] - clean[i]
        inS += n * n
        const y = out[i + lag] ?? 0
        outS += y * y
      }
    }
    report.noiseReductionDb = 10 * Math.log10(Math.max(1e-20, inS) / Math.max(1e-20, outS))
  }
  return report
}

/**
 * The fixture cut into phrases (at quiet stretches) with 1.2 s of near-silence around them: a talk spurt per
 * phrase, so the gate opens and closes many times. Returns the signal and where each phrase's sound starts.
 */
export function phrases(clean: Float32Array): { signal: Float32Array; onsets: number[] } {
  const fr = RATE / 100
  const level: number[] = []
  for (let f = 0; (f + 1) * fr <= clean.length; f++) level.push(rmsDb(clean, f * fr, (f + 1) * fr))
  const segments: [number, number][] = []
  let start = -1
  let quiet = 0
  for (let f = SPEECH_FROM_S * 100; f < level.length; f++) {
    if (level[f] > -35) {
      if (start < 0) start = f
      quiet = 0
    } else if (start >= 0 && ++quiet >= 8) {
      segments.push([start, f - quiet + 1])
      start = -1
      quiet = 0
    }
  }
  if (start >= 0) segments.push([start, level.length])
  const gap = pinkNoise(Math.round(1.2 * RATE), -70, 3)
  const parts: Float32Array[] = []
  const onsets: number[] = []
  let length = 0
  for (const [a, b] of segments) {
    parts.push(gap)
    length += gap.length
    const s = clean.subarray(Math.max(0, a * fr - 10 * fr), b * fr + 10 * fr)
    let on = 0
    while (on < s.length && rmsDb(s, on, on + fr) < -45) on += fr / 10
    onsets.push(length + on)
    parts.push(s)
    length += s.length
  }
  parts.push(gap)
  length += gap.length
  const signal = new Float32Array(length)
  let o = 0
  for (const p of parts) {
    signal.set(p, o)
    o += p.length
  }
  return { signal, onsets }
}

/** The golden-test inputs (see scripts/deepfilter-golden.mjs): 6 s of the fixture, clean and noisy, as 16-bit PCM. */
export function goldenInputs(clean: Float32Array): { clean: Float32Array; noisy: Float32Array } {
  const n = 6 * RATE
  const c = clean.slice(0, n)
  const noisy = mix(c, pinkNoise(n, -42), keyboard(n, RATE, -16))
  const q16 = (x: Float32Array) => x.map((v) => Math.max(-32768, Math.min(32767, Math.round(v * 32768))) / 32768)
  return { clean: q16(c), noisy: q16(noisy) }
}

/** 16-bit mono WAV bytes. */
export function wavBytes(x: Float32Array, rate = RATE): Uint8Array {
  const b = new DataView(new ArrayBuffer(44 + x.length * 2))
  const text = (o: number, s: string) => [...s].forEach((ch, i) => b.setUint8(o + i, ch.charCodeAt(0)))
  text(0, 'RIFF')
  b.setUint32(4, 36 + x.length * 2, true)
  text(8, 'WAVEfmt ')
  b.setUint32(16, 16, true)
  b.setUint16(20, 1, true)
  b.setUint16(22, 1, true)
  b.setUint32(24, rate, true)
  b.setUint32(28, rate * 2, true)
  b.setUint16(32, 2, true)
  b.setUint16(34, 16, true)
  text(36, 'data')
  b.setUint32(40, x.length * 2, true)
  for (let i = 0; i < x.length; i++) b.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(x[i] * 32768))), true)
  return new Uint8Array(b.buffer)
}
