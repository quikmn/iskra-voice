// End-to-end encrypted DM attachments (PROTOCOL.md, "Encrypted DM attachments").
// Each file gets a random key and is encrypted with libsodium's secretstream (XChaCha20-Poly1305) in 64 KiB chunks,
// the last one tagged FINAL, so a truncated, reordered or altered file never decrypts. Only the ciphertext is uploaded;
// the key, a hash of the ciphertext, the name, type and size go inside the (encrypted) DM envelope.
// Both ways stream: big files are encrypted and decrypted a chunk at a time, never whole in memory.
import sodium from 'libsodium-wrappers-sumo'
import { b64u, fromB64u } from './crypto'
import { DmError } from './dm'

export const FILE_CHUNK = 64 * 1024
type State = ReturnType<typeof sodium.crypto_generichash_init>
const AD = new TextEncoder().encode('iskra/dm-file/v1')
export const MAX_DM_FILES = 10

/** One attachment, as it travels inside the encrypted DM content. */
export interface DmFile {
  /** The server holding the ciphertext (one both people are on) and its file id there. */
  server: string
  id: string
  /** b64u, 32 bytes: the secretstream key. */
  key: string
  /** b64u BLAKE2b-256 of the ciphertext. */
  hash: string
  name: string
  /** What the sender's device said; only a hint. What's shown inline is decided from the decrypted bytes. */
  type: string
  /** Plaintext bytes. */
  size: number
  /** Voice messages: length (ms) and waveform (b64u bytes). */
  voice?: { duration: number; waveform: string }
}

/** Ciphertext size for a plaintext of `size` bytes. */
export function encryptedSize(size: number): number {
  const chunks = Math.max(1, Math.ceil(size / FILE_CHUNK))
  return sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES + size + chunks * sodium.crypto_secretstream_xchacha20poly1305_ABYTES
}

const damaged = () => new DmError('This file is damaged.')
const mismatch = () => new DmError("This file doesn't match what was sent.")

/**
 * Encrypts a file of `size` bytes as it is fed in. `push` takes the plaintext in order, in pieces of any length, and
 * returns the ciphertext ready so far (the header first); `finish` returns the key and the ciphertext's hash.
 */
export class FileEncryptor {
  private readonly key = sodium.crypto_secretstream_xchacha20poly1305_keygen()
  private readonly state: State
  private readonly hash = sodium.crypto_generichash_init(null, 32)
  private header: Uint8Array | null
  private pending = new Uint8Array(0)
  private fed = 0
  private done = false

  constructor(readonly size: number) {
    if (!Number.isSafeInteger(size) || size < 0) throw new RangeError('size')
    const { state, header } = sodium.crypto_secretstream_xchacha20poly1305_init_push(this.key)
    this.state = state
    this.header = header
  }

  push(plain: Uint8Array): Uint8Array {
    if (this.done || this.fed + plain.length > this.size) throw new RangeError('More bytes than the file has.')
    this.fed += plain.length
    let input = plain
    if (this.pending.length) {
      input = new Uint8Array(this.pending.length + plain.length)
      input.set(this.pending, 0)
      input.set(plain, this.pending.length)
    }
    const end = this.fed === this.size
    // Whole chunks only until the end; there the rest (possibly empty, possibly a whole chunk) is the FINAL one.
    let full = Math.floor(input.length / FILE_CHUNK)
    if (end && full * FILE_CHUNK === input.length && full > 0) full -= 1
    const chunks = end ? full + 1 : full
    const head = this.header?.length ?? 0
    const plainOut = end ? input.length : full * FILE_CHUNK
    const out = new Uint8Array(head + plainOut + chunks * sodium.crypto_secretstream_xchacha20poly1305_ABYTES)
    if (this.header) out.set(this.header, 0)
    this.header = null
    let at = head
    for (let i = 0; i < chunks; i++) {
      const last = end && i === chunks - 1
      const piece = input.subarray(i * FILE_CHUNK, last ? input.length : (i + 1) * FILE_CHUNK)
      const tag = last ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE
      const sealed = sodium.crypto_secretstream_xchacha20poly1305_push(this.state, piece, AD, tag)
      out.set(sealed, at)
      at += sealed.length
    }
    this.pending = end ? new Uint8Array(0) : input.slice(plainOut)
    this.done = end
    sodium.crypto_generichash_update(this.hash, out)
    return out
  }

  /** After the last byte: the key and hash for the DM envelope. */
  finish(): { key: string; hash: string } {
    if (!this.done) throw new RangeError('The file is not complete.')
    const result = { key: b64u(this.key), hash: b64u(sodium.crypto_generichash_final(this.hash, 32)) }
    sodium.memzero(this.key)
    return result
  }
}

/**
 * Decrypts a file as its ciphertext arrives. `push` takes ciphertext in pieces of any length and returns the plaintext
 * of every chunk completed (each one authenticated on its own); `finish` returns the rest and throws unless the stream
 * ended with the FINAL chunk, nothing followed it, the length matches and the whole ciphertext matches the hash.
 * Until `finish` returns, nothing pushed out may be treated as the file.
 */
export class FileDecryptor {
  private readonly key: Uint8Array
  private readonly expected: Uint8Array
  private readonly hash = sodium.crypto_generichash_init(null, 32)
  private state: State | null = null
  private buffer = new Uint8Array(0)
  private written = 0
  private received = 0
  private final = false
  private over = false
  /** Ciphertext bytes this file must have. */
  readonly total: number

