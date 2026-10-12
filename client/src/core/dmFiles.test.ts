import { beforeAll, describe, expect, it } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'
import vectors from '../../../protocol/vectors.json'
import { b64u, fromB64u, ready } from './crypto'
import { decryptDm, DmError, encryptDm } from './dm'
import { checkFiles, cleanName, decryptFile, encryptedSize, encryptFile, FILE_CHUNK, FileDecryptor, FileEncryptor, type DmFile } from './dmFiles'
import { createIdentity } from './identity'
import { sniff } from './sniff'

beforeAll(ready)

const bytes = (n: number) => sodium.randombytes_buf(n)

describe('encrypted DM files', () => {
  it.each([0, 1, 1000, FILE_CHUNK - 1, FILE_CHUNK, FILE_CHUNK + 1, 3 * FILE_CHUNK + 17])('round-trips %i bytes', (size) => {
    const plain = bytes(size)
    const { ciphertext, key, hash } = encryptFile(plain)
    expect(ciphertext.length).toBe(encryptedSize(size))
    expect(decryptFile(ciphertext, { key, hash, size })).toEqual(plain)
  })

  it('uses a new key every time, so equal files look different', () => {
    const plain = bytes(500)
    const a = encryptFile(plain)
    const b = encryptFile(plain)
    expect(a.key).not.toBe(b.key)
    expect(a.hash).not.toBe(b.hash)
  })

  it('refuses altered, truncated, extended or mismatched ciphertext', () => {
    const plain = bytes(2 * FILE_CHUNK + 5)
    const { ciphertext, key, hash } = encryptFile(plain)
    const size = plain.length
    const rehash = (c: Uint8Array) => b64u(sodium.crypto_generichash(32, c, null))

    const flipped = ciphertext.slice()
    flipped[100] ^= 1
    expect(() => decryptFile(flipped, { key, hash, size })).toThrow(DmError) // hash mismatch
    expect(() => decryptFile(flipped, { key, hash: rehash(flipped), size })).toThrow(DmError) // authentication

    // Dropping the final chunk: every remaining chunk is genuine, but the stream never ends.
    const cut = ciphertext.slice(0, ciphertext.length - (5 + 17))
    expect(() => decryptFile(cut, { key, hash: rehash(cut), size })).toThrow(DmError)
    const extra = new Uint8Array([...ciphertext, 1, 2, 3])
    expect(() => decryptFile(extra, { key, hash: rehash(extra), size })).toThrow(DmError)

    expect(() => decryptFile(ciphertext, { key: encryptFile(plain).key, hash, size })).toThrow(DmError)
    expect(() => decryptFile(ciphertext, { key, hash, size: size - 1 })).toThrow(DmError)
  })

  const pieces = (data: Uint8Array, sizes: number[]) => {
    const out: Uint8Array[] = []
    for (let at = 0, i = 0; at < data.length; i++) {
      const n = sizes[i % sizes.length]
      out.push(data.subarray(at, at + n))
      at += n
    }
    return out
  }
  const concat = (parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let at = 0
    for (const p of parts) {
      out.set(p, at)
      at += p.length
    }
    return out
  }
  // toEqual on megabytes is slow; compare digests.
  const digest = (b: Uint8Array) => `${b.length}:${b64u(sodium.crypto_generichash(32, b, null))}`
  const streamDecrypt = (ciphertext: Uint8Array, file: { key: string; hash: string; size: number }, sizes = [7, 70_000, 65_553, 1]) => {
    const decryptor = new FileDecryptor(file)
    const parts = pieces(ciphertext, sizes).flatMap((p) => decryptor.push(p))
    return concat([...parts, decryptor.finish()])
  }

  it.each([0, 1, FILE_CHUNK - 1, FILE_CHUNK, FILE_CHUNK + 1, 2 * FILE_CHUNK, 5 * FILE_CHUNK + 123])(
    'streams %i bytes in odd-sized pieces both ways', (size) => {
      const plain = bytes(size)
      const encryptor = new FileEncryptor(size)
      const ciphertext = concat(size === 0 ? [encryptor.push(plain)] : pieces(plain, [1, 100_000, FILE_CHUNK, 3]).map((p) => encryptor.push(p)))
      const { key, hash } = encryptor.finish()
      expect(ciphertext.length).toBe(encryptedSize(size))
      expect(digest(decryptFile(ciphertext, { key, hash, size }))).toBe(digest(plain))
      expect(digest(streamDecrypt(ciphertext, { key, hash, size }))).toBe(digest(plain))
    })

  it('streams the way the app uploads: whole parts of many chunks', () => {
    const size = 3 * 8 * FILE_CHUNK + 999
    const plain = bytes(size)
    const encryptor = new FileEncryptor(size)
    const ciphertext = concat(pieces(plain, [8 * FILE_CHUNK]).map((p) => encryptor.push(p)))
    expect(digest(streamDecrypt(ciphertext, { ...encryptor.finish(), size }, [8 * (FILE_CHUNK + 17) + 24]))).toBe(digest(plain))
  })

  it('never takes more than the announced size, and needs all of it before finishing', () => {
    const encryptor = new FileEncryptor(10)
    expect(() => encryptor.push(bytes(11))).toThrow(RangeError)
    encryptor.push(bytes(4))
    expect(() => encryptor.finish()).toThrow(RangeError)
  })

  it('refuses reordered, repeated, dropped or extra chunks while streaming', () => {
    const size = 3 * FILE_CHUNK + 10
    const { ciphertext, key, hash } = encryptFile(bytes(size))
    const rehash = (c: Uint8Array) => b64u(sodium.crypto_generichash(32, c, null))
    const header = ciphertext.subarray(0, 24)
    const chunk = (i: number) => ciphertext.subarray(24 + i * (FILE_CHUNK + 17), Math.min(ciphertext.length, 24 + (i + 1) * (FILE_CHUNK + 17)))
    const attempts = {
      reordered: concat([header, chunk(1), chunk(0), chunk(2), chunk(3)]),
      repeated: concat([header, chunk(0), chunk(0), chunk(1), chunk(2), chunk(3)]),
      dropped: concat([header, chunk(0), chunk(2), chunk(3)]),
      noFinal: concat([header, chunk(0), chunk(1), chunk(2)]),
      extra: concat([ciphertext, chunk(3)]),
    }
    for (const [what, bad] of Object.entries(attempts)) {
      // Even with a matching hash (a sender lying about their own file), the stream itself refuses it.
      expect(() => streamDecrypt(bad, { key, hash: rehash(bad), size }), what).toThrow(DmError)
      expect(() => streamDecrypt(bad, { key, hash, size }), what).toThrow(DmError)
    }
    // A flipped bit fails in the chunk it is in, before the rest arrives.
    const flipped = ciphertext.slice()
    flipped[24 + 5] ^= 1
    const decryptor = new FileDecryptor({ key, hash, size })
    expect(() => decryptor.push(flipped.subarray(0, 24 + FILE_CHUNK + 17))).toThrow(DmError)
    expect(() => decryptor.push(new Uint8Array(1))).toThrow(DmError) // and stays failed
    // The right chunks with the wrong hash: decrypts fine, but finish refuses it.
    const wrongHash = new FileDecryptor({ key, hash: rehash(new Uint8Array([1])), size })
    wrongHash.push(ciphertext)
    expect(() => wrongHash.finish()).toThrow(DmError)
  })

  it('opens the files in protocol/vectors.json (every file ever sent stays readable)', () => {
    for (const v of vectors.dmFile.files) {
      const plain = Uint8Array.from({ length: v.size }, (_, i) => i % 251)
      const ciphertext = fromB64u(v.ciphertext)
      expect(ciphertext.length).toBe(encryptedSize(v.size))
      expect(digest(decryptFile(ciphertext, v))).toBe(digest(plain))
      expect(digest(streamDecrypt(ciphertext, v, [1000]))).toBe(digest(plain))
    }
  })

  it('travels inside the DM envelope, checked on the way out', () => {
    const alice = createIdentity()
    const bob = createIdentity()
    const { key, hash } = encryptFile(bytes(10))
    const file: DmFile = { server: 'c2VydmVy', id: 'fileid', key, hash, name: 'cat.png', type: 'image/png', size: 10, voice: { duration: 1200, waveform: 'AAEC' } }
    const env = encryptDm(alice, b64u(bob.account.publicKey), [bob.cert], [], { text: '', files: [file] })
    const opened = decryptDm(bob, env, b64u(alice.account.publicKey), b64u(bob.account.publicKey))
    expect(opened.text).toBe('')
    expect(opened.files).toEqual([file])
    expect(JSON.stringify(env)).not.toContain(key) // the key only exists inside the ciphertext
    expect(() => encryptDm(alice, b64u(bob.account.publicKey), [bob.cert], [], { text: '' })).toThrow(DmError)
  })

  it('rejects malformed attachment lists', () => {
    const good = { server: 'abc', id: 'id', key: 'k'.repeat(43), hash: 'h'.repeat(43), name: 'a.txt', type: 'text/plain', size: 3 }
    expect(checkFiles(undefined)).toEqual([])
    expect(checkFiles([good])).toHaveLength(1)
    expect(() => checkFiles('x')).toThrow(DmError)
    expect(() => checkFiles(Array(11).fill(good))).toThrow(DmError)
    expect(() => checkFiles([{ ...good, key: 'short' }])).toThrow(DmError)
    expect(() => checkFiles([{ ...good, size: -1 }])).toThrow(DmError)
    expect(() => checkFiles([{ ...good, id: '../etc' }])).toThrow(DmError)
    expect(checkFiles([{ ...good, voice: { duration: 'long', waveform: 'x' } }])[0].voice).toBeUndefined()
    expect(checkFiles([{ ...good, name: '../../evil\u202Egnp.exe' }])[0].name).toBe('evilgnp.exe')
  })

  it('cleans file names', () => {
    expect(cleanName('C:\\Users\\me\\secret.pdf')).toBe('secret.pdf')
    expect(cleanName('...hidden')).toBe('hidden')
    expect(cleanName('a"b<c>.txt')).toBe('abc.txt')
    expect(cleanName('')).toBe('file')
  })
})

describe('sniffing decrypted bytes', () => {
  const head = (...b: number[]) => new Uint8Array(b)
  const text = (s: string) => new TextEncoder().encode(s)
  it('shows only the types channels show, whatever the sender claimed', () => {
    expect(sniff(head(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toEqual({ type: 'image/png', inline: true })
    expect(sniff(head(0xff, 0xd8, 0xff, 0xe0)).type).toBe('image/jpeg')
    expect(sniff(text('GIF89a')).type).toBe('image/gif')
    expect(sniff(text('RIFF....WEBPVP8 ')).type).toBe('image/webp')
    expect(sniff(text('....ftypisom')).type).toBe('video/mp4')
    expect(sniff(head(0x1a, 0x45, 0xdf, 0xa3)).type).toBe('video/webm')
    expect(sniff(text('OggS')).type).toBe('audio/ogg')
    expect(sniff(text('<svg onload=alert(1)>'))).toEqual({ type: 'application/octet-stream', inline: false })
    expect(sniff(text('<html><script>')).inline).toBe(false)
    expect(sniff(new Uint8Array()).inline).toBe(false)
  })
})
