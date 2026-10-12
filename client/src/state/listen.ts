// What you hear: each incoming voice goes through loudness leveling and, with "Clean up others' audio" on, noise
// removal, before LiveKit's per-person volume and the speakers. Runs in the room's AudioContext (LiveKit's Web Audio
// mixing), so it's only there where the app mixes with Web Audio (where it can also pick the output device).
// Noise removal is DeepFilterNet3 in a worker when you use AI noise removal and the device keeps up (at most a few
// voices at once), RNNoise otherwise. Everything runs on this device.
import type { RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor'
import type { RemoteAudioTrack } from 'livekit-client'
import remoteWorkletUrl from './audio/remote.worklet.ts?worker&url'
import { contextDelay, DeepFilterWorker } from './audio/deepfilterHost'
import { BridgeWatch, MAX_BRIDGED, plannedEngine, SLOW_WINDOWS, SlowWatch } from './audio/engines'
import { DF_STRENGTH_DB } from './audio/strength'
import type { AudioSettings } from './audio'
import { startRnnoise } from './micPipeline'

/** More voices than this at once and incoming noise removal uses RNNoise (DeepFilterNet costs ~5% of a core each). */
export const MAX_AI_VOICES = 4

export type CleanEngine = 'ai' | 'rnnoise'

/** Which engine cleans up incoming voices, or null if none can. */
export function cleanEngine(noise: AudioSettings['noise'], voices: number, aiTooSlow: boolean): CleanEngine | null {
  const ai = noise === 'ai' && !aiTooSlow && voices <= MAX_AI_VOICES && plannedEngine('ai') === 'ai'
  if (ai) return 'ai'
  return plannedEngine('strong') === 'rnnoise' ? 'rnnoise' : null
}

interface Voice {
  track: RemoteAudioTrack
  nodes: AudioNode[]
  rnnoise: RnnoiseWorkletNode | null
  /** Its DeepFilterNet state in the worker. */
  workerId: string | null
  /** The processed voice as a track (clips record it). */
  tap: MediaStreamAudioDestinationNode | null
}

export class Listener {
  readonly ctx: AudioContext
  /** The engine cleaning up incoming voices right now (null: off or none). */
  engine: CleanEngine | null = null
  private readonly voices = new Map<string, Voice>()
  private readonly modules: Promise<boolean>
  private worker: DeepFilterWorker | null = null
  private workerReady: Promise<boolean> | null = null
  private settings: AudioSettings
  private aiTooSlow = false
  private closed = false
  private readonly onChange: () => void

  constructor(settings: AudioSettings, onChange: () => void) {
    this.settings = settings
    this.onChange = onChange
    // 48 kHz: what both noise removal engines need (the browser resamples to the device).
    this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
    this.modules = this.ctx.audioWorklet.addModule(remoteWorkletUrl).then(() => true, (e) => {
      console.warn('[iskra] incoming audio processing unavailable', e)
      return false
    })
  }

  /** A new incoming voice (or the same one again after a track change). */
  async attach(sid: string, track: RemoteAudioTrack): Promise<void> {
    this.detach(sid)
    const voice: Voice = { track, nodes: [], rnnoise: null, workerId: null, tap: null }
    this.voices.set(sid, voice)
    await this.build(sid, voice)
    // A voice more or less can change whether DeepFilterNet still fits.
    if (this.settings.cleanIncoming && this.engine !== cleanEngine(this.settings.noise, this.voices.size, this.aiTooSlow)) await this.rebuild()
  }

  detach(sid: string): void {
    const voice = this.voices.get(sid)
    if (!voice) return
    this.voices.delete(sid)
    this.teardown(voice)
  }

  /** Settings changed: rebuild every voice's chain if what runs changed. */
  async apply(settings: AudioSettings): Promise<void> {
    const prev = this.settings
    this.settings = settings
    if (prev.leveling !== settings.leveling || prev.cleanIncoming !== settings.cleanIncoming || (settings.cleanIncoming && prev.noise !== settings.noise)) {
      await this.rebuild()
    }
  }

  /** The processed voice for clips, when noise removal is on (otherwise use the track itself). */
  cleanedTrack(sid: string): MediaStreamTrack | null {
    return this.voices.get(sid)?.tap?.stream.getAudioTracks()[0] ?? null
  }

  destroy(): void {
    this.closed = true
    for (const voice of this.voices.values()) this.teardown(voice)
    this.voices.clear()
    this.worker?.terminate()
    this.worker = null
    void this.ctx.close().catch(() => undefined)
  }

  private async rebuild(): Promise<void> {
    for (const [sid, voice] of this.voices) {
      this.teardown(voice, false)
      await this.build(sid, voice)
    }
    this.onChange()
  }

  private teardown(voice: Voice, unplug = true): void {
    for (const node of voice.nodes) {
      node.disconnect()
      if (node instanceof AudioWorkletNode && node !== voice.rnnoise) node.port.postMessage('stop')
    }
    voice.rnnoise?.destroy()
    if (voice.workerId) this.worker?.drop(voice.workerId)
    voice.tap?.stream.getTracks().forEach((t) => t.stop())
    voice.nodes = []
    voice.rnnoise = null
    voice.workerId = null
    voice.tap = null
    if (unplug) voice.track.setWebAudioPlugins([])
  }

  private async build(sid: string, voice: Voice): Promise<void> {
    if (!(await this.modules) || this.closed || this.voices.get(sid) !== voice) return
    const nodes: AudioNode[] = []
    let engine: CleanEngine | null = null
    if (this.settings.cleanIncoming) {
      engine = cleanEngine(this.settings.noise, this.voices.size, this.aiTooSlow)
      if (engine === 'ai') {
        const bridge = await this.bridge(voice)
        if (bridge) nodes.push(bridge)
        else engine = cleanEngine('strong', this.voices.size, true)
      }
      if (engine === 'rnnoise') {
        voice.rnnoise = await startRnnoise(this.ctx)
        if (voice.rnnoise) nodes.push(voice.rnnoise)
        else engine = null
      }
    }
    if (this.settings.leveling) nodes.push(new AudioWorkletNode(this.ctx, 'iskra-leveler', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] }))
    if (this.closed || this.voices.get(sid) !== voice) {
      for (const node of nodes) node.disconnect()
      return
    }
    if (engine && nodes.length) {
      voice.tap = this.ctx.createMediaStreamDestination()
      nodes[nodes.length - 1].connect(voice.tap)
    }
    voice.nodes = nodes
    this.engine = this.settings.cleanIncoming ? engine : null
    voice.track.setWebAudioPlugins(nodes)
  }

  /** A worklet node that hands this voice to the DeepFilterNet worker; null if the worker can't run. */
  private async bridge(voice: Voice): Promise<AudioWorkletNode | null> {
    if (!(await this.startWorker()) || !this.worker) return null
    const node = new AudioWorkletNode(this.ctx, 'iskra-df-bridge', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { delay: contextDelay(this.ctx) },
    })
    const watch = new BridgeWatch()
    node.port.onmessage = (e: MessageEvent<{ type: string; share: number }>) => {
      if (e.data?.type === 'late' && watch.report(e.data.share)) {
        this.tooSlow(`its worker was late for more than ${MAX_BRIDGED * 100}% of each second, ${SLOW_WINDOWS} s in a row`)
      }
    }
    // The voice passes through until it's linked.
    void this.worker.link(node, DF_STRENGTH_DB.normal).then((id) => {
      if (id && voice.nodes.includes(node)) voice.workerId = id
      else if (id) this.worker?.drop(id)
    })
    return node
  }

  private startWorker(): Promise<boolean> {
    this.workerReady ??= (async () => {
      try {
        const watch = new SlowWatch()
        const worker = await DeepFilterWorker.start({
          reportMs: 2000,
          ms: 20000,
          onLoad: (load) => {
            console.info(`[iskra] incoming AI noise removal: worker ${(load.busy * 100).toFixed(1)}% busy, realtime factor ${load.rtf.toFixed(3)} per voice, slowest frame ${load.slowest.toFixed(1)} ms`)
            if (watch.report(load.busy)) this.tooSlow(`worker ${(load.busy * 100).toFixed(0)}% busy`)
          },
          onError: (message) => console.warn('[iskra] incoming AI noise removal', message),
        })
        if (this.closed) worker.terminate()
        else this.worker = worker
        return !this.closed
      } catch (e) {
        console.warn(`[iskra] incoming AI noise removal could not start (${(e as Error)?.message ?? e}); using RNNoise`)
        return false
      }
    })()
    return this.workerReady
  }

  private tooSlow(why: string): void {
    if (this.aiTooSlow) return
    console.warn(`[iskra] incoming AI noise removal can't keep up here (${why}); using RNNoise for incoming voices`)
    this.aiTooSlow = true
    void this.rebuild()
  }
}
