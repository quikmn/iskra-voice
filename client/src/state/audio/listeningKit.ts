// The listening kit (scripts/listening-kit.mjs): test clips rendered through what a call does to a voice, for blind
// listening without a call. The conditions come from the app's own settings and choices (DEFAULT_AUDIO, pickEngine,
// captureOptions, DF_STRENGTH_DB, gateParams: nothing copied), and the mic and listener stages run the app's own audio
// worklet processors (micGate.worklet.ts, remote.worklet.ts, RNNoise's worklet) block by block, with DeepFilterNet3
// the way its worker runs it. No DOM, no Node APIs: the script passes the files in.
import { AudioPresets } from 'livekit-client'
import { df_process_frame, initSync } from '../../../vendor/deepfilternet/deepfilter.js'
import { captureOptions, DEFAULT_AUDIO, type AiStrength, type AudioSettings, type NoiseMode } from '../audio'
import type { MicParams } from '../micGate.worklet'
import { pickEngine, type NoiseEngine } from './engines'
import { queueDelay } from './dfQueue'
import { Framer } from './framer'
import { gateParams } from './micParams'
import { gainMotion, logSpectralDistance, rmsDb, siSdr, speechGain } from './quality'
import { createDeepFilter, DF_STRENGTH_DB, warmUp } from './strength'

export const KIT_RATE = 48000
const BLOCK = 128
const FRAME = KIT_RATE / 100

// ── Conditions ───────────────────────────────────────────────────────────

export type KitConditionId = 'off' | 'standard' | 'strong' | 'ai-gentle' | 'ai-normal' | 'ai-max'

export interface KitCondition {
  id: KitConditionId
  /** As Settings → Voice & audio names it. */
  label: string
  /** Your settings: the defaults, with this noise suppression. */
  settings: AudioSettings
  /** What runs for it on a device that can run everything. */
  engine: NoiseEngine
  /** What the browser is asked for when the mic is captured (its own echo cancellation, suppression and gain). */
  capture: { echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean; channelCount: number }
  /** DeepFilterNet3's attenuation limit (dB), or null when it doesn't run. */
  deepFilterDb: number | null
  /** What the page tells the mic's worklet: input volume, voice activity (Silero, automatic) and push-to-talk (off). */
  mic: MicParams
  /** The listener's "Even out voices". */
  leveling: boolean
}

/** A device that can run everything, and nothing has fallen back: what each setting is meant to do. */
const ALL_CAPS = { worklet: true, simd: true }
const HEALTHY = { aiBroken: false, aiSlow: false, rnnoiseBroken: false }

export function kitCondition(id: KitConditionId, label: string, noise: NoiseMode, aiStrength: AiStrength = DEFAULT_AUDIO.aiStrength): KitCondition {
  const settings: AudioSettings = { ...DEFAULT_AUDIO, noise, aiStrength }
  const engine = pickEngine(noise, ALL_CAPS, HEALTHY)
  const { echoCancellation, noiseSuppression, autoGainControl, channelCount } = captureOptions(settings, engine)
  return {
    id,
    label,
    settings,
    engine,
    capture: { echoCancellation, noiseSuppression, autoGainControl, channelCount },
    deepFilterDb: engine === 'ai' ? DF_STRENGTH_DB[aiStrength] : null,
    mic: gateParams(settings, false),
    leveling: settings.leveling,
  }
}

export const KIT_CONDITIONS: readonly KitCondition[] = [
  kitCondition('off', 'Off', 'off'),
  kitCondition('standard', 'Standard', 'standard'),
  kitCondition('strong', 'Strong (RNNoise)', 'strong'),
  kitCondition('ai-gentle', 'AI, Gentle', 'ai', 'gentle'),
  kitCondition('ai-normal', 'AI, Normal', 'ai', 'normal'),
  kitCondition('ai-max', 'AI, Max', 'ai', 'max'),
]

/**
 * Opus as calls send a voice (WebCodecs' config): LiveKit's default audio preset (music: 48 kbps), in-band FEC, 20 ms
 * frames, and what Chrome's WebRTC picks for a mono voice (VoIP mode, complexity 9). Calls also use DTX and RED
 * (voice.ts): RED only matters when packets are lost, and DTX leaves out packets of silence, which the gate's
 * pauses already are. WebCodecs numbers its packets in sequence when DTX leaves some out, so they can't be put back
 * in place: the kit sends every packet.
 */
