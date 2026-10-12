// The pure logic of live captions, shared with its tests:
//   SpeechSegmenter  cuts one person's voice into phrases with Silero VAD (only speech is ever transcribed)
//   CaptionQueue     which phrase to transcribe next, what to skip when the device falls behind, and when to pause
//   RollingCaption   the last line or two someone said, as shown under their name
// No DOM: runs in the captions worker and in Node.

/** 32 ms at 16 kHz: one Silero VAD frame. */
export const FRAME = 512
const RATE = 16000
const FRAME_MS = (FRAME / RATE) * 1000

export interface SegmenterOptions {
  /** Speech probability that starts a phrase. */
  enter: number
  /** Below this the phrase starts to end (after the hangover). */
  exit: number
  /** Audio kept from before the detector noticed speech, so the first word is whole. */
  preRollMs: number
  /** Quiet this long ends the phrase. */
  hangoverMs: number
  /** Longer phrases are cut here (and carry on in the next one), so captions keep coming during long talks. */
  maxMs: number
  /** Phrases with less speech than this are dropped (coughs, clicks). */
  minSpeechMs: number
}

export const SEGMENT_DEFAULTS: SegmenterOptions = { enter: 0.5, exit: 0.35, preRollMs: 200, hangoverMs: 500, maxMs: 8000, minSpeechMs: 300 }

export class SpeechSegmenter {
  readonly options: SegmenterOptions
  /** In a phrase right now. */
  speaking = false
  private readonly pre: Float32Array[] = []
  private chunks: Float32Array[] = []
  private speechFrames = 0
  private quietFrames = 0
  private readonly preFrames: number
  private readonly hangFrames: number
  private readonly maxFrames: number
  private readonly minFrames: number

  constructor(options: Partial<SegmenterOptions> = {}) {
    this.options = { ...SEGMENT_DEFAULTS, ...options }
    this.preFrames = Math.round(this.options.preRollMs / FRAME_MS)
    this.hangFrames = Math.round(this.options.hangoverMs / FRAME_MS)
    this.maxFrames = Math.round(this.options.maxMs / FRAME_MS)
    this.minFrames = Math.round(this.options.minSpeechMs / FRAME_MS)
  }

  /** One 512-sample frame (copied) and its speech probability. Returns a finished phrase, if this ended one. */
  push(frame: Float32Array, probability: number): Float32Array | null {
    const copy = frame.slice(0, FRAME)
    if (!this.speaking) {
      this.pre.push(copy)
      if (this.pre.length > this.preFrames + 1) this.pre.shift()
      if (probability < this.options.enter) return null
      this.speaking = true
      this.chunks = this.pre.splice(0)
      this.speechFrames = 1
      this.quietFrames = 0
      return null
    }
    this.chunks.push(copy)
    if (probability >= this.options.exit) {
      this.speechFrames++
      this.quietFrames = 0
    } else {
      this.quietFrames++
    }
    if (this.quietFrames >= this.hangFrames) return this.finish(false)
    if (this.chunks.length >= this.maxFrames) return this.finish(true)
    return null
  }

  /** Ends the current phrase now (the person left, or captions stop). */
  flush(): Float32Array | null {
    return this.speaking ? this.finish(false) : null
  }

  private finish(continuing: boolean): Float32Array | null {
    // Trailing quiet adds nothing to the transcript: keep 100 ms of it.
    const keep = Math.max(0, this.chunks.length - Math.max(0, this.quietFrames - 3))
    const chunks = this.chunks.slice(0, keep)
    const enough = this.speechFrames >= this.minFrames
    this.chunks = []
    this.speechFrames = continuing ? 1 : 0
    this.quietFrames = 0
    this.speaking = continuing
    if (!enough) return null
    const out = new Float32Array(chunks.length * FRAME)
    chunks.forEach((c, i) => out.set(c, i * FRAME))
    return out
  }
}

// ── Scheduling ───────────────────────────────────────────────────────────

