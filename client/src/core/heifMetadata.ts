// Cleans a HEIC or AVIF picture (what iPhones and newer Android phones take) for a photos channel by changing bytes in
// place: the file keeps its length and the coded picture is not touched, so the original keeps its full quality.
// A HEIF file is a list of items: the picture (often as tiles in a grid, with a thumbnail and helper pictures), and
// next to them an Exif item, often an XMP item, sometimes more. An allowlist: picture items stay as they are; the Exif
// item is overwritten with a minimal block (which way up it is and, when the uploader keeps it, the date taken, as in
// core/photoMetadata.ts); every other item (XMP and anything unknown) is overwritten with zeros. udta and uuid boxes
// become "free" boxes of zeros. The server does the same again for channels it can read (server Files/HeifMetadata.cs).
import { buildExif, readExif, type Kept } from './photoMetadata'
import type { Patch, ReadAt } from './mp4Metadata'

export class HeifRefused extends Error {}

export const MAX_META_BYTES = 16 * 1024 * 1024
/** Metadata items bigger than this aren't read to compare; they are overwritten whatever they hold. */
const MAX_ITEM_BYTES = 8 * 1024 * 1024

/** Item types that are coded pictures or are built from them. */
const PICTURE_ITEMS = new Set(['hvc1', 'hev1', 'av01', 'avc1', 'vvc1', 'jpeg', 'grid', 'iovl', 'iden', 'tmap'])
const FREED_BOXES = new Set(['udta', 'uuid'])
const FREE = Uint8Array.of(0x66, 0x72, 0x65, 0x65)
const EXIF_PREFIX = Uint8Array.of(0, 0, 0, 6, 0x45, 0x78, 0x69, 0x66, 0, 0) // the TIFF block starts 6 bytes on: after "Exif\0\0"
const EMPTY_TIFF = Uint8Array.of(0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0)

const fourcc = (b: Uint8Array, at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3])
const u16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1]
const u32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
const u64 = (b: Uint8Array, at: number) => u32(b, at) * 2 ** 32 + u32(b, at + 4)
/** An unsigned number of 0, 4 or 8 bytes (0 bytes reads as 0), as iloc stores its fields. */
function sized(b: Uint8Array, at: number, size: number): number {
  if (size === 0) return 0
  if (size === 4) return u32(b, at)
  if (size === 8) return u64(b, at)
  throw new HeifRefused('The picture is damaged.')
}

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

interface Extent {
  /** In the file. */
  offset: number
  length: number
}

/** item id → its type, from the item information box. */
function itemTypes(meta: Uint8Array, iinf: Box): Map<number, string> {
  const types = new Map<number, string>()
  const p = iinf.start + iinf.header
  const version = meta[p]
  const first = p + 4 + (version === 0 ? 2 : 4)
  for (const infe of children(meta, first, iinf.start + iinf.size)) {
    if (infe.type !== 'infe') continue
    const q = infe.start + infe.header
    const v = meta[q]
    if (v < 2) throw new HeifRefused("This picture's format is too old to clean.")
    const id = v === 2 ? u16(meta, q + 4) : u32(meta, q + 4)
    const at = q + 4 + (v === 2 ? 2 : 4) + 2
    if (at + 4 > infe.start + infe.size) throw new HeifRefused('The picture is damaged.')
    types.set(id, fourcc(meta, at))
  }
  return types
}

/** item id → where its bytes are in the file, from the item location box. */
function itemExtents(meta: Uint8Array, iloc: Box, metaOffset: number, idat: Box | undefined): Map<number, Extent[]> {
  const damaged = () => new HeifRefused('The picture is damaged.')
  const items = new Map<number, Extent[]>()
  const end = iloc.start + iloc.size
  let p = iloc.start + iloc.header
  const version = meta[p]
  if (version > 2 || p + 8 > end) throw damaged()
  const offsetSize = meta[p + 4] >> 4
  const lengthSize = meta[p + 4] & 15
  const baseSize = meta[p + 5] >> 4
  const indexSize = version > 0 ? meta[p + 5] & 15 : 0
  p += 6
  const count = version < 2 ? u16(meta, p) : u32(meta, p)
  p += version < 2 ? 2 : 4
  for (let i = 0; i < count; i++) {
    if (p + 8 > end) throw damaged()
    const id = version < 2 ? u16(meta, p) : u32(meta, p)
    p += version < 2 ? 2 : 4
    let method = 0
    if (version > 0) {
      method = u16(meta, p) & 15
      p += 2
    }
    p += 2 // data reference index
    const base = sized(meta, p, baseSize)
    p += baseSize
    const extentCount = u16(meta, p)
    p += 2
    const extents: Extent[] = []
    for (let e = 0; e < extentCount; e++) {
      if (p + indexSize + offsetSize + lengthSize > end) throw damaged()
      p += indexSize
      const offset = sized(meta, p, offsetSize)
      p += offsetSize
      const length = sized(meta, p, lengthSize)
      p += lengthSize
      if (method === 0) extents.push({ offset: base + offset, length })
      else if (method === 1 && idat) extents.push({ offset: metaOffset + idat.start + idat.header + base + offset, length })
      else throw new HeifRefused("This picture stores its parts in a way that can't be cleaned.")
    }
    items.set(id, extents)
  }
  return items
}

/** What takes the place of an Exif item: the minimal block (or an empty one), padded with zeros to the same length. */
function exifReplacement(length: number, kept: Kept, keepDate: boolean): Uint8Array {
  const out = new Uint8Array(length)
  const tiff = buildExif(kept, keepDate) ?? EMPTY_TIFF
  for (const block of [tiff, EMPTY_TIFF]) {
    if (EXIF_PREFIX.length + block.length <= length) {
      out.set(EXIF_PREFIX)
      out.set(block, EXIF_PREFIX.length)
      break
    }
  }
  return out
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i])