export const KIT_OPUS = {
  codec: 'opus',
  sampleRate: KIT_RATE,
  numberOfChannels: 1,
  bitrate: AudioPresets.music.maxBitrate,
  bitrateMode: 'variable',
  opus: { application: 'voip', complexity: 9, frameDuration: 20000, usedtx: false, useinbandfec: true, packetlossperc: 0 },
} as const

/** The browser capture settings the conditions need, each once (conditions that capture alike share a recording). */
export function captureGroups(conditions: readonly KitCondition[] = KIT_CONDITIONS): { key: string; capture: KitCondition['capture']; ids: KitConditionId[] }[] {
  const groups = new Map<string, { key: string; capture: KitCondition['capture']; ids: KitConditionId[] }>()
  for (const c of conditions) {
    const key = JSON.stringify(c.capture)
    const g = groups.get(key) ?? { key, capture: c.capture, ids: [] }
    g.ids.push(c.id)
    groups.set(key, g)
  }
  return [...groups.values()]
}

// ── The app's worklet processors, here ───────────────────────────────────

interface Port {
  onmessage: ((e: { data: unknown }) => void) | null
  postMessage(message: unknown): void
  addEventListener(type: string, listener: (e: { data: unknown }) => void): void
  /** Here only: a message from the page (node.port.postMessage there). */
  deliver(data: unknown): void
}
export interface Processor {
  port: Port
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters?: Record<string, Float32Array>): boolean
}
type ProcessorClass = new (options?: { processorOptions?: Record<string, unknown> }) => Processor

const registered = new Map<string, ProcessorClass>()
let globalsSet = false

/** What an audio worklet module finds around it: the sample rate, the processor base class and registerProcessor. */
function workletGlobals(): void {
  if (globalsSet) return
  globalsSet = true
  const g = globalThis as Record<string, unknown>
  g.sampleRate = KIT_RATE
  g.AudioWorkletProcessor = class {
    readonly port: Port
    constructor() {
      const listeners: ((e: { data: unknown }) => void)[] = []
      const port: Port = {
        onmessage: null,
        postMessage: () => undefined,
        addEventListener: (_type, listener) => listeners.push(listener),
        deliver: (data) => {
          port.onmessage?.({ data })
          for (const l of listeners) l({ data })
        },
      }
      this.port = port
    }
  }
  g.registerProcessor = (name: string, ctor: ProcessorClass) => registered.set(name, ctor)
}

/** Sends a message to a processor, as the page's node.port.postMessage does. */
export function tell(node: Processor, data: unknown): void {
  node.port.deliver(data)
}

/** The app's mic worklet (iskra-mic-gate) and listener worklet (iskra-leveler, iskra-df-bridge). */
export async function loadAppWorklets(): Promise<void> {
  workletGlobals()
  await import('../micGate.worklet')
  await import('./remote.worklet')
}

function processor(name: string): ProcessorClass {
  const ctor = registered.get(name)
  if (!ctor) throw new Error(`audio worklet processor ${name} isn't loaded`)
  return ctor
}

/**
 * RNNoise's worklet as the app loads it (@sapphi-red/web-noise-suppressor, the SIMD build the app picks where
 * WebAssembly SIMD works), given the .wasm bytes.
 */
export async function rnnoiseProcessor(wasm: ArrayBuffer): Promise<Processor> {
  workletGlobals()
  if (!registered.has('@sapphi-red/web-noise-suppressor/rnnoise')) await import('@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js')
  const Ctor = processor('@sapphi-red/web-noise-suppressor/rnnoise')
  // Its Emscripten glue takes Node's file APIs (and process-wide error handlers) when it sees Node. Hidden while it
  // starts, it takes the path browsers take: the bytes it's given.
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'process')
  Object.defineProperty(globalThis, 'process', { value: undefined, configurable: true, writable: true })
  let node: Processor & { processor?: unknown }
  try {
    node = new Ctor({ processorOptions: { wasmBinary: wasm.slice(0), maxChannels: 1 } })
  } finally {
    if (saved) Object.defineProperty(globalThis, 'process', saved)
    else delete (globalThis as Record<string, unknown>).process
  }
  for (let i = 0; i < 500 && !node.processor; i++) await new Promise((resolve) => setTimeout(resolve, 10))
  if (!node.processor) throw new Error('RNNoise did not start')
  return node
}

