// The microphone's path before it's sent: noise suppression (DeepFilterNet3 or RNNoise, WebAssembly in an
// AudioWorklet), input volume and the voice activity gate (Silero VAD), which also measures your level for the
// meter and your own "speaking" ring. Everything runs on this device and is bundled with the app (no CDN). If
// AudioWorklet or WebAssembly isn't there, the mic is sent as it is (with the browser's own noise suppression).
import type { RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor'
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'
import type { TrackProcessor, Track, AudioProcessorOptions } from 'livekit-client'
import gateWorkletUrl from './micGate.worklet.ts?worker&url'
import deepFilterWorkletUrl from './audio/deepfilter.worklet.ts?worker&url'
import { AUTO_SPEAKING_DB, type AudioSettings } from './audio'
import { loadDeepFilter, loadRnnoiseWasm, loadSilero } from './audio/assets'
import { engineCaps, markBroken, plannedEngine, SlowWatch, type NoiseEngine } from './audio/engines'

export type LevelListener = (db: number, open: boolean) => void

export interface MicCallbacks {
  onLevel: LevelListener
  /** The realtime factor of AI noise removal, about once a second. */
  onLoad?: (rtf: number) => void
  /** AI noise removal can't keep up on this device. */
  onSlow?: () => void
}

export interface MicPipeline {
  /** The processed track to send. */
  readonly track: MediaStreamTrack
  /** The noise suppression that runs in this pipeline ('browser' or 'off' when none of ours does). */
  readonly engine: NoiseEngine
  /** Input volume, sensitivity and push-to-talk apply right away; noise mode changes need a new pipeline. */
  update(settings: AudioSettings, ptt: boolean): void
  destroy(): void
}

const gateParams = (s: AudioSettings, ptt: boolean) => ({
  gain: s.inputVolume,
  threshold: s.threshold ?? AUTO_SPEAKING_DB,
  gating: s.threshold !== null,
  vad: s.threshold === null,
  ptt,
})

/** Resumes a suspended context (iOS starts them that way) on the next tap or key press. */
export function keepRunning(ctx: AudioContext): () => void {
  const resume = () => {
    if (ctx.state !== 'running' && ctx.state !== 'closed') void ctx.resume().catch(() => undefined)
  }
  resume()
  const events = ['pointerdown', 'keydown', 'touchend'] as const
  for (const e of events) window.addEventListener(e, resume, { capture: true, passive: true })
  ctx.addEventListener('statechange', resume) // iOS "interrupted" after a phone call
  return () => {
    for (const e of events) window.removeEventListener(e, resume, { capture: true })
    ctx.removeEventListener('statechange', resume)
  }
}

/** Waits for a worklet's first "ready" or "error". */
function answer(node: AudioWorkletNode, ms: number): Promise<{ type: string; message?: string }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ type: 'error', message: 'timed out' }), ms)
    node.port.onmessage = (e: MessageEvent<{ type: string; message?: string }>) => {
      if (e.data?.type !== 'ready' && e.data?.type !== 'error') return
      clearTimeout(timer)
      node.port.onmessage = null
      resolve(e.data)
    }
  })
}

