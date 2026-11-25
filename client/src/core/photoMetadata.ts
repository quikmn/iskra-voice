// Cleans a picture for a photos channel before it leaves the device, without decoding it: the pixels stay exactly as
// they were. An allowlist: only what drawing the picture needs stays (with its colour profile), plus a new, minimal
// EXIF block with which way up it is and, when the uploader keeps it, the date and time taken with its time zone
// offset. Location, camera make, model and serial numbers, lens, software, owner and copyright fields, maker notes,
// comments, XMP and embedded thumbnails all go. The server does the same again for channels it can read
// (server Files/PhotoMetadata.cs); both write the same bytes. See "Photos channels" in PROTOCOL.md.

export class PhotoRefused extends Error {}

/** What is kept from a picture's EXIF block. */
export interface Kept {
  /** 1 (upright) to 8. */
  orientation: number
  /** "2026:07:14 18:30:05" */
  date: string | null
  /** "+02:00" */
  offset: string | null
}

const NOTHING: Kept = { orientation: 1, date: null, offset: null }

export const PICTURE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const
export type PictureType = (typeof PICTURE_TYPES)[number]
export const isPictureType = (type: string): type is PictureType => (PICTURE_TYPES as readonly string[]).includes(type)

const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0))
const text = (bytes: Uint8Array) => String.fromCharCode(...bytes)
const startsWith = (data: Uint8Array, at: number, prefix: Uint8Array) =>
  at + prefix.length <= data.length && prefix.every((b, i) => data[at + i] === b)

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

// ── EXIF ────────────────────────────────────────────────────────────────────

export const isExifDate = (s: string | null | undefined): s is string =>
  !!s && /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(s) && s !== '0000:00:00 00:00:00'
export const isExifOffset = (s: string | null | undefined): s is string => !!s && /^[+-]\d{2}:\d{2}$/.test(s)

/** Reads the orientation and the date taken from a TIFF block (the inside of an EXIF segment). Never throws. */
export function readExif(tiff: Uint8Array): Kept {
  if (tiff.length < 8) return NOTHING
  let little: boolean
  if (tiff[0] === 0x49 && tiff[1] === 0x49) little = true
  else if (tiff[0] === 0x4d && tiff[1] === 0x4d) little = false
  else return NOTHING
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength)
  const u16 = (at: number) => view.getUint16(at, little)
  const u32 = (at: number) => view.getUint32(at, little)
  if (u16(2) !== 42) return NOTHING

  const entries = (ifd: number) => {
    const list: { tag: number; kind: number; count: number; at: number }[] = []
    if (ifd < 8 || ifd + 2 > tiff.length) return list
    const n = u16(ifd)
    for (let i = 0; i < n; i++) {
      const at = ifd + 2 + i * 12
      if (at + 12 > tiff.length) break
      list.push({ tag: u16(at), kind: u16(at + 2), count: u32(at + 4), at: at + 8 })
    }
    return list
  }
  const str = (e: { kind: number; count: number; at: number }): string | null => {
    if (e.kind !== 2 || e.count < 1 || e.count > 64) return null
    const start = e.count <= 4 ? e.at : u32(e.at)
    if (start + e.count > tiff.length) return null
    let bytes = tiff.subarray(start, start + e.count)
    const end = bytes.indexOf(0)
    if (end >= 0) bytes = bytes.subarray(0, end)
    if (bytes.some((b) => b < 0x20 || b > 0x7e)) return null
    return text(bytes)
  }

  let orientation = 1
  let date: string | null = null
  let original: string | null = null
  let digitized: string | null = null
  let offset: string | null = null
  let exifIfd = 0
  for (const e of entries(u32(4))) {
    if (e.tag === 0x0112 && e.kind === 3 && e.count === 1) {
      const o = u16(e.at)
      if (o >= 1 && o <= 8) orientation = o
    } else if (e.tag === 0x0132) date = str(e)
    else if (e.tag === 0x8769 && e.kind === 4 && e.count === 1) exifIfd = u32(e.at)
  }
  if (exifIfd > 0) {
    for (const e of entries(exifIfd)) {
      if (e.tag === 0x9003) original = str(e)
      else if (e.tag === 0x9004) digitized = str(e)
      else if (e.tag === 0x9011) offset = str(e)
    }
  }
  const taken = [original, digitized, date].find(isExifDate) ?? null
  return { orientation, date: taken, offset: taken && isExifOffset(offset) ? offset : null }
}