/** Runs a processor over a whole signal in 128-sample render calls, as the audio thread does. */
export function render(node: Processor, input: Float32Array): Float32Array {
  const n = Math.floor(input.length / BLOCK) * BLOCK
  const out = new Float32Array(n)
  const outputs = [[new Float32Array(BLOCK)]]
  for (let k = 0; k < n; k += BLOCK) {
    outputs[0][0].fill(0)
    node.process([[input.slice(k, k + BLOCK)]], outputs, {})
    out.set(outputs[0][0], k)
  }
  return out
}

// ── The chain ────────────────────────────────────────────────────────────

export interface KitEngines {
  /** DeepFilterNet3_onnx.tar.gz. */
  deepFilterModel: Uint8Array
  /** silero_vad_16k_op15.onnx. */
  sileroModel: ArrayBuffer
  /** rnnoise_simd.wasm. */
  rnnoiseWasm: ArrayBuffer
}

/** Loads the engines (the bundled files' bytes) and the app's worklets. */
export async function loadKit(files: { deepFilterWasm: BufferSource; deepFilterModel: ArrayBuffer; sileroModel: ArrayBuffer; rnnoiseWasm: ArrayBuffer }): Promise<KitEngines> {
  initSync({ module: files.deepFilterWasm })
  await loadAppWorklets()
  return { deepFilterModel: new Uint8Array(files.deepFilterModel), sileroModel: files.sileroModel, rnnoiseWasm: files.rnnoiseWasm }
}

/**
 * DeepFilterNet3 as the mic's worker runs it: a fresh state with Iskra's thresholds and this strength, warmed up,
 * 10 ms frames. The worklet plays the worker's frames at a fixed delay (queueDelay, for the usual 10 ms device
 * buffer); with no late frame that's exactly the framer's output, a fixed time later (quality.test.ts), so that's
 * what this gives.
 */
export function deepFilterStage(input: Float32Array, attenDb: number, model: Uint8Array, deviceBuffer = 512): Float32Array {
  const state = createDeepFilter(model, attenDb)
  warmUp(state, df_process_frame)
  const framer = new Framer(FRAME, KIT_RATE, (frame) => df_process_frame(state, frame))
  const n = Math.floor(input.length / BLOCK) * BLOCK
  const out = new Float32Array(n)
  const shift = queueDelay(deviceBuffer) - framer.latency
  const block = new Float32Array(BLOCK)
  for (let k = 0; k + shift < n; k += BLOCK) {
    framer.push(input.subarray(k, k + BLOCK), block)
    out.set(block.subarray(0, Math.min(BLOCK, n - k - shift)), k + shift)
  }
  return out
}

/** The mic's worklet (input volume, Silero's gate, limiter) with your settings, as micPipeline.ts sets it up. */
export function micGateStage(input: Float32Array, condition: KitCondition, sileroModel: ArrayBuffer): Float32Array {
  const node = new (processor('iskra-mic-gate'))()
  tell(node, condition.mic)
  tell(node, { type: 'vad-model', model: sileroModel })
  return render(node, input)
}

/** Your mic as it's sent: the captured track through noise suppression and the mic's worklet. */
export async function micStage(captured: Float32Array, condition: KitCondition, engines: KitEngines): Promise<Float32Array> {
  if (condition.settings.hifi) throw new Error('the kit renders the voice path, not hi-fi')
  let x = captured
  if (condition.engine === 'ai') x = deepFilterStage(x, condition.deepFilterDb!, engines.deepFilterModel)
  else if (condition.engine === 'rnnoise') x = render(await rnnoiseProcessor(engines.rnnoiseWasm), x)
  return micGateStage(x, condition, engines.sileroModel)
}

/** What a listener hears, after Opus: "Even out voices" (iskra-leveler) when it's on. */
export function listenerStage(received: Float32Array, condition: KitCondition): Float32Array {
  // The kit renders the defaults: "Clean up others' audio" is off. If that default changes, so must the kit.
  if (condition.settings.cleanIncoming) throw new Error('the kit does not render "Clean up others\' audio"')
  if (!condition.leveling) return received
  return render(new (processor('iskra-leveler'))(), received)
}

// ── Test signals ─────────────────────────────────────────────────────────