/** DeepFilterNet3 in the context, running; null if it can't here. */
async function startDeepFilter(ctx: AudioContext): Promise<AudioWorkletNode | null> {
  try {
    const assets = await loadDeepFilter()
    await ctx.audioWorklet.addModule(deepFilterWorkletUrl)
    const node = new AudioWorkletNode(ctx, 'iskra-deepfilter', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
    const ready = answer(node, 20000)
    node.port.postMessage({ wasm: assets.wasm, model: assets.model })
    const result = await ready
    if (result.type !== 'ready') throw new Error(result.message)
    return node
  } catch (e) {
    console.warn('[iskra] AI noise removal could not start; using RNNoise', e)
    markBroken('ai')
    return null
  }
}

/** RNNoise in the context; null if it can't here. */
export async function startRnnoise(ctx: AudioContext): Promise<RnnoiseWorkletNode | null> {
  try {
    // Loaded on first use: the library defines its nodes as soon as it's imported.
    const lib = await import('@sapphi-red/web-noise-suppressor')
    const binary = await loadRnnoiseWasm()
    await ctx.audioWorklet.addModule(rnnoiseWorkletUrl)
    return new lib.RnnoiseWorkletNode(ctx, { wasmBinary: binary, maxChannels: 1 })
  } catch {
    markBroken('rnnoise')
    return null
  }
}

/** Builds the mic path for `source`, or null if this browser can't (then send the raw track). */
export async function createMicPipeline(source: MediaStreamTrack, settings: AudioSettings, ptt: boolean, callbacks: MicCallbacks): Promise<MicPipeline | null> {
  if (!engineCaps().worklet) return null
  const wanted = plannedEngine(settings.noise)
  const wasm = wanted === 'ai' || wanted === 'rnnoise'
  let ctx: AudioContext
  try {
    // DeepFilterNet and RNNoise only work at 48 kHz; the browser resamples the mic to match.
    ctx = new AudioContext(wasm ? { sampleRate: 48000, latencyHint: 'interactive' } : { latencyHint: 'interactive' })
  } catch {
    return null
  }
  const stopResuming = keepRunning(ctx)
  const fail = () => {
    stopResuming()
    void ctx.close().catch(() => undefined)
    return null
  }

  let input: MediaStreamAudioSourceNode
  let gate: AudioWorkletNode
  try {
    input = ctx.createMediaStreamSource(new MediaStream([source]))
    await ctx.audioWorklet.addModule(gateWorkletUrl)
    gate = new AudioWorkletNode(ctx, 'iskra-mic-gate', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
  } catch {
    return fail()
  }

  let engine: NoiseEngine = wasm ? 'browser' : wanted
  let deepFilter: AudioWorkletNode | null = null
  let rnnoise: RnnoiseWorkletNode | null = null
  if (wasm && ctx.sampleRate !== 48000) {
    // E.g. Firefox when the mic's sample rate isn't 48 kHz.
    markBroken('ai')
    markBroken('rnnoise')
  } else if (wanted === 'ai') {
    deepFilter = await startDeepFilter(ctx)
    if (deepFilter) engine = 'ai'
  }
  if (wasm && !deepFilter && ctx.sampleRate === 48000) {
    rnnoise = await startRnnoise(ctx)
    if (rnnoise) engine = 'rnnoise'
  }

  const destination = ctx.createMediaStreamDestination()
  const cleaner = deepFilter ?? rnnoise
  if (cleaner) input.connect(cleaner).connect(gate)
  else input.connect(gate)
  gate.connect(destination)

  let alive = true
  gate.port.onmessage = (e: MessageEvent<{ level: number; open: boolean } | { type: string; message?: string }>) => {
    if (!alive) return
    const m = e.data
    if ('level' in m) callbacks.onLevel(m.level, m.open)
    else if (m.type === 'vad-error') console.warn('[iskra] voice activity detection could not start', m.message)
  }
  gate.port.postMessage(gateParams(settings, ptt))
  // Silero arrives when it's loaded; until then the mic opens by level.
  void loadSilero().then((model) => alive && gate.port.postMessage({ type: 'vad-model', model }), (e) => console.warn('[iskra] voice activity model', e))

  if (deepFilter) {
    const watch = new SlowWatch()
    let lastLog = 0
    deepFilter.port.onmessage = (e: MessageEvent<{ type: string; rtf?: number }>) => {
      if (!alive || e.data?.type !== 'rtf' || typeof e.data.rtf !== 'number') return
      const rtf = e.data.rtf
      callbacks.onLoad?.(rtf)
      if (Date.now() - lastLog > 10000) {
        lastLog = Date.now()
        console.info(`[iskra] AI noise removal: realtime factor ${rtf.toFixed(3)} (${(rtf * 100).toFixed(1)}% of one core)`)
      }
      if (watch.report(rtf)) {
        console.warn(`[iskra] AI noise removal is too slow here (realtime factor ${rtf.toFixed(2)}); switching to RNNoise`)
        callbacks.onSlow?.()
      }
    }
  }

  const track = destination.stream.getAudioTracks()[0]
  return {
    track,
    engine,
    update: (s, p) => gate.port.postMessage(gateParams(s, p)),
    destroy: () => {
      if (!alive) return
      alive = false
      stopResuming()
      gate.port.onmessage = null
      if (deepFilter) deepFilter.port.onmessage = null
      rnnoise?.destroy()
      input.disconnect()
      track.stop()
      void ctx.close().catch(() => undefined)
    },
  }
}

/**
 * The mic path as a LiveKit track processor: LiveKit hands us the captured track (and a new one after a device
 * switch) and sends what we return.
 */
export class MicProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  name = 'iskra-mic'
  processedTrack?: MediaStreamTrack
  private pipeline: MicPipeline | null = null
  private readonly settings: () => AudioSettings
  private readonly ptt: () => boolean
  private readonly callbacks: MicCallbacks
  private readonly onEngine: (engine: NoiseEngine | null) => void

  constructor(settings: () => AudioSettings, ptt: () => boolean, callbacks: MicCallbacks, onEngine: (engine: NoiseEngine | null) => void) {
    this.settings = settings
    this.ptt = ptt
    this.callbacks = callbacks
    this.onEngine = onEngine
  }

  get active(): MicPipeline | null {
    return this.pipeline
  }

  async init(opts: AudioProcessorOptions): Promise<void> {
    const next = await createMicPipeline(opts.track, this.settings(), this.ptt(), this.callbacks)
    this.pipeline?.destroy()
    this.pipeline = next
    // Without a pipeline, send the mic as it is.
    this.processedTrack = next?.track ?? opts.track
    this.onEngine(next ? next.engine : null)
  }

  restart(opts: AudioProcessorOptions): Promise<void> {
    return this.init(opts)
  }

  async destroy(): Promise<void> {
    this.pipeline?.destroy()
    this.pipeline = null
    this.processedTrack = undefined
  }
}
