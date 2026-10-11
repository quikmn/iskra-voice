// Encryption at rest for what this device stores: keys, prekeys and decrypted DM history.
// See "Keys on the device" in protocol/PROTOCOL.md.
//
// A random data key encrypts each stored secret (XChaCha20-Poly1305, bound to its storage slot). The data key itself
// is wrapped by the platform: Electron safeStorage in the desktop app (DPAPI / Keychain / libsecret), or a
// non-extractable WebCrypto key in the browser. An optional app lock passphrase (Argon2id) wraps it once more.
import sodium from 'libsodium-wrappers-sumo'
import { b64u, fromB64u } from './crypto'

export const LOCAL_CONTEXT = 'iskra/local/v1'

/** How the data key is protected on this device. */
export type WrapKind = 'system' | 'browser'

/** Something that can wrap and unwrap the data key without ever showing its own key to the page. */
export interface KeyWrapper {
  kind: WrapKind
  wrap(data: Uint8Array): Promise<Uint8Array>
  unwrap(data: Uint8Array): Promise<Uint8Array>
}

export interface LockParams {
  salt: string
  opslimit: number
  memlimit: number
}

/** What's stored under "vault": the wrapped data key (or the wrapped passphrase box around it). */
export interface VaultRecord {
  v: 1
  wrap: WrapKind
  data: string
  lock?: LockParams
}

export interface SealedValue {
  $sealed: 1
  n: string
  c: string
}

export const isSealed = (value: unknown): value is SealedValue =>
  !!value && typeof value === 'object' && (value as SealedValue).$sealed === 1 && typeof (value as SealedValue).n === 'string'

/** Argon2id parameters for the app lock: about half a second on a phone, 64 MiB. */
export const DEFAULT_LOCK = { opslimit: 3, memlimit: 64 * 1024 * 1024 }

const ad = (slot: string) => new TextEncoder().encode(`${LOCAL_CONTEXT}\0${slot}`)

export const newDataKey = (): Uint8Array => sodium.crypto_aead_xchacha20poly1305_ietf_keygen()

export function sealValue(dataKey: Uint8Array, slot: string, value: unknown): SealedValue {
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
  const plaintext = new TextEncoder().encode(JSON.stringify(value))
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, ad(slot), null, nonce, dataKey)
  return { $sealed: 1, n: b64u(nonce), c: b64u(ct) }
}

export function openValue<T>(dataKey: Uint8Array, slot: string, sealed: SealedValue): T {
  const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, fromB64u(sealed.c), ad(slot), fromB64u(sealed.n), dataKey)
  return JSON.parse(new TextDecoder().decode(plaintext)) as T
}

function passKey(passphrase: string, params: LockParams): Uint8Array {
  return sodium.crypto_pwhash(
    sodium.crypto_secretbox_KEYBYTES, new TextEncoder().encode(passphrase.normalize('NFC')), fromB64u(params.salt),
    params.opslimit, params.memlimit, sodium.crypto_pwhash_ALG_ARGON2ID13,
  )
}

/** nonce(24) || secretbox(dataKey) under a key derived from the passphrase. */
export function lockDataKey(dataKey: Uint8Array, passphrase: string, cost = DEFAULT_LOCK): { box: Uint8Array; params: LockParams } {
  const params = { salt: b64u(sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES)), ...cost }
  const key = passKey(passphrase, params)
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES)
  const box = new Uint8Array([...nonce, ...sodium.crypto_secretbox_easy(dataKey, nonce, key)])
  sodium.memzero(key)
  return { box, params }
}

/** Null if the passphrase is wrong. */
export function unlockDataKey(box: Uint8Array, passphrase: string, params: LockParams): Uint8Array | null {
  const key = passKey(passphrase, params)
  try {
    const n = sodium.crypto_secretbox_NONCEBYTES
    return sodium.crypto_secretbox_open_easy(box.slice(n), box.slice(0, n), key)
  } catch {
    return null
  } finally {
    sodium.memzero(key)
  }
}

/**
 * Browser wrap: AES-GCM with a CryptoKey created non-extractable. The key object is kept in IndexedDB, so page
 * scripts can use it but never read its bytes. It keeps the data key out of exports and dumps of the stored data;
 * it doesn't stop anyone who can run code in the app or copies the whole browser profile.
 */
export function browserWrapper(loadKey: () => Promise<CryptoKey | undefined>, saveKey: (key: CryptoKey) => Promise<void>): KeyWrapper {
  let cached: CryptoKey | undefined
  const key = async () => {
    cached ??= await loadKey()
    if (!cached) {
      cached = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      await saveKey(cached)
    }
    return cached
  }
  return {
    kind: 'browser',
    async wrap(data) {
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), data as Uint8Array<ArrayBuffer>))
      return new Uint8Array([...iv, ...ct])
    },
    async unwrap(data) {
      const k = cached ?? (await loadKey())
      if (!k) throw new Error('The key that protects this device\'s data is missing.')
      cached = k
      return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12) }, k, data.slice(12)))
    },
  }
}