/** `x` repeated to `length` samples, with an equal-power crossfade at each seam: a short noise recording as a long bed. */
export function loopTo(x: Float32Array, length: number, fadeMs = 250): Float32Array {
  const fade = Math.min(Math.floor((fadeMs * KIT_RATE) / 1000), Math.floor(x.length / 4))
  const step = x.length - fade
  const out = new Float32Array(length)
  for (let at = 0; at < length; at += step) {
    const first = at === 0
    const last = at + x.length >= length
    for (let i = 0; i < x.length && at + i < length; i++) {
      let w = 1
      if (!first && i < fade) w = Math.sin(((i / fade) * Math.PI) / 2)
      if (!last && i >= step) w = Math.cos((((i - step) / fade) * Math.PI) / 2)
      out[at + i] += x[i] * w
    }
  }
  return out
}

/** RMS level (dBFS) over the parts where `x` is speech: its "active level". */
export function activeLevelDb(x: Float32Array): number {
  const frames = speechFrames(x)
  let s = 0
  let n = 0
  for (let f = 0; f < frames.length; f++) {
    if (!frames[f]) continue
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) s += x[i] * x[i]
    n += FRAME
  }
  return 10 * Math.log10(Math.max(1e-20, s / Math.max(1, n)))
}

export const scale = (x: Float32Array, db: number): Float32Array => {
  const g = Math.pow(10, db / 20)
  return x.map((v) => v * g)
}

/** 10 ms frames that are speech: within `rangeDb` of the loudest frames, widened by `widen` frames. */
export function speechFrames(x: Float32Array, rangeDb = 30, widen = 0): Uint8Array {
  const n = Math.floor(x.length / FRAME)
  const level = new Float64Array(n)
  for (let f = 0; f < n; f++) level[f] = rmsDb(x, f * FRAME, (f + 1) * FRAME)
  const sorted = [...level].sort((a, b) => b - a)
  const top = sorted[Math.floor(sorted.length * 0.02)] ?? -100
  const raw = level.map((l) => (l > top - rangeDb ? 1 : 0))
  const out = new Uint8Array(n)
  for (let f = 0; f < n; f++) if (raw[f]) for (let d = -widen; d <= widen; d++) if (f + d >= 0 && f + d < n) out[f + d] = 1
  return out
}

/** Phrases: runs of speech split at pauses of at least `pauseMs` (each one opens the gate anew when long enough). */
export function phrasesOf(x: Float32Array, pauseMs = 300): [number, number][] {
  const frames = speechFrames(x, 40)
  const out: [number, number][] = []
  let start = -1
  let quiet = 0
  const need = Math.round(pauseMs / 10)
  for (let f = 0; f <= frames.length; f++) {
    if (f < frames.length && frames[f]) {
      if (start < 0) start = f
      quiet = 0
    } else if (start >= 0 && (++quiet >= need || f === frames.length)) {
      out.push([start * FRAME, (f - quiet + 1) * FRAME])
      start = -1
      quiet = 0
    }
  }
  return out
}

// ── Alignment ────────────────────────────────────────────────────────────

/** Normalised correlation of `ref[from..to)` with `y` `lag` samples later. */
function correlation(ref: Float32Array, y: Float32Array, from: number, to: number, lag: number): number {
  let c = 0
  let a = 0
  let b = 0
  for (let i = from; i < to; i++) {
    const v = y[i + lag] ?? 0
    c += ref[i] * v
    a += ref[i] * ref[i]
    b += v * v
  }
  return c / Math.sqrt(Math.max(1e-20, a * b))
}

/**
 * How many samples later `y` carries `ref` (0 to maxMs), judged over `ref[from..to)`: first by 5 ms loudness
 * envelopes (so noise removal and level changes don't throw it off), then sample by sample around that.
 */
