// Cleans an MP4 or QuickTime video for a photos channel by changing bytes in place: nothing moves, nothing is
// re-encoded, the file keeps its length. Inside the movie header, the boxes that carry metadata (udta, meta, uuid:
// location, make, model, software, XMP) become "free" boxes filled with zeros; every track that isn't video, audio or a
// timecode (timed metadata such as GPS tracks, subtitles) is removed the same way and its samples in the file are
// overwritten with zeros; handler names are blanked. Top-level uuid, meta and udta boxes go too. The creation and
// modification times stay only when the uploader keeps the date. The server does the same again for channels it can
// read (server Files/Mp4Metadata.cs). Only the headers are read: a video of any size is cleaned without loading it.

export class VideoRefused extends Error {}

export const MAX_MOOV_BYTES = 64 * 1024 * 1024

/** Bytes to write at `offset`: `data`, or `zeros` zero bytes. */
export interface Patch {
  offset: number
  data?: Uint8Array
  zeros?: number
}

export interface VideoPlan {
  patches: Patch[]
  /** The movie's creation time (Unix ms), read before cleaning; null if it has none. */
  createdAt: number | null
}

/** Reads `length` bytes at `offset` (fewer at the end of the file). */
export type ReadAt = (offset: number, length: number) => Promise<Uint8Array>

const KEPT_HANDLERS = new Set(['vide', 'soun', 'tmcd'])
const METADATA_BOXES = new Set(['udta', 'meta', 'uuid'])
const FREE = Uint8Array.of(0x66, 0x72, 0x65, 0x65)
/** Seconds between 1904 (the MP4 epoch) and 1970. */
const EPOCH_1904 = 2082844800

const fourcc = (b: Uint8Array, at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3])
const u32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
const u64 = (b: Uint8Array, at: number) => u32(b, at) * 2 ** 32 + u32(b, at + 4)

interface Box {
  start: number
  size: number
  header: number
  type: string
}

function children(b: Uint8Array, from: number, to: number): Box[] {
  const list: Box[] = []
  let at = from
  while (at + 8 <= to) {
    let size = u32(b, at)
    let header = 8
    if (size === 1) {
      if (at + 16 > to) break
      size = u64(b, at + 8)
      header = 16
    } else if (size === 0) size = to - at
    if (size < header || at + size > to) break
    list.push({ start: at, size, header, type: fourcc(b, at + 4) })
    at += size
  }
  return list
}

const child = (b: Uint8Array, parent: Box, type: string) =>
  children(b, parent.start + parent.header, parent.start + parent.size).find((box) => box.type === type)

/** Turns a box into a "free" box of the same size, filled with zeros. */
function free(b: Uint8Array, box: Box): void {
  b.set(FREE, box.start + 4)
  b.fill(0, box.start + box.header, box.start + box.size)
}

/** mvhd, tkhd and mdhd start with a version byte, three flag bytes, then the creation and modification times. */
function clearDates(b: Uint8Array, box: Box): void {
  const p = box.start + box.header
  const bytes = b[p] === 1 ? 16 : 8
  if (p + 4 + bytes <= box.start + box.size) b.fill(0, p + 4, p + 4 + bytes)
}