/**
 * A TIFF block with only what is kept (big-endian; tags in ascending order), or null when there is nothing to keep:
 * the picture is upright and has no date (or the date isn't kept).
 */
export function buildExif(kept: Kept, keepDate: boolean): Uint8Array | null {
  const orientation = kept.orientation >= 2 && kept.orientation <= 8 ? kept.orientation : 0
  const date = keepDate && isExifDate(kept.date) ? kept.date : null
  const offset = date && isExifOffset(kept.offset) ? kept.offset : null
  if (!orientation && !date) return null

  const ifd0Count = (orientation ? 1 : 0) + (date ? 1 : 0)
  const exifAt = 8 + 2 + ifd0Count * 12 + 4
  const exifCount = !date ? 0 : offset ? 2 : 1
  const dateAt = exifAt + (date ? 2 + exifCount * 12 + 4 : 0)
  const offsetAt = dateAt + 20
  const total = !date ? exifAt : offset ? offsetAt + 8 : dateAt + 20

  const b = new Uint8Array(total)
  const view = new DataView(b.buffer)
  let at = 2
  const p16 = (v: number) => {
    view.setUint16(at, v)
    at += 2
  }
  const p32 = (v: number) => {
    view.setUint32(at, v)
    at += 4
  }
  b[0] = 0x4d
  b[1] = 0x4d
  p16(42)
  p32(8)
  p16(ifd0Count)
  if (orientation) {
    p16(0x0112); p16(3); p32(1); p16(orientation); p16(0)
  }
  if (date) {
    p16(0x8769); p16(4); p32(1); p32(exifAt)
  }
  p32(0)
  if (date) {
    p16(exifCount)
    p16(0x9003); p16(2); p32(20); p32(dateAt)
    if (offset) {
      p16(0x9011); p16(2); p32(7); p32(offsetAt)
    }
    p32(0)
    b.set(ascii(date), dateAt)
    if (offset) b.set(ascii(offset), offsetAt)
  }
  return b
}

/** The date taken as Unix milliseconds. Without a time zone offset it is read as this device's local time. */
export function exifTime(kept: Pick<Kept, 'date' | 'offset'>): number | null {
  if (!isExifDate(kept.date)) return null
  const [day, time] = kept.date.split(' ')
  const iso = `${day.replace(/:/g, '-')}T${time}${isExifOffset(kept.offset) ? kept.offset : ''}`
  const ms = Date.parse(iso)
  return Number.isFinite(ms) && ms > 0 ? ms : null
}

// ── JPEG ────────────────────────────────────────────────────────────────────

const EXIF_HEADER = ascii('Exif\0\0')
const JFIF = ascii('JFIF\0')
const ICC = ascii('ICC_PROFILE\0')
const ADOBE = ascii('Adobe')

/** The TIFF block of a JPEG's first EXIF segment, or an empty array. */
export function jpegExif(data: Uint8Array): Uint8Array {
  let i = 2
  while (i + 4 <= data.length && data[i] === 0xff) {
    const marker = data[i + 1]
    if (marker === 0xff) {
      i++
      continue
    }
    if (marker === 0xda || marker === 0xd9) break
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2
      continue
    }
    const length = (data[i + 2] << 8) | data[i + 3]
    if (length < 2 || i + 2 + length > data.length) break
    if (marker === 0xe1 && startsWith(data, i + 4, EXIF_HEADER) && length - 2 >= 6) return data.subarray(i + 10, i + 2 + length)
    i += 2 + length
  }
  return new Uint8Array(0)
}