export function alignTo(ref: Float32Array, y: Float32Array, from: number, to: number, maxMs = 1500): { lag: number; corr: number } {
  const hop = 240
  const n = Math.floor((to - from) / hop)
  const maxLag = Math.round((maxMs * KIT_RATE) / 1000 / hop)
  const env = (x: Float32Array, start: number, count: number) => {
    const out = new Float64Array(count)
    for (let k = 0; k < count; k++) out[k] = Math.max(-60, rmsDb(x, start + k * hop, Math.min(x.length, start + (k + 1) * hop)))
    return out
  }
  const a = env(ref, from, n)
  const b = env(y, from, n + maxLag)
  const mean = (x: Float64Array, s: number, c: number) => {
    let m = 0
    for (let k = s; k < s + c; k++) m += x[k]
    return m / c
  }
  const ma = mean(a, 0, n)
  let coarse = 0
  let best = -Infinity
  for (let l = 0; l <= maxLag; l++) {
    const mb = mean(b, l, n)
    let c = 0
    let va = 0
    let vb = 0
    for (let k = 0; k < n; k++) {
      const u = a[k] - ma
      const v = b[k + l] - mb
      c += u * v
      va += u * u
      vb += v * v
    }
    const r = c / Math.sqrt(Math.max(1e-20, va * vb))
    if (r > best) {
      best = r
      coarse = l * hop
    }
  }
  const end = Math.min(to, from + 3 * KIT_RATE)
  let lag = coarse
  let corr = -Infinity
  for (let l = Math.max(0, coarse - 2 * hop); l <= coarse + 2 * hop; l++) {
    const c = correlation(ref, y, from, end, l)
    if (c > corr) {
      corr = c
      lag = l
    }
  }
  return { lag, corr }
}

/**
 * `out` lined up with `ref` again every 20 ms (within ±1 ms): the browser's echo canceller moves the waveform by a
 * fraction of a millisecond now and then, which no one hears but sample-by-sample measures would count as damage.
 */
export function relineLocally(ref: Float32Array, out: Float32Array, maxShift = 48): Float32Array {
  const win = 960
  const aligned = new Float32Array(ref.length)
  for (let at = 0; at < ref.length; at += win) {
    const to = Math.min(ref.length, at + win)
    let best = 0
    let bestC = -Infinity
    if (rmsDb(ref, at, to) > -60) {
      for (let l = -maxShift; l <= maxShift; l++) {
        const c = correlation(ref, out, at, to, l)
        if (c > bestC) {
          bestC = c
          best = l
        }
      }
    }
    for (let i = at; i < to; i++) aligned[i] = out[i + best] ?? 0
  }
  return aligned
}

// ── Measurements ─────────────────────────────────────────────────────────

/** ITU-R BS.1770 K-weighting at 48 kHz (both biquads), for loudness. */
function kWeighted(x: Float32Array): Float64Array {
  const stages = [
    { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [-1.69065929318241, 0.73248077421585] },
    { b: [1, -2, 1], a: [-1.99004745483398, 0.99007225036621] },
  ]
  let y = Float64Array.from(x)
  for (const { b, a } of stages) {
    const out = new Float64Array(y.length)
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0
    for (let i = 0; i < y.length; i++) {
      const v = y[i]
      const o = b[0] * v + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2
      x2 = x1
      x1 = v
      y2 = y1
      y1 = o
      out[i] = o
    }
    y = out
  }
  return y
}

/** Loudness (LUFS, BS.1770 K-weighted) over the 10 ms frames marked in `frames`: the voice's loudness. */
export function loudness(x: Float32Array, frames: Uint8Array): number {
  const k = kWeighted(x)
  let s = 0
  let n = 0
  for (let f = 0; f < frames.length; f++) {
    if (!frames[f]) continue
    for (let i = f * FRAME; i < (f + 1) * FRAME && i < k.length; i++) s += k[i] * k[i]
    n += FRAME
  }
  return -0.691 + 10 * Math.log10(Math.max(1e-20, s / Math.max(1, n)))
}

export interface ClipNumbers {
  /** Scale-invariant SDR against the clean voice (dB), over speech, lined up every 20 ms (relineLocally). */
  siSdrDb: number
  /** Log-spectral distance to the clean voice (dB), 100 Hz–7.5 kHz, over speech. */
  spectralDistanceDb: number
  /** Median gain on speech (dB) against the clean voice. */
  speechGainDb: number
  /** The syllables turned down most: 5th percentile of the gain, relative to the median (dB). */
  speechDipDb: number
  /** How much the gain moves from one 10 ms to the next while talking (RMS, dB). */
  gainMotionDb: number
  /** Slow level wander: standard deviation of the gain over 200 ms stretches of speech (dB). */
  levelWanderDb: number
  /** Each phrase's first 50 ms against the clean voice, at the clip's own gain (dB; 0 = intact, -60 = gone): the worst one. */
  onsetDb: number
  /** How much of a phrase's start is missing (ms): until it comes within 10 dB of the clean voice. The worst one. */
  startCutMs: number
  /** Each phrase's last 80 ms (word ends), the same way (-60 = gone): the worst one. */
  endDb: number
  /** Noise left in the pauses, in dB below the voice (higher is quieter). */
  pauseBelowVoiceDb: number
  /** Samples at or beyond full scale. */
  clipped: number
  /** The voice's loudness (LUFS over speech): what level matching evens out. */
  voiceLufs: number
  /** Peak level, dBFS. */
  peakDb: number
}

