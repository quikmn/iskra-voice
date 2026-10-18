// The recorder's side of recording a call: one MediaRecorder per person's voice (Opus in WebM), plus an optional mix
// made with Web Audio, streamed a second at a time to files the desktop app writes. Who is in it comes from outside
// (state/recording.ts follows the server's voice state); this only starts and ends files to match.
import { RECORD_MIME, trackFileName, type RecordedFile } from '../recordingLogic'

/** Where the bytes go: the desktop app's recording folder (desktop/src/recordings.ts), or a fake in tests. */
export interface RecordSink {
  open(name: string): Promise<string | null>
  write(file: string, data: Uint8Array): Promise<'ok' | 'disk' | 'failed'>
  close(file: string): Promise<boolean>
}

/** What we use of MediaRecorder (so tests can hand in their own). */
export interface RecorderLike {
  state: string
  ondataavailable: ((event: { data: Blob }) => void) | null
  onstop: (() => void) | null
  start(timeslice: number): void
  stop(): void
}

export interface WantedTrack {
  accountKey: string
  /** The name the file gets ("Alex", "Alex screen audio"). */
  who: string
  track: MediaStreamTrack
}

export interface RecorderOptions {
  /** Also one file with everyone mixed together. */
  mixed: boolean
  /** Something can't be written (the disk is full, a file failed): the recording should stop. */
  onFail: (why: 'disk' | 'write') => void
  now?: () => number
  makeRecorder?: (stream: MediaStream) => RecorderLike
  makeStream?: (tracks: MediaStreamTrack[]) => MediaStream
  /** Null: no mix (tests, or no Web Audio here). */
  makeMixer?: () => Mixer | null
}

/** Everyone's voices added into one stream. */
export interface Mixer {
  stream: MediaStream
  add(key: string, track: MediaStreamTrack): void
  remove(key: string): void
  close(): void
}

/** How often MediaRecorder hands over what it has (and so the most lost if the app is killed). */
const SLICE_MS = 1000

/** One file being written from one stream. */
class FileWriter {
  private chain: Promise<unknown> = Promise.resolve()
  private stopped: Promise<void>
  private done = false
  bytes = 0
  readonly id: string
  private sink: RecordSink
  private recorder: RecorderLike
  private fail: (why: 'disk' | 'write') => void

  constructor(sink: RecordSink, id: string, recorder: RecorderLike, fail: (why: 'disk' | 'write') => void) {
    this.sink = sink
    this.id = id
    this.recorder = recorder
    this.fail = fail
    let resolveStopped: () => void = () => undefined
    this.stopped = new Promise((resolve) => (resolveStopped = resolve))
    recorder.ondataavailable = (event) => {
      const blob = event.data
      if (!blob?.size) return
      this.chain = this.chain.then(async () => {
        if (this.done) return
        const bytes = new Uint8Array(await blob.arrayBuffer())
        const result = await this.sink.write(this.id, bytes)
        if (result === 'ok') this.bytes += bytes.length
        else this.fail(result === 'disk' ? 'disk' : 'write')
      }).catch(() => this.fail('write'))
    }
    recorder.onstop = () => resolveStopped()
    recorder.start(SLICE_MS)
  }

  /** Stops recording and closes the file once its last bytes are written. */
  async stop(): Promise<void> {
    if (this.recorder.state !== 'inactive') {
      try {
        this.recorder.stop()
      } catch {
        /* already stopped */
      }
      // The last chunk arrives before onstop; never wait forever on a broken recorder.
      await Promise.race([this.stopped, new Promise((resolve) => setTimeout(resolve, 3000))])
    }
    await this.chain
    this.done = true
    await this.sink.close(this.id).catch(() => false)
  }
}

interface Part {
  key: string
  accountKey: string
  writer: FileWriter
  record: RecordedFile
}

export class CallRecorder {
  private readonly started: number
  private readonly parts = new Map<string, Part>()
  private readonly files: RecordedFile[] = []
  private readonly taken = new Set<string>()
  private mixer: Mixer | null = null
  private mixWriter: FileWriter | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private stopping = false
  private failed = false
  /** Bytes of files already finished. */
  private written = 0
  readonly now: () => number

  private sink: RecordSink
  private options: RecorderOptions

  constructor(sink: RecordSink, options: RecorderOptions) {
    this.sink = sink
    this.options = options
    this.now = options.now ?? (() => Date.now())
    this.started = this.now()
  }

  get startedAt(): number {
    return this.started
  }

