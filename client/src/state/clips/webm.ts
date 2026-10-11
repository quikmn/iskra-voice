// Just enough WebM (Matroska) for clips: a streaming reader that turns MediaRecorder's live output into frames, and a
// writer that puts frames from one or two recordings back into a small, seekable file (with Duration and Cues).
// No decoding: frames are copied as they are, so cutting happens at frame (video: keyframe) boundaries.

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  CodecID: 0x86,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  ReferenceBlock: 0xfb,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
} as const

/** Elements that end a cluster of unknown size (they live next to clusters in the segment). */
const SEGMENT_LEVEL = new Set([ID.Cluster, ID.Info, ID.Tracks, ID.Cues, 0x114d9b74, 0x1254c367, 0x1043a770, 0x1941a469])

export interface TrackInfo {
  type: 'video' | 'audio'
  codec: string
  /** The TrackEntry's children without TrackNumber and TrackUID (the writer numbers tracks itself). */
  entry: Uint8Array
}

export interface Frame {
  /** Milliseconds from the start of its recording (the reader) or on a shared clock (once in a ring). */
  time: number
  key: boolean
  /** SimpleBlock flags (keyframe, invisible, lacing, discardable). */
  flags: number
  /** The block's frame data, after its track number, timecode and flags. */
  data: Uint8Array
}

// ── EBML primitives ─────────────────────────────────────────────────────────

const UNKNOWN = -1

/** Reads an element id (with its marker bits) at `at`: [id, length], or null if more bytes are needed. */
function readId(buf: Uint8Array, at: number): [number, number] | null {
  if (at >= buf.length) return null
  const first = buf[at]
  const length = first >= 0x80 ? 1 : first >= 0x40 ? 2 : first >= 0x20 ? 3 : first >= 0x10 ? 4 : 0
  if (length === 0) throw new Error('bad element id')
  if (at + length > buf.length) return null
  let id = 0
  for (let i = 0; i < length; i++) id = id * 256 + buf[at + i]
  return [id, length]
}

/** Reads a size vint: [value or UNKNOWN, length], or null if more bytes are needed. */
function readSize(buf: Uint8Array, at: number): [number, number] | null {
  if (at >= buf.length) return null
  const first = buf[at]
  let length = 1
  while (length <= 8 && !(first & (0x100 >> length))) length++
  if (length > 8) throw new Error('bad size')
  if (at + length > buf.length) return null
  let value = first & (0xff >> length)
  let allOnes = value === 0xff >> length
  for (let i = 1; i < length; i++) {
    value = value * 256 + buf[at + i]
    if (buf[at + i] !== 0xff) allOnes = false
  }
  return [allOnes ? UNKNOWN : value, length]
}

function readUint(bytes: Uint8Array): number {
  let n = 0
  for (const b of bytes) n = n * 256 + b
  return n
}

