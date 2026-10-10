// Settings that follow an account across devices (prefs.get/prefs.set). They're sealed with a key derived from the
// account seed, which only the account's devices have, so servers store them without being able to read them.
import sodium from 'libsodium-wrappers-sumo'
import { b64u, fromB64u } from './crypto'

const KDF_CONTEXT = 'iskrapre' // libsodium KDF contexts are exactly 8 bytes
const AD_CONTEXT = 'iskra/prefs/v1'

/** The account's prefs key: crypto_kdf subkey 1 of the 32-byte account seed. */
export function prefsKey(accountSecretKey: Uint8Array): Uint8Array {
  return sodium.crypto_kdf_derive_from_key(32, 1, KDF_CONTEXT, accountSecretKey.slice(0, 32))
}

const associated = (name: string) => new TextEncoder().encode(`${AD_CONTEXT}\0${name}`)

/** XChaCha20-Poly1305 with the setting's name as associated data, so one setting can't be passed off as another. */
export function sealPrefs(key: Uint8Array, name: string, value: string): string {
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(new TextEncoder().encode(value), associated(name), null, nonce, key)
  const out = new Uint8Array(nonce.length + ct.length)
  out.set(nonce)
  out.set(ct, nonce.length)
  return b64u(out)
}

/** The value, or null if it isn't ours or was tampered with. */
export function openPrefs(key: Uint8Array, name: string, data: string): string | null {
  try {
    const bytes = fromB64u(data)
    const n = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
    if (bytes.length <= n) return null
    const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, bytes.slice(n), associated(name), bytes.slice(0, n), key)
    return new TextDecoder().decode(plain)
  } catch {
    return null
  }
}
