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
  /** The wrapped data key, the wrapped passphrase box (with `lock`), or '' when only passkeys open it. */
  data: string
  lock?: LockParams
  /** Passkeys that open the app lock, each with its own wrapped copy of the data key. */
  passkeys?: PasskeySlot[]
  /** The WebAuthn user handle for this device's passkeys (random, so it says nothing about the account). */
  passkeyUser?: string
}

/** One passkey: the data key under a key derived from that passkey's PRF output (see "Keys on the device"). */
export interface PasskeySlot {
  /** The credential id (b64u). */
  id: string
  name: string
  /** The PRF input for this passkey, also the HKDF salt (32 random bytes, b64u). */
  salt: string
  /** wrap(nonce(24) || secretbox(dataKey, kek)), b64u. */
  box: string
  rpId: string
  created: number
  lastUsed?: number
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

// ── Passkeys (WebAuthn PRF) ─────────────────────────────────────────────────

export const PASSKEY_CONTEXT = 'iskra/passkey-kek/v1'
export const MAX_PASSKEYS = 10

/** The key-encryption key: HKDF-SHA256(ikm = PRF output, salt = the slot's salt, info = context), 32 bytes. */
export async function passkeyKek(prf: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
  if (prf.length < 32) throw new Error('The passkey gave too short a secret.')
  const ikm = await crypto.subtle.importKey('raw', prf as Uint8Array<ArrayBuffer>, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as Uint8Array<ArrayBuffer>, info: new TextEncoder().encode(PASSKEY_CONTEXT) }, ikm, 256)
  return new Uint8Array(bits)
}

/** Locked by a passphrase or by at least one passkey. */
export const isLocked = (record: VaultRecord): boolean => !!record.lock || (record.passkeys?.length ?? 0) > 0

/** A fresh PRF input / salt for a new passkey. */
export const newPasskeySalt = (): Uint8Array => sodium.randombytes_buf(32)

async function sealToKek(dataKey: Uint8Array, kek: Uint8Array, wrapper: KeyWrapper): Promise<string> {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES)
  return b64u(await wrapper.wrap(new Uint8Array([...nonce, ...sodium.crypto_secretbox_easy(dataKey, nonce, kek)])))
}

/** Adds a passkey's slot. The data key must be open (the person is setting it up in Settings). */
export async function addPasskeySlot(
  record: VaultRecord, dataKey: Uint8Array, wrapper: KeyWrapper,
  passkey: { id: string; name: string; salt: Uint8Array; prf: Uint8Array; rpId: string; now?: number },
): Promise<VaultRecord> {
  const slots = record.passkeys ?? []
  if (slots.length >= MAX_PASSKEYS) throw new Error(`At most ${MAX_PASSKEYS} passkeys.`)
  if (slots.some((s) => s.id === passkey.id)) throw new Error('That passkey is already set up.')
  const kek = await passkeyKek(passkey.prf, passkey.salt)
  const slot: PasskeySlot = {
    id: passkey.id, name: passkey.name.slice(0, 64), salt: b64u(passkey.salt), box: await sealToKek(dataKey, kek, wrapper),
    rpId: passkey.rpId, created: passkey.now ?? Date.now(),
  }
  sodium.memzero(kek)
  // With only passkeys, nothing else may hold the data key.
  const data = record.lock ? record.data : ''
  return { ...record, data, passkeys: [...slots, slot] }
}

/** The data key from a passkey's PRF output, or null if this isn't one of ours or the output is wrong. */
export async function openPasskeySlot(record: VaultRecord, wrapper: KeyWrapper, id: string, prf: Uint8Array): Promise<Uint8Array | null> {
  const slot = record.passkeys?.find((s) => s.id === id)
  if (!slot) return null
  const kek = await passkeyKek(prf, fromB64u(slot.salt))
  try {
    const box = await wrapper.unwrap(fromB64u(slot.box))
    const n = sodium.crypto_secretbox_NONCEBYTES
    return sodium.crypto_secretbox_open_easy(box.slice(n), box.slice(0, n), kek)
  } catch {
    return null
  } finally {
    sodium.memzero(kek)
  }
}

/** Removes a passkey's slot. Without any lock left, the data key goes back under the device wrap alone. */
export async function removePasskeySlot(record: VaultRecord, id: string, dataKey: Uint8Array, wrapper: KeyWrapper): Promise<VaultRecord> {
  const passkeys = (record.passkeys ?? []).filter((s) => s.id !== id)
  const next: VaultRecord = { ...record, passkeys }
  if (!passkeys.length) delete next.passkeys
  if (!isLocked(next)) next.data = b64u(await wrapper.wrap(dataKey))
  return next
}

/** Sets, changes or (null) removes the passphrase, keeping any passkeys. */
export async function withPassphrase(record: VaultRecord, dataKey: Uint8Array, wrapper: KeyWrapper, passphrase: string | null, cost = DEFAULT_LOCK): Promise<VaultRecord> {
  const next: VaultRecord = { ...record, wrap: wrapper.kind }
  if (passphrase) {
    const { box, params } = lockDataKey(dataKey, passphrase, cost)
    next.data = b64u(await wrapper.wrap(box))
    next.lock = params
  } else {
    delete next.lock
    next.data = next.passkeys?.length ? '' : b64u(await wrapper.wrap(dataKey))
  }
  return next
}
