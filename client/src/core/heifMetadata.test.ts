import { describe, expect, it } from 'vitest'
import { heifType, HeifRefused, planHeif } from './heifMetadata'
import { patchedParts, type ReadAt } from './mp4Metadata'
import { cleanPicture, PhotoRefused } from './photoMetadata'

// The fixtures the end-to-end tests upload: an iPhone-style HEIC, an AVIF and an animated GIF, each with metadata.
const fs = 'node:fs'
const crypto = 'node:crypto'
const { readFileSync } = (await import(/* @vite-ignore */ fs)) as { readFileSync(path: URL): Uint8Array }
const { createHash } = (await import(/* @vite-ignore */ crypto)) as { createHash(name: string): { update(data: Uint8Array): { digest(enc: string): string } } }
const fixture = (name: string) => new Uint8Array(readFileSync(new URL('../../e2e/fixtures/photos/' + name, import.meta.url)))
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

// SHA-256 of the cleaned fixtures. The server's PhotoTests.cs has the same values: both sides must write the same bytes.
const HASHES = {
  heicDated: '2cc4a56303205d6f19fc7c241fb9707e4a937394a00c39e93a557ae93ad54021',
  heicUndated: 'c8c396e399f560a81a18e98099242b2bdec0fceec287031e2051697b85da0f98',
  avifDated: '2112f6159365cc512592ff9a3dc2093d7c75b35f413ba21cb84a16c8ce02c475',
  gif: 'fe8f90e6e1a45a7c9be8abdb09b7b2f60be642cd3cc2cabe63d34b19d38c53b3',
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
const SECRETS = ['SecretCam', 'SecretPhone', 'SecretOS', 'Secret Owner', 'SN-SECRET', '59.3293', 'xmpmeta']

const reader = (data: Uint8Array): ReadAt => async (offset, length) => data.slice(offset, Math.min(data.length, offset + length))
async function clean(data: Uint8Array, keepDate: boolean) {
  const plan = await planHeif(reader(data), data.length, keepDate)
  const parts = patchedParts(new Blob([data as Uint8Array<ArrayBuffer>]), plan.patches)
  return { plan, cleaned: new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer()) }
}

describe('cleaning a HEIC or AVIF picture', () => {
  for (const [name, type] of [['iphone.heic', 'image/heic'], ['pixel.avif', 'image/avif']] as const) {
    it(`overwrites what identifies in ${name} and leaves the coded picture alone`, async () => {
      const original = fixture(name)
      expect(heifType(original.subarray(0, 64))).toBe(type)
      for (const secret of SECRETS) expect(has(original, secret), secret).toBe(true)
      const { plan, cleaned } = await clean(original, true)
      expect(plan.kept).toEqual({ orientation: 1, date: '2023:12:24 15:00:00', offset: '+01:00' })
      expect(cleaned.length).toBe(original.length)
      for (const secret of SECRETS) expect(has(cleaned, secret), secret).toBe(false)
      expect(has(cleaned, '2023:12:24 15:00:00')).toBe(true)
      // Only the Exif and XMP items changed: everything else is the same, byte for byte.
      const changed = cleaned.reduce((n, v, i) => n + (v !== original[i] ? 1 : 0), 0)
      expect(changed).toBeGreaterThan(100)
      expect(changed).toBeLessThan(900)
      // A clean file needs no changes, and it still says when it was taken.
      const again = await planHeif(reader(cleaned), cleaned.length, true)
      expect(again.patches).toEqual([])
      expect(again.kept.date).toBe('2023:12:24 15:00:00')
      // Without the date, that goes too.
      const undated = (await clean(original, false)).cleaned
      expect(has(undated, '2023:12:24')).toBe(false)
      expect((await clean(cleaned, false)).cleaned).toEqual(undated)
      expect(sha256(cleaned)).toBe(name === 'iphone.heic' ? HASHES.heicDated : HASHES.avifDated)
      if (name === 'iphone.heic') expect(sha256(undated)).toBe(HASHES.heicUndated)
    })
  }

  it('refuses what it cannot clean', async () => {
    const heic = fixture('iphone.heic')
    await expect(planHeif(reader(heic.slice(0, 40)), 40, true)).rejects.toThrow(HeifRefused)
    const video = fixture('clip.mp4')
    await expect(planHeif(reader(video), video.length, true)).rejects.toThrow(HeifRefused)
    expect(heifType(video.subarray(0, 64))).toBeNull()
    expect(heifType(ascii('GIF89a'))).toBeNull()
  })
})

describe('cleaning a GIF', () => {
  it('keeps the frames, their timing and the looping, and drops comments and other blocks', () => {
    const original = fixture('clip.gif')
    for (const secret of ['secret comment', 'Secret Owner', 'SN-SECRET', 'XMP Data']) expect(has(original, secret), secret).toBe(true)
    const { bytes } = cleanPicture(original, 'image/gif', true)
    for (const secret of ['secret comment', 'Secret Owner', 'SN-SECRET', 'XMP Data']) expect(has(bytes, secret), secret).toBe(false)
    expect(has(bytes, 'NETSCAPE2.0')).toBe(true)
    // Three frames, each with its delay.
    const count = (data: Uint8Array, a: number, b: number) => data.reduce((n, v, i) => n + (v === a && data[i + 1] === b && data[i + 2] === 4 ? 1 : 0), 0)
    expect(count(bytes, 0x21, 0xf9)).toBe(3)
    expect(bytes[bytes.length - 1]).toBe(0x3b)
    expect(cleanPicture(bytes, 'image/gif', true).bytes).toEqual(bytes)
    expect(sha256(bytes)).toBe(HASHES.gif)
    expect(() => cleanPicture(original.slice(0, 300), 'image/gif', true)).toThrow(PhotoRefused)
    expect(() => cleanPicture(ascii('GIF89a nothing here'), 'image/gif', true)).toThrow(PhotoRefused)
  })
})