/**
 * Measures `out` (already aligned to the clean voice, same length) against `clean`, the voice alone at the level it
 * went in. `phrases` are where it talks. SI-SDR is against `sdrRef` (the clean voice through the same browser capture,
 * when there is one: what the browser's own processing does to the waveform is then left out).
 */
export function measureClip(clean: Float32Array, out: Float32Array, phrases: [number, number][], sdrRef: Float32Array = clean): ClipNumbers {
  const speech = speechFrames(clean, 20)
  const voiced = speechFrames(clean, 30, 3)
  const sg = speechGain(clean, out, 0, speech)
  const gm = gainMotion(clean, out, 0, speech)
  // Slow wander: gain per 200 ms of speech.
  const wander: number[] = []
  for (let at = 0; at + 20 * FRAME <= clean.length; at += 20 * FRAME) {
    let v = 0
    for (let f = at / FRAME; f < at / FRAME + 20; f++) v += speech[f] ?? 0
    if (v < 14) continue
    wander.push(rmsDb(out, at, at + 20 * FRAME) - rmsDb(clean, at, at + 20 * FRAME))
  }
  const mean = wander.reduce((a, b) => a + b, 0) / Math.max(1, wander.length)
  const sd = Math.sqrt(wander.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, wander.length))
  const part = (from: number, to: number) => Math.max(-60, rmsDb(out, from, to) - rmsDb(clean, from, to) - sg.median)
  const ms = (t: number) => Math.round((t * KIT_RATE) / 1000)
  let onset = Infinity
  let end = Infinity
  let cut = 0
  for (const [a, b] of phrases) {
    // Where the phrase really starts and ends: 5 ms steps within 40 dB of its loudest 10 ms.
    let peak = -200
    for (let i = a; i + FRAME <= b; i += FRAME / 2) peak = Math.max(peak, rmsDb(clean, i, i + FRAME))
    let s = a
    while (s + ms(5) < b && rmsDb(clean, s, s + ms(5)) < peak - 40) s += ms(5)
    let e = b
    while (e - ms(5) > s && rmsDb(clean, e - ms(5), e) < peak - 40) e -= ms(5)
    onset = Math.min(onset, part(s, Math.min(e, s + ms(50))))
    let t = s
    while (t + ms(5) < e && part(t, t + ms(5)) < -10) t += ms(5)
    cut = Math.max(cut, ((t - s) / KIT_RATE) * 1000)
    end = Math.min(end, part(Math.max(s, e - ms(80)), e))
  }
  // Pauses: away from speech by 100 ms.
  const near = speechFrames(clean, 45, 10)
  let ps = 0
  let pn = 0
  for (let f = 0; f < near.length; f++) {
    if (near[f]) continue
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) ps += out[i] * out[i]
    pn += FRAME
  }
  let speechS = 0
  let speechN = 0
  for (let f = 0; f < speech.length; f++) {
    if (!speech[f]) continue
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) speechS += out[i] * out[i]
    speechN += FRAME
  }
  const pauseDb = pn ? 10 * Math.log10(Math.max(1e-20, ps / pn)) : -200
  const speechDb = 10 * Math.log10(Math.max(1e-20, speechS / Math.max(1, speechN)))
  let peak = 0
  let clipped = 0
  for (let i = 0; i < out.length; i++) {
    const v = Math.abs(out[i])
    if (v > peak) peak = v
    if (v >= 32767 / 32768) clipped++
  }
  return {
    siSdrDb: siSdr(sdrRef, relineLocally(sdrRef, out), 0, speech),
    spectralDistanceDb: logSpectralDistance(clean, out, 0, speech),
    speechGainDb: sg.median,
    speechDipDb: sg.p5 - sg.median,
    gainMotionDb: gm.rms,
    levelWanderDb: sd,
    onsetDb: Number.isFinite(onset) ? onset : 0,
    startCutMs: cut,
    endDb: Number.isFinite(end) ? end : 0,
    pauseBelowVoiceDb: Math.min(120, speechDb - pauseDb),
    clipped,
    voiceLufs: loudness(out, voiced),
    peakDb: 20 * Math.log10(Math.max(1e-10, peak)),
  }
}