/** The JPEG with only the segments drawing it needs (the same walk as the server's ImageMetadata.Jpeg). */
function stripJpeg(data: Uint8Array): Uint8Array {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) throw new PhotoRefused('Not a JPEG.')
  const out: Uint8Array[] = [data.subarray(0, 2)]
  let i = 2
  let hasScan = false
  for (;;) {
    if (i + 2 > data.length) throw new PhotoRefused('The JPEG ends early.')
    if (data[i] !== 0xff) throw new PhotoRefused('The JPEG is damaged.')
    while (i + 1 < data.length && data[i + 1] === 0xff) i++ // fill bytes
    if (i + 2 > data.length) throw new PhotoRefused('The JPEG ends early.')
    const marker = data[i + 1]
    if (marker === 0xd9) {
      if (!hasScan) throw new PhotoRefused('The JPEG has no image data.')
      out.push(Uint8Array.of(0xff, 0xd9))
      return concat(out)
    }
    if (marker === 0xd8 || marker === 0x00) throw new PhotoRefused('The JPEG is damaged.')
    if (marker >= 0xd0 && marker <= 0xd7) {
      out.push(data.subarray(i, i + 2))
      i += 2
      continue
    }
    if (marker === 0x01) {
      i += 2
      continue
    }
    if (i + 4 > data.length) throw new PhotoRefused('The JPEG ends early.')
    const length = (data[i + 2] << 8) | data[i + 3]
    if (length < 2 || i + 2 + length > data.length) throw new PhotoRefused('A JPEG segment runs past the end.')
    const payloadLength = length - 2
    if (marker === 0xe0 && startsWith(data, i + 4, JFIF) && payloadLength >= 14) {
      // The JFIF header without its thumbnail (a thumbnail can show the picture before it was cropped).
      out.push(Uint8Array.of(0xff, 0xe0, 0x00, 0x10), data.subarray(i + 4, i + 16), Uint8Array.of(0, 0))
    } else if (
      (marker === 0xe2 && startsWith(data, i + 4, ICC)) || (marker === 0xee && startsWith(data, i + 4, ADOBE))
      || marker === 0xdb || marker === 0xdd || marker === 0xda || (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc8)
    ) {
      out.push(data.subarray(i, i + 2 + length))
    }
    i += 2 + length
    if (marker !== 0xda) continue

    // Start of scan: the entropy-coded data runs to the next marker that isn't a stuffed byte or a restart.
    hasScan = true
    const start = i
    while (i + 1 < data.length && !(data[i] === 0xff && data[i + 1] !== 0x00 && !(data[i + 1] >= 0xd0 && data[i + 1] <= 0xd7) && data[i + 1] !== 0xff)) i++
    if (i + 1 >= data.length) throw new PhotoRefused('The JPEG ends early.')
    out.push(data.subarray(start, i))
  }
}

function cleanJpeg(data: Uint8Array, keepDate: boolean): { bytes: Uint8Array; kept: Kept } {
  const stripped = stripJpeg(data)
  const kept = readExif(jpegExif(data))
  const exif = buildExif(kept, keepDate)
  if (!exif) return { bytes: stripped, kept }
  const length = 2 + EXIF_HEADER.length + exif.length
  return { bytes: concat([Uint8Array.of(0xff, 0xd8, 0xff, 0xe1, length >> 8, length & 0xff), EXIF_HEADER, exif, stripped.subarray(2)]), kept }
}

// ── PNG ─────────────────────────────────────────────────────────────────────

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'cICP', 'bKGD', 'pHYs'])

function cleanPng(data: Uint8Array): Uint8Array {
  if (!startsWith(data, 0, PNG_SIGNATURE)) throw new PhotoRefused('Not a PNG.')
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const out: Uint8Array[] = [PNG_SIGNATURE]
  let i = 8
  let first = true
  let hasImage = false
  for (;;) {
    if (i + 12 > data.length) throw new PhotoRefused('The PNG ends early.')
    const length = view.getUint32(i)
    if (length > 0x7fffffff || i + 12 + length > data.length) throw new PhotoRefused('A PNG chunk runs past the end.')
    const type = text(data.subarray(i + 4, i + 8))
    if (first && type !== 'IHDR') throw new PhotoRefused("The PNG doesn't start with its header.")
    first = false
    const size = 12 + length
    if (PNG_KEEP.has(type)) out.push(data.subarray(i, i + size))
    if (type === 'IDAT') hasImage = true
    i += size
    if (type === 'IEND') break
  }
  if (!hasImage) throw new PhotoRefused('The PNG has no image data.')
  return concat(out)
}

// ── WebP ────────────────────────────────────────────────────────────────────