export interface HeifPlan {
  patches: Patch[]
  /** What the picture's Exif said, read before cleaning. */
  kept: Kept
}

/** What to change in the file (no patches: it is clean already). Throws `HeifRefused` for files it can't clean. */
export async function planHeif(read: ReadAt, length: number, keepDate: boolean): Promise<HeifPlan> {
  const patches: Patch[] = []
  let kept: Kept = { orientation: 1, date: null, offset: null }
  let hasMeta = false
  let at = 0
  while (at + 8 <= length) {
    const header = await read(at, 16)
    if (header.length < 8) break
    let size = u32(header, 0)
    const type = fourcc(header, 4)
    let headerLength = 8
    if (size === 1) {
      if (header.length < 16) throw new HeifRefused('The picture is damaged.')
      size = u64(header, 8)
      headerLength = 16
    } else if (size === 0) size = length - at
    if (size < headerLength || at + size > length) {
      if (hasMeta) break
      throw new HeifRefused('The picture is damaged.')
    }
    if (type === 'moov' || type === 'moof') throw new HeifRefused("Picture sequences and animations in this format can't be added.")
    if (type === 'meta') {
      if (hasMeta) throw new HeifRefused('The picture is damaged.')
      if (size > MAX_META_BYTES) throw new HeifRefused("The picture's header is too large to clean.")
      hasMeta = true
      const original = await read(at, size)
      if (original.length !== size) throw new HeifRefused('The picture is damaged.')
      const meta = original.slice()
      const boxes = children(meta, headerLength + 4, meta.length) // a full box: version and flags first
      for (const box of boxes) {
        if (!FREED_BOXES.has(box.type)) continue
        meta.set(FREE, box.start + 4)
        meta.fill(0, box.start + box.header, box.start + box.size)
      }
      const metaStart = at
      const iinf = boxes.find((b) => b.type === 'iinf')
      const iloc = boxes.find((b) => b.type === 'iloc')
      if (!iinf || !iloc) throw new HeifRefused('The picture is damaged.')
      const types = itemTypes(meta, iinf)
      const extents = itemExtents(meta, iloc, at, boxes.find((b) => b.type === 'idat'))
      for (const [id, parts] of extents) {
        const itemType = types.get(id) ?? ''
        if (PICTURE_ITEMS.has(itemType)) continue
        const total = parts.reduce((n, e) => n + e.length, 0)
        if (total === 0) continue
        if (parts.some((e) => e.length === 0 || e.offset + e.length > length)) throw new HeifRefused('The picture is damaged.')
        // An item kept inside the header itself (idat) is changed there, with the header.
        const inMeta = (e: Extent) => e.offset >= metaStart && e.offset + e.length <= metaStart + size
        if (total > MAX_ITEM_BYTES) {
          for (const e of parts) {
            if (inMeta(e)) meta.fill(0, e.offset - metaStart, e.offset - metaStart + e.length)
            else patches.push({ offset: e.offset, zeros: e.length })
          }
          continue
        }
        const current = new Uint8Array(total)
        let filled = 0
        for (const e of parts) {
          current.set(await read(e.offset, e.length), filled)
          filled += e.length
        }
        let replacement: Uint8Array = new Uint8Array(total)
        if (itemType === 'Exif') {
          // The item starts with the distance from byte 4 to its TIFF block.
          const skip = total >= 4 ? u32(current, 0) : 0
          if (4 + skip < total) kept = readExif(current.subarray(4 + skip))
          replacement = exifReplacement(total, kept, keepDate)
        }
        if (same(current, replacement)) continue
        let done = 0
        for (const e of parts) {
          const piece = replacement.slice(done, done + e.length)
          if (inMeta(e)) meta.set(piece, e.offset - metaStart)
          else patches.push({ offset: e.offset, data: piece })
          done += e.length
        }
      }
      if (!same(meta, original)) patches.push({ offset: metaStart, data: meta })
    } else if (FREED_BOXES.has(type)) {
      const body = size - headerLength
      const current = body > 0 && body <= MAX_ITEM_BYTES ? await read(at + headerLength, body) : null
      patches.push({ offset: at + 4, data: FREE })
      if (body > 0 && !(current && current.every((v) => v === 0))) patches.push({ offset: at + headerLength, zeros: body })
    }
    at += size
  }
  if (!hasMeta) throw new HeifRefused('The picture has no header.')
  return { patches, kept }
}

/** The ISO brands that are HEIC (HEVC-coded) and AVIF pictures. */
const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx'])
const AVIF_BRANDS = new Set(['avif', 'avis'])
const GENERIC_BRANDS = new Set(['mif1', 'msf1', 'miaf'])

/** 'image/heic' or 'image/avif' if these first bytes are a HEIF picture, else null (the server's FileSniffer decides the same way). */
export function heifType(head: Uint8Array): 'image/heic' | 'image/avif' | null {
  if (head.length < 12 || fourcc(head, 4) !== 'ftyp') return null
  const major = fourcc(head, 8)
  if (AVIF_BRANDS.has(major)) return 'image/avif'
  if (HEIC_BRANDS.has(major)) return 'image/heic'
  if (!GENERIC_BRANDS.has(major)) return null
  // A generic brand: the list of compatible brands says which codec it is.
  const end = Math.min(head.length, u32(head, 0))
  let found: 'image/heic' | 'image/avif' = 'image/heic'
  for (let at = 16; at + 4 <= end; at += 4) if (AVIF_BRANDS.has(fourcc(head, at))) found = 'image/avif'
  return found
}
