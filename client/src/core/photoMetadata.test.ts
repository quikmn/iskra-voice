import { describe, expect, it } from 'vitest'
import { buildExif, cleanPicture, exifTime, isPictureType, jpegExif, PhotoRefused, readExif } from './photoMetadata'
import { cleanVideo, isVideoHead, patchedParts, planVideo, VideoRefused, type ReadAt } from './mp4Metadata'

// The fixtures the end-to-end tests upload: a phone photo, a screenshot and a phone video, each with metadata.
const fs = 'node:fs'
const crypto = 'node:crypto'
const { readFileSync } = (await import(/* @vite-ignore */ fs)) as { readFileSync(path: URL): Uint8Array }
const { createHash } = (await import(/* @vite-ignore */ crypto)) as { createHash(name: string): { update(data: Uint8Array): { digest(enc: string): string } } }
const fixture = (name: string) => new Uint8Array(readFileSync(new URL('../../e2e/fixtures/photos/' + name, import.meta.url)))
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

// SHA-256 of the cleaned fixtures. The server's PhotoTests.cs has the same values: both sides must write the same bytes.
const HASHES = {
  jpegDated: '4ede4a1beb081d03ce7fdee76946cc6bfa1f038b90957f8f7544a5c2eff75f98',
  jpegUndated: '15d98e762c0f219ee0cfe9ca7dbee81aecd6059952f4d9073f81294a542af6a0',
  png: 'e13a12ae4444c46faea8a0ca3090994f15cab1f141efc956188adb5d6c76c9c6',
  mp4Dated: '0972284705233ff86b1f1a6b6315b49bf07d920ec4f570c0bcbd3a97afdab909',
  mp4Undated: '83037acc02d5b5d3219e4980712d4e3262f619ef008b5995225d7ff1228a4b3a',
}

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0))
const has = (haystack: Uint8Array, needle: string) => {
  const n = ascii(needle)
  outer: for (let i = 0; i + n.length <= haystack.length; i++) {
    for (let j = 0; j < n.length; j++) if (haystack[i + j] !== n[j]) continue outer
    return true
  }
  return false
}
const join = (...parts: (Uint8Array | number[])[]) => {
  const bytes = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)))
  const out = new Uint8Array(bytes.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of bytes) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const SECRETS = ['SecretCam', 'SecretPhone', 'SecretOS', 'Secret Owner', 'SN-SECRET', 'SecretLens', 'secret comment']