/** The children of a master element's payload: [id, payload, raw bytes]. */
function children(payload: Uint8Array): [number, Uint8Array, Uint8Array][] {
  const out: [number, Uint8Array, Uint8Array][] = []
  let at = 0
  while (at < payload.length) {
    const id = readId(payload, at)
    const size = id && readSize(payload, at + id[1])
    if (!id || !size || size[0] === UNKNOWN) throw new Error('bad child element')
    const start = at + id[1] + size[1]
    const end = start + size[0]
    if (end > payload.length) throw new Error('truncated element')
    out.push([id[0], payload.subarray(start, end), payload.subarray(at, end)])
    at = end
  }
  return out
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

// ── Reading ─────────────────────────────────────────────────────────────────

/**
 * Reads a WebM byte stream as it arrives (MediaRecorder chunks split elements anywhere). Calls `onTracks` once the
 * track list is in, then `onFrame` for each frame of every track, in order. Throws on bytes that aren't WebM.
 */
export class WebmReader {
  onTracks: (tracks: TrackInfo[]) => void = () => {}
  onFrame: (track: number, frame: Frame) => void = () => {}
  private buf: Uint8Array = new Uint8Array(0)
  private state: 'top' | 'segment' | 'cluster' = 'top'
  /** Bytes still to drop from an element we don't need (they may not have arrived yet). */
  private skipping = 0
  /** Stream offset where a cluster of known size ends. */
  private clusterEnd: number | null = null
  private consumed = 0
  private clusterTime = 0
  private scale = 1_000_000
  /** Track number → index in the track list. */
  private numbers = new Map<number, number>()

  push(chunk: Uint8Array): void {
    this.buf = this.buf.length ? concat([this.buf, chunk]) : chunk.slice()
    let at = 0
    for (;;) {
      if (this.skipping > 0) {
        const n = Math.min(this.skipping, this.buf.length - at)
        this.skipping -= n
        at += n
        if (this.skipping > 0) break
      }
      if (this.state === 'cluster' && this.clusterEnd !== null && this.consumed + at >= this.clusterEnd) {
        this.state = 'segment'
        this.clusterEnd = null
      }
      const id = readId(this.buf, at)
      const size = id && readSize(this.buf, at + id[1])
      if (!id || !size) break
      const [type, length] = [id[0], size[0]]
      const header = id[1] + size[1]

      if (this.state === 'top') {
        if (type === ID.Segment) {
          this.state = 'segment'
          at += header
          continue
        }
        if (length === UNKNOWN) throw new Error('unexpected element')
        this.skipping = length
        at += header
        continue
      }
      if (type === ID.Cluster) {
        this.state = 'cluster'
        this.clusterEnd = length === UNKNOWN ? null : this.consumed + at + header + length
        this.clusterTime = 0
        at += header
        continue
      }
      if (this.state === 'cluster' && SEGMENT_LEVEL.has(type)) {
        this.state = 'segment' // a cluster of unknown size ends where the next segment-level element starts
        this.clusterEnd = null
        continue
      }
      if (length === UNKNOWN) throw new Error('unexpected element of unknown size')
      const wanted = this.state === 'segment'
        ? type === ID.Info || type === ID.Tracks
        : type === ID.Timecode || type === ID.SimpleBlock || type === ID.BlockGroup
      if (!wanted) {
        this.skipping = length
        at += header
        continue
      }
      if (at + header + length > this.buf.length) break // wait for the whole element
      this.element(type, this.buf.subarray(at + header, at + header + length))
      at += header + length
    }
    this.consumed += at
    this.buf = at >= this.buf.length ? new Uint8Array(0) : this.buf.subarray(at)
  }

  private element(type: number, payload: Uint8Array): void {
    if (type === ID.Info) {
      for (const [id, value] of children(payload)) if (id === ID.TimecodeScale) this.scale = readUint(value) || 1_000_000
    } else if (type === ID.Tracks) {
      const tracks: TrackInfo[] = []
      for (const [id, entry] of children(payload)) {
        if (id !== ID.TrackEntry) continue
        let number = 0
        let kind = 0
        let codec = ''
        const rest: Uint8Array[] = []
        for (const [child, value, raw] of children(entry)) {
          if (child === ID.TrackNumber) number = readUint(value)
          else if (child === ID.TrackUID) continue
          else {
            if (child === ID.TrackType) kind = readUint(value)
            if (child === ID.CodecID) codec = new TextDecoder().decode(value)
            rest.push(raw)
          }
        }
        if (!number || (kind !== 1 && kind !== 2)) continue
        this.numbers.set(number, tracks.length)
        tracks.push({ type: kind === 1 ? 'video' : 'audio', codec, entry: concat(rest) })
      }
      this.onTracks(tracks)
    } else if (type === ID.Timecode) {
      this.clusterTime = readUint(payload)
    } else if (type === ID.SimpleBlock) {
      this.block(payload, null)
    } else if (type === ID.BlockGroup) {
      let block: Uint8Array | null = null
      let referenced = false
      for (const [id, value] of children(payload)) {
        if (id === ID.Block) block = value
        if (id === ID.ReferenceBlock) referenced = true
      }
      if (block) this.block(block, !referenced)
    }
  }

  /** A SimpleBlock, or a Block from a BlockGroup (`key` then comes from the group, not the flags). */
  private block(payload: Uint8Array, key: boolean | null): void {
    const track = readSize(payload, 0)
    if (!track || track[0] === UNKNOWN || payload.length < track[1] + 3) throw new Error('bad block')
    const index = this.numbers.get(track[0])
    if (index === undefined) return
    const at = track[1]
    const relative = (payload[at] << 24 >> 16) | payload[at + 1] // int16, big-endian
    const raw = payload[at + 2]
    const isKey = key ?? !!(raw & 0x80)
    const flags = (raw & 0x0f) | (isKey ? 0x80 : 0)
    const time = ((this.clusterTime + relative) * this.scale) / 1_000_000
    this.onFrame(index, { time, key: isKey, flags, data: payload.slice(at + 3) })
  }
}

// ── Writing ─────────────────────────────────────────────────────────────────

function idBytes(id: number): Uint8Array {
  const out: number[] = []
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256)
  return Uint8Array.from(out)
}