  /** The mixed file was made. */
  get hasMix(): boolean {
    return !!this.mixWriter
  }

  /** Every file so far, in the order they started (open ones have `to: null`). */
  get recorded(): RecordedFile[] {
    return this.files.map((f) => ({ ...f }))
  }

  get bytes(): number {
    return this.written + [...this.parts.values()].reduce((sum, p) => sum + p.writer.bytes, 0) + (this.mixWriter?.bytes ?? 0)
  }

  /** Opens the mixed file (if wanted). Call once, before the first setTracks. */
  async begin(): Promise<void> {
    if (!this.options.mixed) return
    const mixer = (this.options.makeMixer ?? defaultMixer)()
    if (!mixer) return
    const id = await this.sink.open('mixed.webm')
    if (!id) {
      mixer.close()
      this.fail('write')
      return
    }
    this.mixer = mixer
    this.mixWriter = new FileWriter(this.sink, id, this.makeRecorder(mixer.stream), (why) => this.fail(why))
  }

  /** Makes the files match who should be recorded now: new people (or a new track) start a file, people left out end theirs. */
  setTracks(wanted: WantedTrack[]): Promise<void> {
    this.queue = this.queue.then(() => this.apply(wanted)).catch(() => undefined)
    return this.queue as Promise<void>
  }

  private async apply(wanted: WantedTrack[]): Promise<void> {
    if (this.stopping) return
    const next = new Map(wanted.filter((w) => w.track.readyState !== 'ended').map((w) => [`${w.accountKey}:${w.track.id}`, w]))
    for (const [key, part] of [...this.parts]) {
      if (next.has(key)) continue
      this.parts.delete(key)
      this.mixer?.remove(key)
      part.record.to = this.now() - this.started
      await part.writer.stop()
      this.written += part.writer.bytes
    }
    for (const [key, w] of next) {
      if (this.parts.has(key) || this.stopping || this.failed) continue
      const file = trackFileName(w.who, this.taken)
      this.taken.add(file.toLowerCase())
      const id = await this.sink.open(file)
      if (!id) {
        this.fail('write')
        return
      }
      const record: RecordedFile = { file, who: w.who, from: this.now() - this.started, to: null }
      this.files.push(record)
      const writer = new FileWriter(this.sink, id, this.makeRecorder(this.options.makeStream?.([w.track]) ?? new MediaStream([w.track])), (why) => this.fail(why))
      this.parts.set(key, { key, accountKey: w.accountKey, writer, record })
      this.mixer?.add(key, w.track)
    }
  }

  /** Ends every file. What was recorded stays. */
  async stop(): Promise<RecordedFile[]> {
    await this.queue
    this.stopping = true
    const end = this.now() - this.started
    const parts = [...this.parts.values()]
    this.parts.clear()
    for (const p of parts) p.record.to = end
    await Promise.all([...parts.map((p) => p.writer.stop()), this.mixWriter?.stop()])
    this.written += parts.reduce((sum, p) => sum + p.writer.bytes, 0)
    this.mixer?.close()
    this.mixer = null
    return this.recorded
  }

  private fail(why: 'disk' | 'write'): void {
    if (this.failed) return
    this.failed = true
    this.options.onFail(why)
  }

  private makeRecorder(stream: MediaStream): RecorderLike {
    return this.options.makeRecorder?.(stream) ?? (new MediaRecorder(stream, { mimeType: RECORD_MIME, audioBitsPerSecond: 64_000 }) as unknown as RecorderLike)
  }
}

/** Whether this app can record (WebM Opus recording). */
export function recordingSupported(): boolean {
  return typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(RECORD_MIME)
}

function defaultMixer(): Mixer | null {
  if (typeof AudioContext === 'undefined') return null
  const context = new AudioContext()
  const destination = context.createMediaStreamDestination()
  void context.resume().catch(() => undefined)
  const sources = new Map<string, MediaStreamAudioSourceNode>()
  return {
    stream: destination.stream,
    add(key, track) {
      if (sources.has(key)) return
      try {
        const source = context.createMediaStreamSource(new MediaStream([track]))
        source.connect(destination)
        sources.set(key, source)
      } catch {
        /* an ended track */
      }
    },
    remove(key) {
      sources.get(key)?.disconnect()
      sources.delete(key)
    },
    close() {
      for (const s of sources.values()) s.disconnect()
      sources.clear()
      void context.close().catch(() => undefined)
    },
  }
}
