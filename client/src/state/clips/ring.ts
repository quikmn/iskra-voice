// The rolling buffer behind clips: encoded frames from the last couple of minutes, bounded by time and by bytes, and
// the maths for picking and trimming a clip out of it. Pure (no browser APIs), so it's unit-tested.
import type { Frame, MuxTrack, TrackInfo } from './webm'

export const MIN_CLIP_SECONDS = 15
export const MAX_CLIP_SECONDS = 120
export const DEFAULT_CLIP_SECONDS = 30
/** A trimmed clip is at least this long. */
export const MIN_TRIM_MS = 1000

export const clampSeconds = (n: number): number =>
  Number.isFinite(n) ? Math.min(MAX_CLIP_SECONDS, Math.max(MIN_CLIP_SECONDS, Math.round(n))) : DEFAULT_CLIP_SECONDS

/**
 * One recording's frames on the shared clock (ms), oldest first. Keeps `keepMs` of history; for video, also the
 * keyframe the oldest kept frame depends on. Never more than `maxBytes` (oldest frames go first, video up to the next
 * keyframe so what's left still decodes).
 */
export class FrameRing {
  info: TrackInfo | null = null
  private frames: Frame[] = []
  private head = 0
  private size = 0
  readonly keepMs: number
  readonly maxBytes: number

  constructor(keepMs: number, maxBytes: number) {
    this.keepMs = keepMs
    this.maxBytes = maxBytes
  }

  get bytes(): number {
    return this.size
  }

  /** Frames currently kept, oldest first. */
  list(): Frame[] {
    return this.frames.slice(this.head)
  }

  clear(info: TrackInfo | null = null): void {
    this.info = info
    this.frames = []
    this.head = 0
    this.size = 0
  }

  add(frame: Frame): void {
    this.frames.push(frame)
    this.size += frame.data.length
    this.prune(frame.time)
  }

  private get video(): boolean {
    return this.info?.type === 'video'
  }

  /** Drops what's older than `keepMs` before `now`, then whatever is over the byte limit. */
  prune(now: number): void {
    const cutoff = now - this.keepMs
    let drop = this.head
    if (this.video) {
      // Keep from the last keyframe at or before the cutoff.
      let keep = drop
      for (let i = drop; i < this.frames.length && this.frames[i].time <= cutoff; i++) if (this.frames[i].key) keep = i
      drop = keep
    } else {
      while (drop < this.frames.length && this.frames[drop].time < cutoff) drop++
    }
    this.dropTo(drop)
    while (this.size > this.maxBytes && this.frames.length - this.head > 1) {
      let next = this.head + 1
      if (this.video) while (next < this.frames.length && !this.frames[next].key) next++
      if (next >= this.frames.length) {
        this.clear(this.info) // one huge keyframe group: nothing usable is left
        return
      }
      this.dropTo(next)
    }
  }

  private dropTo(index: number): void {
    for (let i = this.head; i < index; i++) this.size -= this.frames[i].data.length
    this.head = index
    if (this.head > 512 && this.head * 2 > this.frames.length) {
      this.frames = this.frames.slice(this.head)
      this.head = 0
    }
  }
}

/** A clip taken from the rings: frames on the shared clock, `start` the clip's time 0, `duration` in ms. */
export interface ClipDraft {
  video: MuxTrack | null
  audio: MuxTrack | null
  start: number
  duration: number
}

/** The keyframe a video starting at `from` has to start at: the last one at or before it, else the first after it. */
export function keyframeAtOrBefore(frames: Frame[], from: number): number {
  let found = -1
  for (let i = 0; i < frames.length; i++) {
    if (!frames[i].key) continue
    if (frames[i].time <= from || found < 0) found = i
    if (frames[i].time > from) break
  }
  return found
}

/**
 * The last `seconds` before `end`: audio from the window's start, video from the keyframe at or before it (so the clip
 * opens on a picture; it may then start a little earlier). Null if there's nothing to save.
 */
export function clipWindow(
  video: { info: TrackInfo; frames: Frame[] } | null,
  audio: { info: TrackInfo; frames: Frame[] } | null,
  end: number,
  seconds: number,
): ClipDraft | null {
  const want = end - seconds * 1000
  let start = want
  let videoTrack: MuxTrack | null = null
  if (video && video.frames.length) {
    const k = keyframeAtOrBefore(video.frames, want)
    if (k >= 0 && video.frames[k].time <= end) {
      const frames = video.frames.slice(k).filter((f) => f.time <= end)
      videoTrack = { info: video.info, frames }
      start = Math.min(start, frames[0].time)
    }
  }
  const audioFrames = audio ? audio.frames.filter((f) => f.time >= start && f.time <= end) : []
  const audioTrack = audio && audioFrames.length ? { info: audio.info, frames: audioFrames } : null
  if (!videoTrack && !audioTrack) return null
  const first = Math.min(videoTrack?.frames[0].time ?? Infinity, audioTrack?.frames[0].time ?? Infinity)
  const lastFrame = Math.max(videoTrack?.frames.at(-1)!.time ?? -Infinity, audioTrack?.frames.at(-1)!.time ?? -Infinity)
  return { video: videoTrack, audio: audioTrack, start: first, duration: Math.max(0, lastFrame - first) }
}

/** A valid trim range in ms from the clip's start: inside the clip, at least MIN_TRIM_MS long (or the whole clip). */
export function clampTrim(duration: number, from: number, to: number): { from: number; to: number } {
  const total = Math.max(0, duration)
  if (total <= MIN_TRIM_MS) return { from: 0, to: total }
  let a = Math.min(Math.max(0, from), total)
  let b = Math.min(Math.max(0, to), total)
  if (b < a) [a, b] = [b, a]
  if (b - a < MIN_TRIM_MS) {
    b = Math.min(total, a + MIN_TRIM_MS)
    a = Math.max(0, b - MIN_TRIM_MS)
  }
  return { from: a, to: b }
}

/**
 * The part of a clip between `from` and `to` (ms from its start). Video can only start on a keyframe, so the start moves
 * back to the one before `from` when there is video; `from` in the result is where it really starts.
 */
export function trimDraft(draft: ClipDraft, from: number, to: number): { draft: ClipDraft; from: number; to: number } {
  const range = clampTrim(draft.duration, from, to)
  let startAt = draft.start + range.from
  const endAt = draft.start + range.to
  let video: MuxTrack | null = null
  if (draft.video) {
    const k = keyframeAtOrBefore(draft.video.frames, startAt)
    if (k >= 0 && draft.video.frames[k].time <= endAt) {
      startAt = Math.min(startAt, draft.video.frames[k].time)
      video = { info: draft.video.info, frames: draft.video.frames.slice(k).filter((f) => f.time <= endAt) }
    }
  }
  const audioFrames = draft.audio ? draft.audio.frames.filter((f) => f.time >= startAt && f.time <= endAt) : []
  const audio = draft.audio && audioFrames.length ? { info: draft.audio.info, frames: audioFrames } : null
  return {
    draft: { video, audio, start: startAt, duration: endAt - startAt },
    from: startAt - draft.start,
    to: range.to,
  }
}
