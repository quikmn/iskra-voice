// What you hear: each incoming voice goes through loudness leveling and, with "Clean up others' audio" on, noise
// removal, before LiveKit's per-person volume and the speakers. Runs in the room's AudioContext (LiveKit's Web Audio
// mixing), so it's only there where the app mixes with Web Audio (where it can also pick the output device).
// Noise removal is DeepFilterNet3 in a worker when you use AI noise removal and the device keeps up (at most a few
// voices at once), RNNoise otherwise. Everything runs on this device.
import type { RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor'
import type { RemoteAudioTrack } from 'livekit-client'
import remoteWorkletUrl from './audio/remote.worklet.ts?worker&url'
import { loadDeepFilter } from './audio/assets'
import { plannedEngine, SlowWatch } from './audio/engines'
import type { AudioSettings } from './audio'
import { startRnnoise } from './micPipeline'

/** More voices than this at once and incoming noise removal uses RNNoise (DeepFilterNet costs ~5% of a core each). */
export const MAX_AI_VOICES = 4
/** The worker falling behind this often (per 10 s) means it can't keep up. */
const MAX_UNDERRUNS = 5

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
  private worker: Worker | null = null
  private workerReady: Promise<boolean> | null = null
  private settings: AudioSettings
  private aiTooSlow = false
  private underruns: number[] = []
  private nextId = 0
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
    if (voice.workerId) this.worker?.postMessage({ type: 'drop', id: voice.workerId })
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
    const node = new AudioWorkletNode(this.ctx, 'iskra-df-bridge', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
    const channel = new MessageChannel()
    const id = String(++this.nextId)
    voice.workerId = id
    this.worker.postMessage({ type: 'voice', id, port: channel.port2 }, [channel.port2])
    node.port.postMessage({ port: channel.port1 }, [channel.port1])
    node.port.onmessage = (e: MessageEvent<{ type: string }>) => {
      if (e.data?.type === 'underrun') this.underrun()
    }
    return node
  }

  private startWorker(): Promise<boolean> {
    this.workerReady ??= (async () => {
      try {
        const assets = await loadDeepFilter()
        const worker = new Worker(new URL('./audio/deepfilter.worker.ts', import.meta.url), { type: 'module' })
        const watch = new SlowWatch()
        const ready = new Promise<boolean>((resolve) => {
          worker.onmessage = (e: MessageEvent<{ type: string; rtf?: number; busy?: number; message?: string }>) => {
            const m = e.data
            if (m.type === 'ready') resolve(true)
            else if (m.type === 'error') {
              console.warn('[iskra] incoming AI noise removal', m.message)
              resolve(false)
            } else if (m.type === 'load' && typeof m.busy === 'number') {
              console.info(`[iskra] incoming AI noise removal: worker ${(m.busy * 100).toFixed(1)}% busy, realtime factor ${m.rtf?.toFixed(3)} per voice`)
              if (watch.report(m.busy)) this.tooSlow()
            }
          }
          worker.onerror = () => resolve(false)
        })
        worker.postMessage({ type: 'init', module: assets.module, model: assets.model })
        this.worker = worker
        const ok = await ready
        if (!ok) {
          worker.terminate()
          this.worker = null
        }
        return ok
      } catch (e) {
        console.warn('[iskra] incoming AI noise removal could not start', e)
        return false
      }
    })()
    return this.workerReady
  }

  private underrun(): void {
    const now = Date.now()
    this.underruns = this.underruns.filter((t) => now - t < 10000)
    this.underruns.push(now)
    if (this.underruns.length > MAX_UNDERRUNS) this.tooSlow()
  }

  private tooSlow(): void {
    if (this.aiTooSlow) return
    console.warn('[iskra] incoming AI noise removal can\'t keep up here; using RNNoise for incoming voices')
    this.aiTooSlow = true
    void this.rebuild()
  }
}