/** Where a track's samples are in the file: one range per chunk. */
function sampleRanges(b: Uint8Array, mdia: Box | undefined): { offset: number; count: number }[] {
  const ranges: { offset: number; count: number }[] = []
  const minf = mdia && child(b, mdia, 'minf')
  const stbl = minf && child(b, minf, 'stbl')
  if (!stbl) return ranges
  const sz = child(b, stbl, 'stsz')
  const sc = child(b, stbl, 'stsc')
  const stco = child(b, stbl, 'stco')
  const co64 = child(b, stbl, 'co64')
  const offsets = stco ?? co64
  if (!offsets) return ranges
  if (!sz || !sc) throw new VideoRefused("This video has an extra track that can't be cleaned.")
  const damaged = () => new VideoRefused('The video is damaged.')

  const szAt = sz.start + sz.header
  if (sz.size < sz.header + 12) throw damaged()
  const fixedSize = u32(b, szAt + 4)
  const sampleCount = u32(b, szAt + 8)
  if (fixedSize === 0 && sz.size < sz.header + 12 + 4 * sampleCount) throw damaged()
  const scAt = sc.start + sc.header
  const scCount = sc.size >= sc.header + 8 ? u32(b, scAt + 4) : 0
  if (sc.size < sc.header + 8 + 12 * scCount) throw damaged()
  const wide = !stco
  const coAt = offsets.start + offsets.header
  const chunkCount = offsets.size >= offsets.header + 8 ? u32(b, coAt + 4) : 0
  if (offsets.size < offsets.header + 8 + (wide ? 8 : 4) * chunkCount) throw damaged()

  let sample = 0
  let entry = 0
  let perChunk = 0
  for (let chunk = 1; chunk <= chunkCount; chunk++) {
    while (entry < scCount && u32(b, scAt + 8 + entry * 12) <= chunk) {
      perChunk = u32(b, scAt + 8 + entry * 12 + 4)
      entry++
    }
    let bytes = 0
    for (let k = 0; k < perChunk && sample < sampleCount; k++, sample++) bytes += fixedSize !== 0 ? fixedSize : u32(b, szAt + 12 + sample * 4)
    const at = coAt + 8 + (chunk - 1) * (wide ? 8 : 4)
    const offset = wide ? u64(b, at) : u32(b, at)
    if (bytes > 0) ranges.push({ offset, count: bytes })
  }
  return ranges
}

/** Cleans the movie header in place. Returns the file ranges of removed tracks' samples, or null if no track was removed. */
function cleanMoov(moov: Uint8Array, headerLength: number, keepDate: boolean): { offset: number; count: number }[] | null {
  let ranges: { offset: number; count: number }[] | null = null
  for (const box of children(moov, headerLength, moov.length)) {
    if (box.type === 'mvhd') {
      if (!keepDate) clearDates(moov, box)
    } else if (METADATA_BOXES.has(box.type)) free(moov, box)
    else if (box.type === 'trak') {
      const mdia = child(moov, box, 'mdia')
      const hdlr = mdia && child(moov, mdia, 'hdlr')
      const handler = hdlr && hdlr.size >= hdlr.header + 12 ? fourcc(moov, hdlr.start + hdlr.header + 8) : ''
      if (!KEPT_HANDLERS.has(handler)) {
        ranges ??= []
        ranges.push(...sampleRanges(moov, mdia))
        free(moov, box)
        continue
      }
      for (const inner of children(moov, box.start + box.header, box.start + box.size)) {
        if (inner.type === 'tkhd') {
          if (!keepDate) clearDates(moov, inner)
        } else if (METADATA_BOXES.has(inner.type)) free(moov, inner)
        else if (inner.type === 'mdia') {
          for (const media of children(moov, inner.start + inner.header, inner.start + inner.size)) {
            if (media.type === 'mdhd') {
              if (!keepDate) clearDates(moov, media)
            } else if (media.type === 'hdlr') {
              if (media.size > media.header + 24) moov.fill(0, media.start + media.header + 24, media.start + media.size) // the handler's name
            } else if (METADATA_BOXES.has(media.type)) free(moov, media)
          }
        }
      }
    }
  }
  return ranges
}

function createdAtOf(moov: Uint8Array, headerLength: number): number | null {
  const mvhd = children(moov, headerLength, moov.length).find((box) => box.type === 'mvhd')
  if (!mvhd) return null
  const p = mvhd.start + mvhd.header
  if (p + 20 > mvhd.start + mvhd.size) return null
  const seconds = moov[p] === 1 ? u64(moov, p + 4) : u32(moov, p + 4)
  // Cameras without a clock write 0 (1904); anything before 1990 isn't a real recording date.
  return seconds > EPOCH_1904 + 631152000 ? (seconds - EPOCH_1904) * 1000 : null
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i])