function cleanWebp(data: Uint8Array, keepDate: boolean): { bytes: Uint8Array; kept: Kept } {
  if (data.length < 20 || text(data.subarray(0, 4)) !== 'RIFF' || text(data.subarray(8, 12)) !== 'WEBP') throw new PhotoRefused('Not a WebP.')
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const riffEnd = 8 + view.getUint32(4, true)
  if (riffEnd > data.length) throw new PhotoRefused('The WebP ends early.')
  const out: Uint8Array[] = [ascii('RIFF\0\0\0\0WEBP')]
  let written = 12
  let kept = NOTHING
  let flagsAt = -1
  let hasImage = false
  let i = 12
  while (i + 8 <= riffEnd) {
    const fourcc = text(data.subarray(i, i + 4))
    const size = view.getUint32(i + 4, true)
    const padded = 8 + size + (size & 1)
    if (i + 8 + size > riffEnd) throw new PhotoRefused('A WebP chunk runs past the end.')
    const whole = data.subarray(i, i + Math.min(padded, riffEnd - i))
    const keep = () => {
      out.push(whole)
      written += whole.length
    }
    if (fourcc === 'VP8X') {
      if (size < 10) throw new PhotoRefused('The WebP header is damaged.')
      flagsAt = written + 8
      keep()
    } else if (fourcc === 'VP8 ' || fourcc === 'VP8L' || fourcc === 'ANMF') {
      hasImage = true
      keep()
    } else if (fourcc === 'ALPH' || fourcc === 'ICCP' || fourcc === 'ANIM') keep()
    else if (fourcc === 'EXIF') {
      const tiff = data.subarray(i + 8, i + 8 + size)
      kept = readExif(startsWith(tiff, 0, EXIF_HEADER) ? tiff.subarray(6) : tiff)
    }
    i += padded
  }
  if (!hasImage) throw new PhotoRefused('The WebP has no image data.')
  const exif = flagsAt >= 0 ? buildExif(kept, keepDate) : null // only the extended format can carry EXIF
  if (exif) {
    const header = new Uint8Array(8)
    header.set(ascii('EXIF'))
    new DataView(header.buffer).setUint32(4, exif.length, true)
    out.push(header, exif)
    if (exif.length & 1) out.push(Uint8Array.of(0))
  }
  const bytes = concat(out)
  if (flagsAt >= 0) bytes[flagsAt] = (bytes[flagsAt] & ~(0x08 | 0x04)) | (exif ? 0x08 : 0) // no XMP; EXIF only if we wrote one
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true)
  return { bytes, kept }
}

// ── GIF ─────────────────────────────────────────────────────────────────────

const LOOPING = ['NETSCAPE2.0', 'ANIMEXTS1.0']

/**
 * The GIF with its frames, their timing and its looping, and nothing else: comments, plain text and every application
 * extension but the looping one (XMP, ICC, tool marks) go. Frames are copied as they are, so it still animates.
 */
function cleanGif(data: Uint8Array): Uint8Array {
  const head = text(data.subarray(0, 6))
  if (data.length < 13 || (head !== 'GIF87a' && head !== 'GIF89a')) throw new PhotoRefused('Not a GIF.')
  const early = () => new PhotoRefused('The GIF ends early.')
  const table = (flags: number) => (flags & 0x80 ? 3 * (1 << ((flags & 7) + 1)) : 0)
  /** The end of a run of sub-blocks starting at `at` (each: a length byte, then that many bytes; a zero ends the run). */
  const blocks = (at: number) => {
    for (;;) {
      if (at >= data.length) throw early()
      const size = data[at]
      at += 1 + size
      if (size === 0) return at
    }
  }
  let i = 13 + table(data[10])
  if (i > data.length) throw early()
  const out: Uint8Array[] = [data.subarray(0, i)]
  let frames = 0
  for (;;) {
    if (i >= data.length) throw early()
    const kind = data[i]
    if (kind === 0x3b) break
    if (kind === 0x2c) {
      if (i + 10 > data.length) throw early()
      const end = blocks(i + 10 + table(data[i + 9]) + 1)
      out.push(data.subarray(i, end))
      frames++
      i = end
    } else if (kind === 0x21) {
      if (i + 2 > data.length) throw early()
      const label = data[i + 1]
      const end = blocks(i + 2)
      const keep = label === 0xf9 || (label === 0xff && data[i + 2] === 11 && LOOPING.includes(text(data.subarray(i + 3, i + 14))))
      if (keep) out.push(data.subarray(i, end))
      i = end
    } else throw new PhotoRefused('The GIF is damaged.')
  }
  if (frames === 0) throw new PhotoRefused('The GIF has no image data.')
  out.push(Uint8Array.of(0x3b))
  return concat(out)
}

/**
 * The picture without its metadata, and what its EXIF said about which way up it is and when it was taken.
 */
export function cleanPicture(data: Uint8Array, type: PictureType, keepDate: boolean): { bytes: Uint8Array; kept: Kept } {
  if (type === 'image/jpeg') return cleanJpeg(data, keepDate)
  if (type === 'image/webp') return cleanWebp(data, keepDate)
  if (type === 'image/gif') return { bytes: cleanGif(data), kept: NOTHING }
  return { bytes: cleanPng(data), kept: NOTHING }
}
