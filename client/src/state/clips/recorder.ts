// The browser side of clips: mixes every incoming audio track with Web Audio, records the mix (and the screen share
// you're watching) with MediaRecorder, and feeds the WebM into rolling buffers. Nothing leaves the device.
import { clipWindow, FrameRing, MAX_CLIP_SECONDS, type ClipDraft } from './ring'
import { WebmReader } from './webm'

const AUDIO_TYPE = 'audio/webm;codecs=opus'
const VIDEO_TYPES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
/** How often MediaRecorder hands over what it has. */
const SLICE_MS = 500
/** History kept beyond the longest clip, for the keyframe a clip may need before its start. */
const SLACK_MS = 5_000
const MAX_AUDIO_BYTES = 8 * 1024 * 1024
const MAX_VIDEO_BYTES = 160 * 1024 * 1024

/** Whether this browser can make clips (WebM recording and Web Audio; not iOS web views). */
export function clipsSupported(): boolean {
  return typeof MediaRecorder !== 'undefined' && typeof AudioContext !== 'undefined' &&
    typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(AUDIO_TYPE)
}

/** One MediaRecorder writing into a ring, with frames put on the page's clock. */
class Recording {
  readonly ring: FrameRing
  private recorder: MediaRecorder
  private reader = new WebmReader()
  private origin = performance.now()
  private chain: Promise<void> = Promise.resolve()
  private flushWaiters: (() => void)[] = []
  failed = false

  constructor(stream: MediaStream, options: MediaRecorderOptions, maxBytes: number) {
    this.ring = new FrameRing((MAX_CLIP_SECONDS * 1000) + SLACK_MS, maxBytes)
    this.reader.onTracks = (tracks) => this.ring.clear(tracks[0] ?? null)
    this.reader.onFrame = (track, frame) => {
      if (track === 0) this.ring.add({ ...frame, time: this.origin + frame.time })
    }
    this.recorder = new MediaRecorder(stream, options)
    this.recorder.onstart = () => (this.origin = performance.now())
    this.recorder.ondataavailable = (e) => {
      const blob = e.data
      this.chain = this.chain.then(async () => {
        if (this.failed || !blob.size) return
        try {
          this.reader.push(new Uint8Array(await blob.arrayBuffer()))
        } catch {
          this.failed = true // not WebM after all: this recording gives nothing
        }
      }).finally(() => {
        const waiters = this.flushWaiters
        this.flushWaiters = []
        for (const w of waiters) w()
      })
    }
    this.recorder.start(SLICE_MS)
  }

  /** Waits for what's been recorded so far to be in the ring. */
  flush(): Promise<void> {
    if (this.recorder.state !== 'recording') return this.chain
    return new Promise((resolve) => {
      this.flushWaiters.push(resolve)
      this.recorder.requestData()
      setTimeout(resolve, 1500) // never hang the button
    })
  }

  stop(): void {
    if (this.recorder.state !== 'inactive') this.recorder.stop()
    this.ring.clear()
  }
}

export class ClipRecorder {
  private context: AudioContext
  private destination: MediaStreamAudioDestinationNode
  private sources = new Map<string, MediaStreamAudioSourceNode>()
  private audio: Recording | null = null
  private video: Recording | null = null
  private videoTrackId: string | null = null

  constructor() {
    this.context = new AudioContext()
    this.destination = this.context.createMediaStreamDestination()
    void this.context.resume().catch(() => undefined)
    this.audio = new Recording(this.destination.stream, { mimeType: AUDIO_TYPE, audioBitsPerSecond: 96_000 }, MAX_AUDIO_BYTES)
  }

  /** Adds an incoming audio track to the mix (keyed by its id). */
  addAudio(id: string, track: MediaStreamTrack): void {
    if (this.sources.has(id)) return
    try {
      const source = this.context.createMediaStreamSource(new MediaStream([track]))
      source.connect(this.destination)
      this.sources.set(id, source)
    } catch {
      /* an ended track: nothing to hear */
    }
  }

  removeAudio(id: string): void {
    this.sources.get(id)?.disconnect()
    this.sources.delete(id)
  }

  /** The video to keep (the screen share you're watching), or null. A new one starts a fresh video buffer. */
  setVideo(track: MediaStreamTrack | null): void {
    const id = track && track.readyState === 'live' ? track.id : null
    if (id === this.videoTrackId) return
    this.video?.stop()
    this.video = null
    this.videoTrackId = id
    if (!track || !id) return
    const mimeType = VIDEO_TYPES.find((t) => MediaRecorder.isTypeSupported(t))
    if (!mimeType) return
    try {
      // A keyframe every 2 s (where supported), so a clip can start close to where you asked.
      const options = { mimeType, videoBitsPerSecond: 5_000_000, videoKeyFrameIntervalDuration: 2000 } as MediaRecorderOptions
      this.video = new Recording(new MediaStream([track]), options, MAX_VIDEO_BYTES)
    } catch {
      this.video = null
    }
  }

  /** The last `seconds` of what came in, or null if nothing was recorded yet. */
  async snapshot(seconds: number): Promise<ClipDraft | null> {
    void this.context.resume().catch(() => undefined)
    await Promise.all([this.audio?.flush(), this.video?.flush()])
    const end = performance.now()
    const pick = (r: Recording | null) => (r && !r.failed && r.ring.info ? { info: r.ring.info, frames: r.ring.list() } : null)
    return clipWindow(pick(this.video), pick(this.audio), end, seconds)
  }

  stop(): void {
    this.audio?.stop()
    this.video?.stop()
    this.audio = null
    this.video = null
    for (const s of this.sources.values()) s.disconnect()
    this.sources.clear()
    void this.context.close().catch(() => undefined)
  }
}