/** What to change in the file (no patches: it is clean already). Throws `VideoRefused` for files it can't clean. */
export async function planVideo(read: ReadAt, length: number, keepDate: boolean): Promise<VideoPlan> {
  const patches: Patch[] = []
  let createdAt: number | null = null
  let at = 0
  let hasMoov = false
  let fragmented = false
  let droppedTracks = false
  while (at + 8 <= length) {
    const header = await read(at, 16)
    if (header.length < 8) break
    let size = u32(header, 0)
    const type = fourcc(header, 4)
    let headerLength = 8
    if (size === 1) {
      if (header.length < 16) throw new VideoRefused('The video is damaged.')
      size = u64(header, 8)
      headerLength = 16
    } else if (size === 0) size = length - at
    if (size < headerLength || at + size > length) {
      if (hasMoov) break // junk after the movie: players ignore it
      throw new VideoRefused('The video is damaged.')
    }
    if (type === 'moov') {
      if (hasMoov) throw new VideoRefused('The video has two movie headers.')
      if (size > MAX_MOOV_BYTES) throw new VideoRefused("The video's header is too large to clean.")
      hasMoov = true
      const original = await read(at, size)
      if (original.length !== size) throw new VideoRefused('The video is damaged.')
      createdAt = createdAtOf(original, headerLength)
      const moov = original.slice()
      const ranges = cleanMoov(moov, headerLength, keepDate)
      droppedTracks = ranges !== null
      if (!same(moov, original)) patches.push({ offset: at, data: moov })
      for (const range of ranges ?? []) {
        if (range.count > 0 && range.offset + range.count <= length) patches.push({ offset: range.offset, zeros: range.count })
      }
    } else if (METADATA_BOXES.has(type)) {
      patches.push({ offset: at + 4, data: FREE })
      if (size > headerLength) patches.push({ offset: at + headerLength, zeros: size - headerLength })
    } else if (type === 'moof') fragmented = true
    at += size
  }
  if (!hasMoov) throw new VideoRefused('The video has no movie header.')
  if (fragmented && droppedTracks) throw new VideoRefused("This video keeps extra tracks in fragments, which can't be cleaned.")
  return { patches, createdAt }
}

/** The pieces of the file with the patches applied, in order: slices of the original and the new bytes. */
export function patchedParts(file: Blob, patches: Patch[]): (Blob | Uint8Array)[] {
  const sorted = [...patches].sort((a, b) => a.offset - b.offset)
  const parts: (Blob | Uint8Array)[] = []
  let at = 0
  for (const patch of sorted) {
    const length = patch.data ? patch.data.length : patch.zeros ?? 0
    if (patch.offset < at || length === 0) continue // inside something already replaced (samples within a box that was zeroed)
    if (patch.offset > at) parts.push(file.slice(at, patch.offset))
    parts.push(patch.data ?? new Uint8Array(length))
    at = patch.offset + length
  }
  if (at < file.size) parts.push(file.slice(at))
  return parts
}

/** The cleaned video (the same Blob if nothing had to change) and its creation time. */
export async function cleanVideo(file: Blob, keepDate: boolean): Promise<{ blob: Blob; createdAt: number | null }> {
  const read: ReadAt = async (offset, length) => new Uint8Array(await file.slice(offset, Math.min(file.size, offset + length)).arrayBuffer())
  const { patches, createdAt } = await planVideo(read, file.size, keepDate)
  if (patches.length === 0) return { blob: file, createdAt }
  return { blob: new Blob(patchedParts(file, patches) as BlobPart[], { type: file.type }), createdAt }
}

/** Brands of ISO files that are pictures (HEIC, AVIF), which look like MP4 from their first bytes. */
const PICTURE_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1', 'avif', 'avis'])

/** Whether these first bytes are an MP4 or MOV video (not a HEIC or AVIF picture). */
export function isVideoHead(head: Uint8Array): boolean {
  return head.length >= 12 && fourcc(head, 4) === 'ftyp' && !PICTURE_BRANDS.has(fourcc(head, 8))
}