describe('cleaning a picture', () => {
  it('reads which way up a phone photo is and when it was taken', () => {
    const kept = readExif(jpegExif(fixture('gps.jpg')))
    expect(kept).toEqual({ orientation: 6, date: '2024:07:14 18:30:05', offset: '+02:00' })
    expect(exifTime(kept)).toBe(Date.parse('2024-07-14T18:30:05+02:00'))
    expect(exifTime({ date: null, offset: null })).toBeNull()
    expect(exifTime({ date: '0000:00:00 00:00:00', offset: null })).toBeNull()
    // Damaged or foreign bytes read as "nothing known", never throw.
    for (const junk of [new Uint8Array(0), ascii('II*\0garbage'), Uint8Array.of(0x4d, 0x4d, 0, 42, 0xff, 0xff, 0xff, 0xff, 1, 2), new Uint8Array(64).fill(0xff)]) {
      expect(readExif(junk)).toEqual({ orientation: 1, date: null, offset: null })
    }
  })

  it('takes everything but the pixels, the orientation and (if kept) the date out of a JPEG', () => {
    const original = fixture('gps.jpg')
    for (const secret of SECRETS) expect(has(original, secret), secret).toBe(true)
    const { bytes, kept } = cleanPicture(original, 'image/jpeg', true)
    for (const secret of SECRETS) expect(has(bytes, secret), secret).toBe(false)
    expect(kept.orientation).toBe(6)
    expect(readExif(jpegExif(bytes))).toEqual({ orientation: 6, date: '2024:07:14 18:30:05', offset: '+02:00' })
    // The image data is untouched: the cleaned file ends with the same scan.
    expect(bytes.slice(-2000)).toEqual(original.slice(-2000))

    const undated = cleanPicture(original, 'image/jpeg', false).bytes
    expect(readExif(jpegExif(undated))).toEqual({ orientation: 6, date: null, offset: null })
    expect(has(undated, '2024:07:1')).toBe(false)
    // Cleaning again changes nothing (the server cleans what the app already cleaned).
    expect(cleanPicture(bytes, 'image/jpeg', true).bytes).toEqual(bytes)
    expect(cleanPicture(bytes, 'image/jpeg', false).bytes).toEqual(undated)
    expect(sha256(bytes)).toBe(HASHES.jpegDated)
    expect(sha256(undated)).toBe(HASHES.jpegUndated)
  })

  it('leaves a JPEG without EXIF without any, and refuses what is not a picture', () => {
    const plain = fixture('wide.jpg')
    const { bytes, kept } = cleanPicture(plain, 'image/jpeg', true)
    expect(kept).toEqual({ orientation: 1, date: null, offset: null })
    expect(jpegExif(bytes).length).toBe(0)
    expect(() => cleanPicture(ascii('not a jpeg'), 'image/jpeg', true)).toThrow(PhotoRefused)
    expect(() => cleanPicture(plain.slice(0, 200), 'image/jpeg', true)).toThrow(PhotoRefused)
    expect(isPictureType('image/tiff')).toBe(false)
  })

  it('takes text out of a PNG', () => {
    const original = fixture('screenshot.png')
    expect(has(original, 'Secret Owner')).toBe(true)
    const { bytes } = cleanPicture(original, 'image/png', true)
    expect(has(bytes, 'Secret Owner')).toBe(false)
    expect(has(bytes, 'SecretShot')).toBe(false)
    expect(has(bytes, 'IDAT')).toBe(true)
    expect(cleanPicture(bytes, 'image/png', true).bytes).toEqual(bytes)
    expect(sha256(bytes)).toBe(HASHES.png)
    expect(() => cleanPicture(ascii('not a png at all'), 'image/png', true)).toThrow(PhotoRefused)
  })

  it('cleans a WebP and keeps its orientation in a new EXIF chunk', () => {
    const riff = (fourcc: string, data: Uint8Array) => {
      const head = new Uint8Array(8)
      head.set(ascii(fourcc))
      new DataView(head.buffer).setUint32(4, data.length, true)
      return join(head, data, data.length & 1 ? [0] : [])
    }
    const tiff = jpegExif(fixture('gps.jpg'))
    const body = join(ascii('WEBP'), riff('VP8X', Uint8Array.of(0x0c, 0, 0, 0, 99, 0, 0, 49, 0, 0)), riff('VP8L', Uint8Array.of(0x2f, 0, 0, 0, 0)),
      riff('EXIF', tiff), riff('XMP ', ascii('Secret Owner')))
    const size = new Uint8Array(4)
    new DataView(size.buffer).setUint32(0, body.length, true)
    const webp = join(ascii('RIFF'), size, body)

    const { bytes, kept } = cleanPicture(webp, 'image/webp', true)
    expect(kept.orientation).toBe(6)
    for (const secret of SECRETS) expect(has(bytes, secret), secret).toBe(false)
    expect(has(bytes, '2024:07:14 18:30:05')).toBe(true)
    expect(bytes[20]).toBe(0x08)
    expect(new DataView(bytes.buffer).getUint32(4, true)).toBe(bytes.length - 8)
    expect(cleanPicture(bytes, 'image/webp', true).bytes).toEqual(bytes)
    const undated = cleanPicture(webp, 'image/webp', false).bytes
    expect(has(undated, '2024:07:14')).toBe(false)
    expect(has(undated, 'EXIF')).toBe(true)
  })

  it('writes no EXIF for an upright picture without a date to keep', () => {
    expect(buildExif({ orientation: 1, date: '2024:07:14 18:30:05', offset: null }, false)).toBeNull()
    expect(buildExif({ orientation: 1, date: 'yesterday', offset: null }, true)).toBeNull()
    expect(readExif(buildExif({ orientation: 3, date: '2024:07:14 18:30:05', offset: 'nope' }, true)!)).toEqual({ orientation: 3, date: '2024:07:14 18:30:05', offset: null })
  })
})