export interface Phrase {
  voice: string
  audio: Float32Array
  /** When it ended (ms, any clock). */
  at: number
}

export interface QueueOptions {
  /** Phrases older than this when their turn comes are skipped: late captions are worse than none. */
  maxLagMs: number
  /** At most this many phrases waiting, in all. */
  maxQueued: number
  /** Phrases from more people than this at once: the ones who just started wait or are skipped. */
  maxSpeakers: number
  /** Skipping this many phrases within `windowMs`, or one transcription taking longer than `slowMs`: pause. */
  maxSkips: number
  windowMs: number
  slowMs: number
  /** How long a pause lasts before trying again. */
  pauseMs: number
}

export const QUEUE_DEFAULTS: QueueOptions = { maxLagMs: 8000, maxQueued: 4, maxSpeakers: 3, maxSkips: 3, windowMs: 20000, slowMs: 7000, pauseMs: 20000 }

export class CaptionQueue {
  readonly options: QueueOptions
  private queue: Phrase[] = []
  private skips: number[] = []
  /** Paused until then (device too slow). */
  pausedUntil = 0
  /** Phrases skipped so far (for the benchmark and the log). */
  skipped = 0

  constructor(options: Partial<QueueOptions> = {}) {
    this.options = { ...QUEUE_DEFAULTS, ...options }
  }

  get length(): number {
    return this.queue.length
  }

  paused(now: number): boolean {
    return now < this.pausedUntil
  }

  add(phrase: Phrase, now: number): void {
    if (this.paused(now)) return
    const speakers = new Set(this.queue.map((p) => p.voice))
    if (!speakers.has(phrase.voice) && speakers.size >= this.options.maxSpeakers) return this.skip(now)
    this.queue.push(phrase)
    while (this.queue.length > this.options.maxQueued) {
      this.queue.shift()
      this.skip(now)
    }
  }

  /** The next phrase to transcribe, skipping the ones that got too old. */
  next(now: number): Phrase | null {
    if (this.paused(now)) {
      this.queue = []
      return null
    }
    while (this.queue.length) {
      const phrase = this.queue.shift()!
      if (now - phrase.at <= this.options.maxLagMs) return phrase
      this.skip(now)
      if (this.paused(now)) return null
    }
    return null
  }

  /** A transcription finished after `ms`. */
  done(ms: number, now: number): void {
    if (ms > this.options.slowMs) this.pause(now)
  }

  /** Someone left: forget their phrases. */
  drop(voice: string): void {
    this.queue = this.queue.filter((p) => p.voice !== voice)
  }

  private skip(now: number): void {
    this.skipped++
    this.skips = this.skips.filter((t) => now - t < this.options.windowMs)
    this.skips.push(now)
    if (this.skips.length >= this.options.maxSkips) this.pause(now)
  }

  private pause(now: number): void {
    this.pausedUntil = now + this.options.pauseMs
    this.queue = []
    this.skips = []
  }
}

// ── What's shown ─────────────────────────────────────────────────────────

/** About two lines of caption under a name. */
export const MAX_CAPTION_CHARS = 140
/** A caption fades this long after the person's last words. */
export const CAPTION_TTL_MS = 8000

/** Adds a phrase to what's shown for someone: the newest words, cut at a word so it stays about two lines. */
export function rollCaption(previous: string, text: string, max = MAX_CAPTION_CHARS): string {
  const joined = previous ? `${previous} ${text}` : text
  if (joined.length <= max) return joined
  const cut = joined.slice(joined.length - max)
  const space = cut.indexOf(' ')
  return space > 0 && space < 30 ? `…${cut.slice(space + 1)}` : `…${cut}`
}

/** Strips what Whisper says when it hears something it can't make out (music, noise, "[BLANK_AUDIO]"). */
export function cleanCaption(text: string): string {
  return text.replace(/\[[^\]]*\]|\([^)]*\)|♪+/g, ' ').replace(/\s+/g, ' ').trim()
}