  constructor(private readonly file: Pick<DmFile, 'key' | 'hash' | 'size'>) {
    this.key = fromB64u(file.key)
    this.expected = fromB64u(file.hash)
    if (this.key.length !== 32 || this.expected.length !== 32 || !Number.isSafeInteger(file.size) || file.size < 0) throw mismatch()
    this.total = encryptedSize(file.size)
  }

  push(cipher: Uint8Array): Uint8Array[] {
    if (this.over) throw damaged()
    try {
      this.received += cipher.length
      if (this.received > this.total) throw damaged()
      sodium.crypto_generichash_update(this.hash, cipher)
      let input = cipher
      if (this.buffer.length) {
        input = new Uint8Array(this.buffer.length + cipher.length)
        input.set(this.buffer, 0)
        input.set(cipher, this.buffer.length)
      }
      const out: Uint8Array[] = []
      let at = 0
      if (!this.state) {
        const headerBytes = sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES
        if (input.length < headerBytes) {
          this.buffer = input.slice()
          return out
        }
        this.state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(input.subarray(0, headerBytes), this.key)
        at = headerBytes
      }
      const chunkBytes = FILE_CHUNK + sodium.crypto_secretstream_xchacha20poly1305_ABYTES
      while (input.length - at >= chunkBytes) {
        out.push(this.open(input.subarray(at, at + chunkBytes)))
        at += chunkBytes
      }
      this.buffer = input.slice(at)
      return out
    } catch (e) {
      this.end()
      throw e instanceof DmError ? e : damaged()
    }
  }

  /** Opens the last (short) chunk, then checks everything. Returns that chunk's plaintext (maybe empty). */
  finish(): Uint8Array {
    if (this.over) throw damaged()
    try {
      let last = new Uint8Array(0)
      if (this.buffer.length) {
        if (!this.state) throw damaged()
        last = this.open(this.buffer)
        this.buffer = new Uint8Array(0)
      }
      if (!sodium.memcmp(this.expected, sodium.crypto_generichash_final(this.hash, 32))) throw mismatch()
      if (!this.final || this.written !== this.file.size || this.received !== this.total) throw damaged()
      return last
    } catch (e) {
      throw e instanceof DmError ? e : damaged()
    } finally {
      this.end()
    }
  }

  private open(chunk: Uint8Array): Uint8Array {
    if (this.final) throw damaged() // bytes after the final chunk
    const result = sodium.crypto_secretstream_xchacha20poly1305_pull(this.state!, chunk, AD)
    if (!result) throw damaged()
    this.written += result.message.length
    if (this.written > this.file.size) throw damaged()
    this.final = result.tag === sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
    return result.message
  }

  /** Finished, one way or the other: forget the key. */
  private end() {
    this.over = true
    sodium.memzero(this.key)
  }
}

/** A whole file in memory at once (small files, tests). */
export function encryptFile(plain: Uint8Array): { ciphertext: Uint8Array; key: string; hash: string } {
  const encryptor = new FileEncryptor(plain.length)
  const ciphertext = encryptor.push(plain)
  return { ciphertext, ...encryptor.finish() }
}

/** Checks and decrypts a whole file in memory; anything off (wrong key, tampering, truncation, extra bytes) throws. */
export function decryptFile(ciphertext: Uint8Array, file: Pick<DmFile, 'key' | 'hash' | 'size'>): Uint8Array {
  const decryptor = new FileDecryptor(file)
  const parts = [...decryptor.push(ciphertext), decryptor.finish()]
  const out = new Uint8Array(file.size)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const B64U = /^[A-Za-z0-9_-]+$/

/** The `files` of decrypted DM content, checked field by field; anything malformed makes the whole message unreadable. */
export function checkFiles(raw: unknown): DmFile[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > MAX_DM_FILES) throw new DmError('Unsupported message content.')
  return raw.map((f): DmFile => {
    const ok = f && typeof f === 'object'
      && typeof f.server === 'string' && B64U.test(f.server) && f.server.length <= 64
      && typeof f.id === 'string' && B64U.test(f.id) && f.id.length <= 64
      && typeof f.key === 'string' && B64U.test(f.key) && f.key.length === 43
      && typeof f.hash === 'string' && B64U.test(f.hash) && f.hash.length === 43
      && typeof f.name === 'string' && f.name.length >= 1 && f.name.length <= 200
      && typeof f.type === 'string' && f.type.length <= 100
      && Number.isSafeInteger(f.size) && f.size >= 0
    if (!ok) throw new DmError('Unsupported message content.')
    const voice = f.voice && typeof f.voice === 'object' && Number.isSafeInteger(f.voice.duration) && f.voice.duration > 0
      && f.voice.duration <= 5 * 60 * 1000 && typeof f.voice.waveform === 'string' && B64U.test(f.voice.waveform) && f.voice.waveform.length <= 172
      ? { duration: f.voice.duration as number, waveform: f.voice.waveform as string }
      : undefined
    return { server: f.server, id: f.id, key: f.key, hash: f.hash, name: cleanName(f.name), type: f.type, size: f.size, ...(voice ? { voice } : {}) }
  })
}

/** A name that is safe to show and to save under: no paths, no control characters. */
export function cleanName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩"*:<>?|]/g, '').trim().replace(/^\.+/, '')
  return cleaned.slice(0, 120) || 'file'
}
