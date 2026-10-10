// Records one voice message with MediaRecorder, sampling loudness for the waveform as it goes.
import { MAX_VOICE_MS, encodeWaveform, extensionFor, pickRecordingType, waveformBars } from './voiceMessage'

export interface Recording {
  file: File
  duration: number
  waveform: string
}

export const voiceRecordingSupported = () =>
  typeof window !== 'undefined' && typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

const SAMPLE_MS = 50

export class VoiceRecorder {
  private stream: MediaStream | null = null
  private recorder: MediaRecorder | null = null
  private context: AudioContext | null = null
  private sampler: ReturnType<typeof setInterval> | null = null
  private chunks: Blob[] = []
  private startedAt = 0
  private cancelled = false
  /** Loudness samples (RMS, 0–1), one every 50 ms. */
  readonly levels: number[] = []

  /** Called with each new level, and once when the 5-minute limit is reached. */
  private readonly onLevel: (level: number) => void
  private readonly onLimit: () => void

  constructor(onLevel: (level: number) => void, onLimit: () => void) {
    this.onLevel = onLevel
    this.onLimit = onLimit
  }

  get elapsed(): number {
    return this.startedAt ? Math.min(MAX_VOICE_MS, performance.now() - this.startedAt) : 0
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    if (this.cancelled) return this.release()
    const type = pickRecordingType((t) => MediaRecorder.isTypeSupported(t))
    this.recorder = new MediaRecorder(this.stream, type ? { mimeType: type, audioBitsPerSecond: 32_000 } : { audioBitsPerSecond: 32_000 })
    this.recorder.ondataavailable = (e) => e.data.size > 0 && this.chunks.push(e.data)
    this.recorder.start(1000)
    this.startedAt = performance.now()

    try {
      this.context = new AudioContext()
      void this.context.resume()
      const analyser = this.context.createAnalyser()
      analyser.fftSize = 1024
      this.context.createMediaStreamSource(this.stream).connect(analyser)
      const buffer = new Float32Array(analyser.fftSize)
      this.sampler = setInterval(() => {
        analyser.getFloatTimeDomainData(buffer)
        let sum = 0
        for (const v of buffer) sum += v * v
        const level = Math.min(1, Math.sqrt(sum / buffer.length) * 3)
        this.levels.push(level)
        this.onLevel(level)
        if (this.elapsed >= MAX_VOICE_MS) this.onLimit()
      }, SAMPLE_MS)
    } catch {
      // No Web Audio: still record, with a flat waveform; the limit still applies.
      this.sampler = setInterval(() => this.elapsed >= MAX_VOICE_MS && this.onLimit(), 500)
    }
  }

  /** Stops and hands back the file, or null if nothing usable was recorded. */
  async stop(): Promise<Recording | null> {
    const recorder = this.recorder
    const duration = Math.round(this.elapsed)
    if (!recorder || recorder.state === 'inactive') {
      this.release()
      return null
    }
    const done = new Promise<void>((resolve) => (recorder.onstop = () => resolve()))
    recorder.stop()
    await done
    this.release()
    const type = recorder.mimeType || this.chunks[0]?.type || 'audio/webm'
    const blob = new Blob(this.chunks, { type })
    if (duration < 500 || blob.size === 0) return null
    const ext = extensionFor(type)
    return {
      file: new File([blob], `voice-message.${ext}`, { type: type.split(';')[0] }),
      duration: Math.min(MAX_VOICE_MS, Math.max(1, duration)),
      waveform: encodeWaveform(waveformBars(this.levels)),
    }
  }

  cancel(): void {
    this.cancelled = true
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.onstop = null
      this.recorder.stop()
    }
    this.release()
  }

  private release(): void {
    if (this.sampler) clearInterval(this.sampler)
    this.sampler = null
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    void this.context?.close().catch(() => undefined)
    this.context = null
  }
}