/** A size vint in the fewest bytes (or exactly `width` bytes). */
function sizeBytes(n: number, width?: number): Uint8Array {
  let length = width ?? 1
  while (!width && n >= 2 ** (7 * length) - 1) length++
  const out = new Uint8Array(length)
  let v = n
  for (let i = length - 1; i >= 0; i--) {
    out[i] = v % 256
    v = Math.floor(v / 256)
  }
  out[0] |= 0x80 >> (length - 1)
  return out
}

function uintBytes(n: number, width?: number): Uint8Array {
  const out: number[] = []
  for (let v = Math.max(0, Math.floor(n)); v > 0; v = Math.floor(v / 256)) out.unshift(v % 256)
  while (out.length < (width ?? 1)) out.unshift(0)
  return Uint8Array.from(out)
}

const el = (id: number, ...payload: Uint8Array[]): Uint8Array => {
  const body = concat(payload)
  return concat([idBytes(id), sizeBytes(body.length), body])
}
const uint = (id: number, n: number, width?: number) => el(id, uintBytes(n, width))
const text = (id: number, s: string) => el(id, new TextEncoder().encode(s))
function float(id: number, n: number): Uint8Array {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setFloat64(0, n)
  return el(id, bytes)
}

export interface MuxTrack {
  info: TrackInfo
  /** Frames on one clock shared by every track, oldest first. A video track should start with a keyframe. */
  frames: Frame[]
}

/** Longest gap between a cluster's start and a frame in it (block timecodes are 16-bit). */
const MAX_CLUSTER_MS = 30_000
/** Without video, a new cluster (and a seek point) every so often. */
const AUDIO_CLUSTER_MS = 2_000

/**
 * A complete WebM file from the given tracks: time 0 is the earliest frame. Clusters start at video keyframes (or
 * every 2 s without video), each listed in Cues, so the file seeks well. Returns the bytes and the duration (ms).
 */
