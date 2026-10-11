// Small private records an account keeps on its servers without them being able to read them (what a reminder is
// about, and its note). Sealed with XChaCha20-Poly1305 under a key derived from the account seed, which only the
// account's devices have; the purpose is associated data, so a record can't be passed off as another kind.
import sodium from 'libsodium-wrappers-sumo'
import { b64u, fromB64u } from './crypto'

const KDF_CONTEXT = 'iskrapri' // libsodium KDF contexts are exactly 8 bytes
const AD_CONTEXT = 'iskra/private/v1'

/** The account's key for private records: crypto_kdf subkey 2 of the 32-byte account seed. */
export function privateKey(accountSecretKey: Uint8Array): Uint8Array {
  return sodium.crypto_kdf_derive_from_key(32, 2, KDF_CONTEXT, accountSecretKey.slice(0, 32))
}

const associated = (purpose: string) => new TextEncoder().encode(`${AD_CONTEXT}\0${purpose}`)

/** nonce(24) || ciphertext, base64url. */
export function sealPrivate(key: Uint8Array, purpose: string, value: unknown): string {
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
  const plain = new TextEncoder().encode(JSON.stringify(value))
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plain, associated(purpose), null, nonce, key)
  const out = new Uint8Array(nonce.length + ct.length)
  out.set(nonce)
  out.set(ct, nonce.length)
  return b64u(out)
}

/** The value, or null if it isn't ours, isn't for this purpose or was tampered with. */
export function openPrivate(key: Uint8Array, purpose: string, data: string): unknown {
  try {
    const bytes = fromB64u(data)
    const n = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
    if (bytes.length <= n) return null
    const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, bytes.slice(n), associated(purpose), bytes.slice(0, n), key)
    return JSON.parse(new TextDecoder().decode(plain)) as unknown
  } catch {
    return null
  }
}
