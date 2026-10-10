// The microphone's path before it's sent: RNNoise noise suppression (WebAssembly in an AudioWorklet), input volume
// and the voice activity gate, which also measures your level for the meter and your own "speaking" ring.
// Everything is bundled with the app (no CDN). If AudioWorklet or WebAssembly isn't there, it isn't used.
import type { RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor'
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url'
import type { TrackProcessor, Track, AudioProcessorOptions } from 'livekit-client'
import gateWorkletUrl from './micGate.worklet.ts?worker&url'
import { AUTO_SPEAKING_DB, strongSupported, type AudioSettings } from './audio'

export type LevelListener = (db: number, open: boolean) => void

export interface MicPipeline {
  /** The processed track to send. */
  readonly track: MediaStreamTrack
  /** RNNoise is running. */
  readonly strong: boolean
  /** Input volume and threshold apply right away; noise mode changes need a new pipeline. */
  update(settings: AudioSettings): void
  destroy(): void
}

let wasm: Promise<ArrayBuffer> | null = null
/** RNNoise couldn't run here (sample rate, memory, a blocked module): stop trying until reload. */
let strongBroken = false
export const strongWorks = () => strongSupported() && !strongBroken

const gateParams = (s: AudioSettings) => ({
  gain: s.inputVolume,
  threshold: s.threshold ?? AUTO_SPEAKING_DB,
  gating: s.threshold !== null,
})

/** Resumes a suspended context (iOS starts them that way) on the next tap or key press. */
function keepRunning(ctx: AudioContext): () => void {
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

/** Builds the mic path for `source`, or null if this browser can't (then send the raw track). */
export async function createMicPipeline(source: MediaStreamTrack, settings: AudioSettings, onLevel: LevelListener): Promise<MicPipeline | null> {
  if (typeof AudioWorkletNode !== 'function' || typeof AudioContext !== 'function') return null
  const wantStrong = settings.noise === 'strong' && strongWorks()
  let ctx: AudioContext
  try {
    // RNNoise only works at 48 kHz; the browser resamples the mic to match.
    ctx = new AudioContext(wantStrong ? { sampleRate: 48000, latencyHint: 'interactive' } : { latencyHint: 'interactive' })
  } catch {
    return null
  }
  const stopResuming = keepRunning(ctx)
  const fail = () => {
    if (wantStrong) strongBroken = true // e.g. Firefox when the mic's sample rate isn't 48 kHz
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

  let rnnoise: RnnoiseWorkletNode | null = null
  if (wantStrong && ctx.sampleRate === 48000) {
    try {
      // Loaded on first use: the library defines its nodes as soon as it's imported.
      const lib = await import('@sapphi-red/web-noise-suppressor')
      wasm ??= lib.loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl })
      const binary = await wasm
      await ctx.audioWorklet.addModule(rnnoiseWorkletUrl)
      rnnoise = new lib.RnnoiseWorkletNode(ctx, { wasmBinary: binary, maxChannels: 1 })
    } catch {
      wasm = null
      strongBroken = true
      rnnoise = null
    }
  } else if (wantStrong) {
    strongBroken = true
  }

  const destination = ctx.createMediaStreamDestination()
  if (rnnoise) input.connect(rnnoise).connect(gate)
  else input.connect(gate)
  gate.connect(destination)

  let alive = true
  gate.port.onmessage = (e: MessageEvent<{ level: number; open: boolean }>) => {
    if (alive) onLevel(e.data.level, e.data.open)
  }
  gate.port.postMessage(gateParams(settings))

  const track = destination.stream.getAudioTracks()[0]
  return {
    track,
    strong: !!rnnoise,
    update: (s) => gate.port.postMessage(gateParams(s)),
    destroy: () => {
      if (!alive) return
      alive = false
      stopResuming()
      gate.port.onmessage = null
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
  private readonly onLevel: LevelListener
  private readonly onStrong: (strong: boolean | null) => void

  constructor(settings: () => AudioSettings, onLevel: LevelListener, onStrong: (strong: boolean | null) => void) {
    this.settings = settings
    this.onLevel = onLevel
    this.onStrong = onStrong
  }

  get active(): MicPipeline | null {
    return this.pipeline
  }

  async init(opts: AudioProcessorOptions): Promise<void> {
    const next = await createMicPipeline(opts.track, this.settings(), this.onLevel)
    this.pipeline?.destroy()
    this.pipeline = next
    // Without a pipeline, send the mic as it is.
    this.processedTrack = next?.track ?? opts.track
    this.onStrong(next ? next.strong : null)
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
