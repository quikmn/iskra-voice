import { beforeAll, describe, expect, it } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'
import { b64u, ready } from './crypto'
import { decryptDm, DmError, encryptDm } from './dm'
import { checkFiles, cleanName, decryptFile, encryptedSize, encryptFile, FILE_CHUNK, type DmFile } from './dmFiles'
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