export function muxWebm(tracks: MuxTrack[]): { bytes: Uint8Array; duration: number } {
  const used = tracks.filter((t) => t.frames.length > 0)
  const ordered = [...used.filter((t) => t.info.type === 'video'), ...used.filter((t) => t.info.type === 'audio')]
  const hasVideo = ordered.some((t) => t.info.type === 'video')
  const all = ordered
    .flatMap((t, i) => t.frames.map((f) => ({ ...f, track: i + 1, video: t.info.type === 'video' })))
    .sort((a, b) => a.time - b.time || a.track - b.track)
  const origin = all.length ? all[0].time : 0
  const last = all.length ? all[all.length - 1].time - origin : 0
  const duration = all.length ? last + (hasVideo ? 33 : 20) : 0

  // Clusters.
  type Cluster = { start: number; cue: boolean; blocks: Uint8Array[] }
  const clusters: Cluster[] = []
  let current: Cluster | null = null
  for (const f of all) {
    const t = Math.round(f.time - origin)
    const startsHere = !current || (f.video && f.key) || t - current.start > MAX_CLUSTER_MS || (!hasVideo && t - current.start >= AUDIO_CLUSTER_MS)
    if (startsHere) {
      current = { start: t, cue: hasVideo ? f.video && f.key : true, blocks: [] }
      clusters.push(current)
    }
    const relative = t - current!.start
    const head = new Uint8Array([0x80 | f.track, (relative >> 8) & 0xff, relative & 0xff, f.flags])
    current!.blocks.push(el(ID.SimpleBlock, head, f.data))
  }
  const clusterBytes = clusters.map((c) => el(ID.Cluster, uint(ID.Timecode, c.start), ...c.blocks))

  const info = el(ID.Info, uint(ID.TimecodeScale, 1_000_000), text(ID.MuxingApp, 'Iskra'), text(ID.WritingApp, 'Iskra'), float(ID.Duration, duration))
  const trackList = el(ID.Tracks, ...ordered.map((t, i) => el(ID.TrackEntry, uint(ID.TrackNumber, i + 1), uint(ID.TrackUID, i + 1), t.info.entry)))
  const cueTrack = 1 // video if there is any, else the (first) audio track
  // Cluster positions take a fixed 8 bytes, so the Cues' size doesn't depend on where the clusters land.
  const cuesFor = (positions: number[]) => el(ID.Cues, ...clusters.flatMap((c, i) => c.cue
    ? [el(ID.CuePoint, uint(ID.CueTime, c.start), el(ID.CueTrackPositions, uint(ID.CueTrack, cueTrack), uint(ID.CueClusterPosition, positions[i], 8)))]
    : []))
  const before = info.length + trackList.length + cuesFor(clusters.map(() => 0)).length
  const positions: number[] = []
  let offset = before
  for (const bytes of clusterBytes) {
    positions.push(offset)
    offset += bytes.length
  }
  const cues = cuesFor(positions)
  const segment = concat([info, trackList, cues, ...clusterBytes])

  const ebml = el(ID.EBML,
    uint(0x4286, 1), uint(0x42f7, 1), uint(0x42f2, 4), uint(0x42f3, 8), text(0x4282, 'webm'), uint(0x4287, 4), uint(0x4285, 2))
  return { bytes: concat([ebml, idBytes(ID.Segment), sizeBytes(segment.length, 8), segment]), duration }
}

/** For tests: a SimpleBlock-based live WebM like MediaRecorder writes (Segment and Clusters of unknown size). */
export function liveWebm(tracks: { type: 'video' | 'audio'; codec: string }[], clusters: { time: number; blocks: { track: number; at: number; key: boolean; data: number[] }[] }[]): Uint8Array {
  const unknown = new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
  const entries = tracks.map((t, i) => el(ID.TrackEntry, uint(ID.TrackNumber, i + 1), uint(ID.TrackUID, 99 + i), uint(ID.TrackType, t.type === 'video' ? 1 : 2), text(ID.CodecID, t.codec)))
  const parts = [
    el(ID.EBML, text(0x4282, 'webm')),
    idBytes(ID.Segment), unknown,
    el(ID.Info, uint(ID.TimecodeScale, 1_000_000)),
    el(ID.Tracks, ...entries),
  ]
  for (const c of clusters) {
    parts.push(idBytes(ID.Cluster), unknown, uint(ID.Timecode, c.time))
    for (const b of c.blocks) {
      const rel = b.at - c.time
      parts.push(el(ID.SimpleBlock, new Uint8Array([0x80 | b.track, (rel >> 8) & 0xff, rel & 0xff, b.key ? 0x80 : 0]), Uint8Array.from(b.data)))
    }
  }
  return concat(parts)
}

/** For tests: reads a whole file back. */
export function readWebm(bytes: Uint8Array): { tracks: TrackInfo[]; frames: { track: number; frame: Frame }[] } {
  const reader = new WebmReader()
  const out: { tracks: TrackInfo[]; frames: { track: number; frame: Frame }[] } = { tracks: [], frames: [] }
  reader.onTracks = (tracks) => (out.tracks = tracks)
  reader.onFrame = (track, frame) => out.frames.push({ track, frame })
  reader.push(bytes)
  return out
}