describe('cleaning a video', () => {
  const reader = (data: Uint8Array): ReadAt => async (offset, length) => data.slice(offset, Math.min(data.length, offset + length))
  const apply = async (data: Uint8Array, keepDate: boolean) => {
    const plan = await planVideo(reader(data), data.length, keepDate)
    const parts = patchedParts(new Blob([data as Uint8Array<ArrayBuffer>]), plan.patches)
    const cleaned = new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer())
    return { plan, cleaned }
  }

  it('removes location and device from a phone video in place', async () => {
    const original = fixture('clip.mp4')
    for (const secret of ['59.3293', 'SecretCam', 'SecretPhone', 'Secret title', 'VideoHandler']) expect(has(original, secret), secret).toBe(true)
    const { plan, cleaned } = await apply(original, true)
    expect(plan.createdAt).toBe(Date.parse('2024-07-14T16:31:00Z'))
    expect(cleaned.length).toBe(original.length)
    for (const secret of ['59.3293', 'SecretCam', 'SecretPhone', 'Secret title', 'VideoHandler', 'udta', 'Lavf']) expect(has(cleaned, secret), secret).toBe(false)
    expect(has(cleaned, 'vp09')).toBe(true)
    // A clean file needs no changes; without the date its creation time goes too.
    expect((await planVideo(reader(cleaned), cleaned.length, true)).patches).toEqual([])
    const undated = await apply(original, false)
    expect((await planVideo(reader(undated.cleaned), undated.cleaned.length, false)).createdAt).toBeNull()
    expect(sha256(cleaned)).toBe(HASHES.mp4Dated)
    expect(sha256(undated.cleaned)).toBe(HASHES.mp4Undated)

    const blob = new Blob([original as Uint8Array<ArrayBuffer>], { type: 'video/mp4' })
    const viaBlob = await cleanVideo(blob, true)
    expect(new Uint8Array(await viaBlob.blob.arrayBuffer())).toEqual(cleaned)
    expect((await cleanVideo(viaBlob.blob, true)).blob).toBe(viaBlob.blob)
  })

  it('zeroes the samples of tracks that are not video or audio', async () => {
    const u32 = (...values: number[]) => {
      const b = new Uint8Array(values.length * 4)
      values.forEach((v, i) => new DataView(b.buffer).setUint32(i * 4, v))
      return b
    }
    const box = (type: string, ...parts: Uint8Array[]) => join(u32(8 + parts.reduce((n, p) => n + p.length, 0)), ascii(type), ...parts)
    const track = (handler: string, name: string, ...table: Uint8Array[]) => box('trak',
      box('tkhd', u32(0, 5, 5, 1, 0, 0)),
      box('mdia', box('mdhd', u32(0, 5, 5, 1000, 0, 0)), box('hdlr', u32(0, 0), ascii(handler), new Uint8Array(12), ascii(name + '\0')), box('minf', box('stbl', ...table))))
    const ftyp = box('ftyp', ascii('isom'), u32(0x200), ascii('isom'))
    const media = box('mdat', ascii('VIDEODATA'), ascii('GPS1'), ascii('GPSTWO'))
    const gpsAt = ftyp.length + 8 + 9
    const moov = box('moov', box('mvhd', u32(0, 5, 5, 1000, 5000)),
      track('vide', 'Video', box('stco', u32(0, 1, ftyp.length + 8)), box('stsc', u32(0, 1, 1, 1, 1)), box('stsz', u32(0, 9, 1))),
      track('meta', 'Location Track', box('stco', u32(0, 1, gpsAt)), box('stsc', u32(0, 1, 1, 2, 1)), box('stsz', u32(0, 0, 2, 4, 6))))
    const file = join(ftyp, media, moov, box('uuid', ascii('XMP Secret Owner')))

    const { cleaned } = await apply(file, true)
    expect(cleaned.length).toBe(file.length)
    for (const secret of ['GPS1', 'GPSTWO', 'Location Track', 'Secret Owner', 'uuid']) expect(has(cleaned, secret), secret).toBe(false)
    expect(has(cleaned, 'VIDEODATA')).toBe(true)
    expect((await planVideo(reader(cleaned), cleaned.length, true)).patches).toEqual([])

    // The same track in a fragmented file can't be cleaned; a file without a movie header isn't a video.
    const fragmented = join(file, box('moof', u32(0)))
    await expect(planVideo(reader(fragmented), fragmented.length, true)).rejects.toThrow(VideoRefused)
    await expect(planVideo(reader(ftyp), ftyp.length, true)).rejects.toThrow(VideoRefused)
  })

  it('tells videos from HEIC and AVIF pictures', () => {
    const head = (brand: string) => join([0, 0, 0, 24], ascii('ftyp'), ascii(brand), [0, 0, 0, 0])
    expect(isVideoHead(head('isom'))).toBe(true)
    expect(isVideoHead(head('qt  '))).toBe(true)
    expect(isVideoHead(head('heic'))).toBe(false)
    expect(isVideoHead(head('avif'))).toBe(false)
    expect(isVideoHead(ascii('GIF89a'))).toBe(false)
  })
})
