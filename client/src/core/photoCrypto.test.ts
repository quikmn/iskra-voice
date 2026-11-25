import { beforeAll, describe, expect, it } from 'vitest'
import { b64u, ready } from './crypto'
import { newChainId, newEpochKey, signChannelChange, verifyChannelChain } from './channelChain'
import { createIdentity } from './identity'
import { MissingPhotoKey, openAlbum, openPhoto, sealPhoto, type SealedPhoto } from './photoCrypto'
import { crc32, uniqueName, ZipWriter } from './zip'

beforeAll(() => ready)

const file = (id: string) => ({ server: 'S'.repeat(43), id, key: 'k'.repeat(43), hash: 'h'.repeat(43), name: 'IMG_1.jpg', type: 'image/jpeg', size: 1234 })

describe('encrypted photos', () => {
  it('seals a photo to one channel and its uploader, and an album name to the channel', () => {
    const [alice, bob, eve] = [createIdentity(), createIdentity(), createIdentity()]
    const chain = newChainId()
    const view = verifyChannelChain(chain, [signChannelChange(alice, null, chain, 'create', [b64u(bob.account.publicKey)])])
    const key = newEpochKey()
    const from = b64u(alice.account.publicKey)
    const content: SealedPhoto = { file: file('f1'), thumb: file('t1'), kind: 'image', name: 'IMG_1.jpg', width: 3024, height: 4032, takenAt: 1_700_000_000_000, caption: 'At the lake' }

    const envelope = sealPhoto(alice, view, key, 7, 'photo', content)
    const text = JSON.stringify(envelope)
    for (const secret of ['At the lake', 'IMG_1.jpg', 'k'.repeat(43), '3024']) expect(text).not.toContain(secret)
    expect(envelope.header).toMatchObject({ from, chain, version: 1, channel: 7, what: 'photo' })
    expect(openPhoto(envelope, from, 7, view, () => key)).toEqual(content)

    // Moved to another channel, claimed by someone else, used as an album, tampered with, or no key: refused.
    expect(() => openPhoto(envelope, from, 8, view, () => key)).toThrow()
    expect(() => openPhoto(envelope, b64u(bob.account.publicKey), 7, view, () => key)).toThrow()
    expect(() => openAlbum(envelope, 7, view, () => key)).toThrow()
    expect(() => openPhoto({ ...envelope, ct: envelope.ct.slice(0, -2) + 'AA' }, from, 7, view, () => key)).toThrow()
    expect(() => openPhoto({ ...envelope, header: { ...envelope.header, sentAt: envelope.header.sentAt + 1 } }, from, 7, view, () => key)).toThrow()
    expect(() => openPhoto(envelope, from, 7, view, () => undefined)).toThrow(MissingPhotoKey)
    expect(() => openPhoto(envelope, from, 7, view, () => newEpochKey())).toThrow()
    // Someone outside the chain can't seal for it.
    expect(() => sealPhoto(eve, view, key, 7, 'photo', content)).toThrow()

    // An album name may come from any member; a photo only from its uploader.
    const album = sealPhoto(bob, view, key, 7, 'album', { name: '  Summer 2026 ' })
    expect(openAlbum(album, 7, view, () => key)).toEqual({ name: 'Summer 2026' })
    expect(() => openPhoto(album, b64u(bob.account.publicKey), 7, view, () => key)).toThrow()
    expect(() => openAlbum(sealPhoto(bob, view, key, 7, 'album', { name: ' ' }), 7, view, () => key)).toThrow()
  })

  it('checks what an envelope holds field by field', () => {
    const alice = createIdentity()
    const chain = newChainId()
    const view = verifyChannelChain(chain, [signChannelChange(alice, null, chain, 'create', [])])
    const key = newEpochKey()
    const from = b64u(alice.account.publicKey)
    const seal = (content: unknown) => sealPhoto(alice, view, key, 7, 'photo', content as SealedPhoto)
    const good = { file: file('f1'), kind: 'video', name: 'x', width: 1920, height: 1080, duration: 4000, caption: 'c'.repeat(900) }

    const opened = openPhoto(seal(good), from, 7, view, () => key)
    expect(opened.caption).toHaveLength(500)
    expect(opened.duration).toBe(4000)
    expect(opened.thumb).toBeUndefined()
    // The name shown is the file's own (cleaned), not a second claim.
    expect(openPhoto(seal({ ...good, file: { ...file('f1'), name: '../../evil.jpg' } }), from, 7, view, () => key).name).toBe('evil.jpg')
    expect(openPhoto(seal({ ...good, width: -5, height: 'tall', takenAt: 1.5 }), from, 7, view, () => key)).toMatchObject({ width: 0, height: 0 })
    for (const bad of [{ ...good, kind: 'audio' }, { ...good, file: { ...file('f1'), key: 'short' } }, { ...good, file: undefined }, { ...good, thumb: 'nope' }, null, 'text']) {
      expect(() => openPhoto(seal(bad), from, 7, view, () => key)).toThrow()
    }
  })
})

