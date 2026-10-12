// The camera's background effect as a LiveKit track processor: LiveKit hands it the camera track and sends what it
// makes instead (also when the camera is switched or turned off and on). The work happens in background.worker.ts.
// Used for the call and, on its own, for the preview in Settings → Camera.
import type { Track, TrackProcessor, VideoProcessorOptions } from 'livekit-client'
import { BLUR_FILES } from '../models'
import { EffectWatch, type Backdrop, type BackgroundMode, type EffectWindow } from './effects'

export interface Look {
  mode: Exclude<BackgroundMode, 'off'>
  backdrop: Backdrop
  color: string
}

export interface ProcessorEvents {
  /** Two seconds of measurements. */
  onStats?: (w: EffectWindow) => void
  /** The device can't keep up: the processor stops sending its own frames from now on. */
  onSlow?: (w: EffectWindow) => void
  /** It couldn't start here (the camera is then sent as it is). */
  onFailed?: (message: string) => void
}

/** How long loading the model may take before giving up (the first time it's downloaded, about 12 MB). */
const READY_TIMEOUT_MS = 30000

type Generator = MediaStreamTrack & { writable: WritableStream<VideoFrame> }
declare const MediaStreamTrackProcessor: { new (init: { track: MediaStreamTrack; maxBufferSize?: number }): { readable: ReadableStream<VideoFrame> } } | undefined
declare const MediaStreamTrackGenerator: { new (init: { kind: 'video' }): Generator } | undefined

/** Insertable streams: frames go to the worker and back without touching this thread. */
const streamsAvailable = () =>
  typeof MediaStreamTrackProcessor === 'function' && typeof MediaStreamTrackGenerator === 'function' && typeof VideoFrame === 'function'

/** WebGL2 in a worker and WebAssembly: what the effect needs at the very least. */
export function effectsSupported(): boolean {
  return typeof Worker === 'function' && typeof OffscreenCanvas === 'function' && typeof createImageBitmap === 'function' &&
    typeof WebAssembly === 'object' && 'getContext' in OffscreenCanvas.prototype
}

export class BackgroundProcessor implements TrackProcessor<Track.Kind.Video, VideoProcessorOptions> {
  readonly name = 'iskra-background'
  processedTrack?: MediaStreamTrack
  /** It runs (false before init, after a failure, and once it gave up for being too slow). */
  running = false
  private look: Look
  private readonly events: ProcessorEvents
  private worker: Worker | null = null
  private source: MediaStreamTrack | null = null
  private video: HTMLVideoElement | null = null
  private ownVideo = false
  private output: HTMLCanvasElement | null = null
  private renderer: ImageBitmapRenderingContext | null = null
  private streams = false
  private inFlight = false
  private inputFrames = 0
  private stopped = false
  private readonly watch = new EffectWatch()
  private frameRequest = 0

  constructor(look: Look, events: ProcessorEvents = {}) {
    this.look = look
    this.events = events
  }

  setLook(look: Look): void {
    this.look = look
    this.worker?.postMessage({ type: 'look', look })
  }

  async init(opts: VideoProcessorOptions): Promise<void> {
    this.source = opts.track
    const ok = await this.startWorker()
    if (!ok || this.stopped) return
    this.streams = streamsAvailable()
    if (this.streams) {
      const generator = new MediaStreamTrackGenerator!({ kind: 'video' })
      const { readable } = new MediaStreamTrackProcessor!({ track: opts.track, maxBufferSize: 1 })
      this.worker!.postMessage({ type: 'streams', readable, writable: generator.writable }, [readable, generator.writable] as unknown as Transferable[])
      this.processedTrack = generator
    } else {
      this.output = document.createElement('canvas')
      this.renderer = this.output.getContext('bitmaprenderer')
      if (!this.renderer) return this.fail('no bitmaprenderer')
      this.processedTrack = this.output.captureStream().getVideoTracks()[0]
      this.attachVideo(opts.track, opts.element)
      this.requestFrame()
    }
    this.running = true
  }

  async restart(opts: VideoProcessorOptions): Promise<void> {
    if (!this.running || opts.track === this.source) return
    this.source = opts.track
    if (this.streams) {
      const { readable } = new MediaStreamTrackProcessor!({ track: opts.track, maxBufferSize: 1 })
      this.worker?.postMessage({ type: 'streams', readable }, [readable] as unknown as Transferable[])
    } else {
      this.attachVideo(opts.track, opts.element)
      this.requestFrame()
    }
  }

