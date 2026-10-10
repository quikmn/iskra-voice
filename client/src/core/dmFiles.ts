// End-to-end encrypted DM attachments (PROTOCOL.md, "Encrypted DM attachments").
// Each file gets a random key and is encrypted with libsodium's secretstream (XChaCha20-Poly1305) in 64 KiB chunks,
// the last one tagged FINAL, so a truncated, reordered or altered file never decrypts. Only the ciphertext is uploaded;
// the key, a hash of the ciphertext, the name, type and size go inside the (encrypted) DM envelope.
import sodium from 'libsodium-wrappers-sumo'
import { b64u, fromB64u } from './crypto'
import { DmError } from './dm'

export const FILE_CHUNK = 64 * 1024
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

export function encryptFile(plain: Uint8Array): { ciphertext: Uint8Array; key: string; hash: string } {
  const key = sodium.crypto_secretstream_xchacha20poly1305_keygen()
  const { state, header } = sodium.crypto_secretstream_xchacha20poly1305_init_push(key)
  const out = new Uint8Array(encryptedSize(plain.length))
  out.set(header, 0)
  let at = header.length
  for (let offset = 0; offset < plain.length || offset === 0; offset += FILE_CHUNK) {
    const last = offset + FILE_CHUNK >= plain.length
    const tag = last ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE
    const chunk = sodium.crypto_secretstream_xchacha20poly1305_push(state, plain.subarray(offset, offset + FILE_CHUNK), AD, tag)
    out.set(chunk, at)
    at += chunk.length
    if (last) break
  }
  const result = { ciphertext: out, key: b64u(key), hash: b64u(sodium.crypto_generichash(32, out, null)) }
  sodium.memzero(key)
  return result
}

/** Checks the hash, then decrypts every chunk; anything off (wrong key, tampering, truncation, extra bytes) throws. */
export function decryptFile(ciphertext: Uint8Array, file: Pick<DmFile, 'key' | 'hash' | 'size'>): Uint8Array {
  const expected = fromB64u(file.hash)
  const actual = sodium.crypto_generichash(32, ciphertext, null)
  if (expected.length !== 32 || !sodium.memcmp(expected, actual)) throw new DmError("This file doesn't match what was sent.")
  const headerBytes = sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES
  const chunkBytes = FILE_CHUNK + sodium.crypto_secretstream_xchacha20poly1305_ABYTES
  if (ciphertext.length < headerBytes + sodium.crypto_secretstream_xchacha20poly1305_ABYTES) throw new DmError('This file is damaged.')

  const key = fromB64u(file.key)
  try {
    const state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(ciphertext.subarray(0, headerBytes), key)
    const out = new Uint8Array(Math.max(0, file.size))
    let written = 0
    let at = headerBytes
    let final = false
    while (at < ciphertext.length) {
      if (final) throw new DmError('This file is damaged.') // bytes after the final chunk
      const result = sodium.crypto_secretstream_xchacha20poly1305_pull(state, ciphertext.subarray(at, at + chunkBytes), AD)
      if (!result) throw new DmError('This file is damaged.')
      if (written + result.message.length > out.length) throw new DmError('This file is damaged.')
      out.set(result.message, written)
      written += result.message.length
      at += chunkBytes
      final = result.tag === sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
    }
    if (!final || written !== file.size) throw new DmError('This file is damaged.')
    return out
  } catch (e) {
    throw e instanceof DmError ? e : new DmError('This file is damaged.')
  } finally {
    sodium.memzero(key)
  }
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