describe('zip', () => {
  it('computes CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
    expect(crc32(new Uint8Array(0))).toBe(0)
  })

  it('gives each file its own name', () => {
    const used = new Set<string>()
    expect(uniqueName(used, 'IMG.jpg')).toBe('IMG.jpg')
    expect(uniqueName(used, 'img.JPG')).toBe('img (2).JPG')
    expect(uniqueName(used, 'IMG.jpg')).toBe('IMG (3).jpg')
    expect(uniqueName(used, 'notes')).toBe('notes')
    expect(uniqueName(used, 'notes')).toBe('notes (2)')
  })

  it('writes an archive other tools can read: stored files, a directory and its end record', async () => {
    const parts: Uint8Array[] = []
    const zip = new ZipWriter(async (bytes) => void parts.push(bytes.slice()))
    const one = new TextEncoder().encode('hello photos')
    const two = new Uint8Array(70_000).map((_, i) => i % 251)
    expect(await zip.add('Sommar/å.jpg', one, new Date(2026, 6, 14, 18, 30, 4))).toBe('Sommar_å.jpg')
    expect(await zip.add('Sommar_å.jpg', two, new Date(2026, 6, 15))).toBe('Sommar_å (2).jpg')
    await zip.finish()
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let at = 0
    for (const p of parts) {
      all.set(p, at)
      at += p.length
    }
    const view = new DataView(all.buffer)

    // The end record points at a directory of two entries.
    const end = all.length - 22
    expect(view.getUint32(end, true)).toBe(0x06054b50)
    expect(view.getUint16(end + 10, true)).toBe(2)
    let entry = view.getUint32(end + 16, true)
    expect(entry + view.getUint32(end + 12, true)).toBe(end)
    const files: { name: string; data: Uint8Array; crc: number }[] = []
    for (let i = 0; i < 2; i++) {
      expect(view.getUint32(entry, true)).toBe(0x02014b50)
      expect(view.getUint16(entry + 8, true) & 0x0800).toBe(0x0800)
      expect(view.getUint16(entry + 10, true)).toBe(0)
      const size = view.getUint32(entry + 24, true)
      const nameLength = view.getUint16(entry + 28, true)
      const local = view.getUint32(entry + 42, true)
      const name = new TextDecoder().decode(all.subarray(entry + 46, entry + 46 + nameLength))
      // The local header says the same and the data follows it.
      expect(view.getUint32(local, true)).toBe(0x04034b50)
      expect(view.getUint32(local + 18, true)).toBe(size)
      const data = all.subarray(local + 30 + view.getUint16(local + 26, true), local + 30 + view.getUint16(local + 26, true) + size)
      files.push({ name, data, crc: view.getUint32(entry + 16, true) })
      entry += 46 + nameLength + view.getUint16(entry + 30, true)
    }
    expect(files.map((f) => f.name)).toEqual(['Sommar_å.jpg', 'Sommar_å (2).jpg'])
    expect(files[0].data).toEqual(one)
    expect(files[1].data).toEqual(two)
    expect(files.map((f) => f.crc)).toEqual([crc32(one), crc32(two)])
    // 14 July 2026 18:30:04 as MS-DOS date and time.
    const first = view.getUint32(end + 16, true)
    expect(view.getUint16(first + 14, true)).toBe(((2026 - 1980) << 9) | (7 << 5) | 14)
    expect(view.getUint16(first + 12, true)).toBe((18 << 11) | (30 << 5) | 2)
  })
})