  async destroy(): Promise<void> {
    this.stopped = true
    this.running = false
    if (this.video && this.frameRequest && 'cancelVideoFrameCallback' in this.video) this.video.cancelVideoFrameCallback(this.frameRequest)
    if (this.ownVideo && this.video) this.video.srcObject = null
    this.worker?.postMessage({ type: 'close' })
    this.worker = null
    this.processedTrack?.stop()
  }

  private startWorker(): Promise<boolean> {
    const worker = new Worker(new URL('./background.worker.ts', import.meta.url), { type: 'module' })
    this.worker = worker
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.fail('timed out')
        resolve(false)
      }, READY_TIMEOUT_MS)
      worker.onmessage = (e: MessageEvent<{ type: string; message?: string }>) => {
        if (e.data.type === 'ready') {
          clearTimeout(timer)
          worker.onmessage = (m) => this.onWorker(m)
          resolve(true)
        } else if (e.data.type === 'error') {
          clearTimeout(timer)
          this.fail(e.data.message ?? 'error')
          resolve(false)
        }
      }
      worker.onerror = (e) => {
        clearTimeout(timer)
        this.fail(e.message || 'worker failed')
        resolve(false)
      }
      worker.postMessage({ type: 'init', loader: BLUR_FILES.loader, wasm: BLUR_FILES.wasm, model: BLUR_FILES.model, look: this.look })
    })
  }

  private fail(message: string): void {
    console.warn('[iskra] background effect could not start', message)
    this.running = false
    this.worker?.terminate()
    this.worker = null
    this.events.onFailed?.(message)
  }

  private onWorker(e: MessageEvent<{ type: string; bitmap?: ImageBitmap; fps?: number; frameMs?: number; message?: string }>): void {
    const m = e.data
    if (m.type === 'frame' && m.bitmap) {
      this.inFlight = false
      if (this.stopped) m.bitmap.close()
      else this.renderer?.transferFromImageBitmap(m.bitmap)
    } else if (m.type === 'stats') {
      const nominal = this.source?.getSettings().frameRate ?? 30
      const w: EffectWindow = { inputFps: this.streams ? nominal : this.inputFrames / 2, outputFps: m.fps ?? 0, frameMs: m.frameMs ?? 0 }
      this.inputFrames = 0
      this.events.onStats?.(w)
      if (this.watch.report(w)) {
        console.warn(`[iskra] background effect can't keep up here (${w.outputFps.toFixed(1)} fps, ${w.frameMs.toFixed(1)} ms per frame); turning it off`)
        this.events.onSlow?.(w)
      }
    } else if (m.type === 'error') {
      this.inFlight = false
      console.warn('[iskra] background effect', m.message)
    }
  }

  // ── Without insertable streams: a <video> plays the camera, and each new frame goes to the worker ──

  private attachVideo(track: MediaStreamTrack, element?: HTMLMediaElement): void {
    if (element instanceof HTMLVideoElement) {
      this.video = element // LiveKit plays the camera in it already
      this.ownVideo = false
    } else {
      if (!this.video || !this.ownVideo) {
        this.video = document.createElement('video')
        this.video.muted = true
        this.video.playsInline = true
        this.ownVideo = true
      }
      this.video.srcObject = new MediaStream([track])
      void this.video.play().catch(() => undefined)
    }
  }

  private requestFrame(): void {
    const video = this.video
    if (!video || this.stopped) return
    if ('requestVideoFrameCallback' in video) this.frameRequest = video.requestVideoFrameCallback(() => this.onFrame())
    else setTimeout(() => this.onFrame(), 33)
  }

  private onFrame(): void {
    if (this.stopped) return
    const video = this.video
    this.inputFrames++
    if (video && !this.inFlight && this.worker && video.videoWidth > 0) {
      this.inFlight = true
      createImageBitmap(video).then((bitmap) => {
        if (this.stopped || !this.worker) return bitmap.close()
        this.worker.postMessage({ type: 'frame', bitmap }, [bitmap])
      }, () => {
        this.inFlight = false
      })
    }
    this.requestFrame()
  }
}
