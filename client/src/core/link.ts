// Device linking: moving your account to a new device by scanning a QR code (or typing a short code).
// See "Device linking" in protocol/PROTOCOL.md.
//
// The code holds a relay token (the server sees it) and a 16-byte secret (it never does). Both devices
// prove they know the secret by MACing their ephemeral X25519 keys with it, and both show a confirmation
// code derived from the two keys, so the server in the middle can't swap keys. Only then does the existing
// device send the account seed, crypto_box'd from its ephemeral key to the new device's.
import sodium from 'libsodium-wrappers-sumo'
import { b64u, fromB64u, randomBytes } from './crypto'
import { normalizeServerUrl } from './invite'
import { fromBase32, toBase32 } from './recovery'

const TOKEN_BYTES = 10
const SECRET_BYTES = 16
const KDF_CONTEXT = 'isklink1' // crypto_kdf contexts are exactly 8 bytes

export interface LinkCode {
  serverUrl: string
  /** The relay token (b64u), as the server issued it. */
  token: string
  secret: Uint8Array
}

/** "chat.example.com/7K3M-Q9XA-…" (https is implied; other schemes are spelled out). */
export function encodeLinkCode(code: LinkCode): string {
  const host = code.serverUrl.replace(/^https:\/\//, '')
  const body = toBase32(new Uint8Array([...fromB64u(code.token), ...code.secret]))
  return `${host}/${body.match(/.{1,4}/g)!.join('-')}`
}

/** The QR code: opens the web app straight into linking. The part after # never reaches any server. */
export function linkAppUrl(appUrl: string, code: LinkCode): string {
  return `${appUrl.replace(/\/+$/, '')}/#/link/${encodeURIComponent(encodeLinkCode(code))}`
}

/** Accepts the text code (any case, spacing and dashes) or the app link from the QR code. */
export function parseLinkCode(input: string): LinkCode | null {
  let text = input.trim()
  const marker = text.indexOf('#/link/')
  if (marker >= 0) {
    try {
      text = decodeURIComponent(text.slice(marker + 7))
    } catch {
      return null
    }
  }
  text = text.replace(/\s+/g, '')
  const slash = text.lastIndexOf('/')
  if (slash <= 0) return null
  const host = text.slice(0, slash)
  const body = text.slice(slash + 1).toUpperCase().replace(/-/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  const bytes = fromBase32(body)
  if (!bytes || bytes.length !== TOKEN_BYTES + SECRET_BYTES || body.length !== Math.ceil(((TOKEN_BYTES + SECRET_BYTES) * 8) / 5)) return null
  const serverUrl = normalizeServerUrl(/^https?:\/\//i.test(host) ? host : `https://${host}`)
  if (!serverUrl) return null
  return { serverUrl, token: b64u(bytes.slice(0, TOKEN_BYTES)), secret: bytes.slice(TOKEN_BYTES) }
}

export const newLinkSecret = () => randomBytes(SECRET_BYTES)

export interface LinkKeys {
  macNew: Uint8Array
  macExisting: Uint8Array
  confirm: Uint8Array
}

/** Keys derived from the code: one MAC key per side, one for the confirmation code. */
export function linkKeys(code: LinkCode): LinkKeys {
  const master = sodium.crypto_generichash(32, new Uint8Array([...fromB64u(code.token), ...code.secret]), new TextEncoder().encode('iskra/link/v1'))
  const keys = {
    macNew: sodium.crypto_kdf_derive_from_key(32, 1, KDF_CONTEXT, master),
    macExisting: sodium.crypto_kdf_derive_from_key(32, 2, KDF_CONTEXT, master),
    confirm: sodium.crypto_kdf_derive_from_key(32, 3, KDF_CONTEXT, master),
  }
  sodium.memzero(master)
  return keys
}

export interface EphemeralKey {
  publicKey: Uint8Array
  secretKey: Uint8Array
}

export function ephemeralKey(): EphemeralKey {
  const kp = sodium.crypto_box_keypair()
  return { publicKey: kp.publicKey, secretKey: kp.privateKey }
}

/** Proof that whoever sent this key has the code. */
export const macKey = (key: Uint8Array, macKeyBytes: Uint8Array) => b64u(sodium.crypto_auth(key, macKeyBytes))

export function checkMac(epk: string, mac: string, macKeyBytes: Uint8Array): Uint8Array | null {
  try {
    const key = fromB64u(epk)
    if (key.length !== 32) return null
    return sodium.crypto_auth_verify(fromB64u(mac), key, macKeyBytes) ? key : null
  } catch {
    return null
  }
}

/** Six digits both screens show, from both ephemeral keys: "042 917". */
export function confirmationCode(keys: LinkKeys, existingKey: Uint8Array, newKey: Uint8Array): string {
  const hash = sodium.crypto_generichash(8, new Uint8Array([...existingKey, ...newKey]), keys.confirm)
  const n = new DataView(hash.buffer, hash.byteOffset, 8).getUint32(0) % 1_000_000
  const digits = String(n).padStart(6, '0')
  return `${digits.slice(0, 3)} ${digits.slice(3)}`
}

/** nonce(24) || crypto_box(payload) from the existing device's ephemeral key to the new device's. */
export function sealPayload(payload: unknown, existing: EphemeralKey, newKey: Uint8Array): Uint8Array {
  const nonce = randomBytes(sodium.crypto_box_NONCEBYTES)
  const box = sodium.crypto_box_easy(new TextEncoder().encode(JSON.stringify(payload)), nonce, newKey, existing.secretKey)
  return new Uint8Array([...nonce, ...box])
}

export function openPayload<T>(sealed: Uint8Array, existingKey: Uint8Array, mine: EphemeralKey): T {
  const n = sodium.crypto_box_NONCEBYTES
  const plain = sodium.crypto_box_open_easy(sealed.slice(n), sealed.slice(0, n), existingKey, mine.secretKey)
  return JSON.parse(new TextDecoder().decode(plain)) as T
}

// ── The relay over HTTP (the new device has no account, so no WebSocket) ────

export type RelayState =
  | { state: 'waiting' }
  | { state: 'answered'; epk: string; mac: string }
  | { state: 'done'; payload: string }

export class LinkRelayError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function relayError(status: number): LinkRelayError {
  if (status === 404) return new LinkRelayError(status, 'This code has expired or was cancelled. Make a new one on your other device.')
  if (status === 409) return new LinkRelayError(status, 'This code was already used by another device.')
  if (status === 429) return new LinkRelayError(status, 'Took too long. Make a new code on your other device.')
  return new LinkRelayError(status, `The server said no (${status}).`)
}

const relayUrl = (code: LinkCode) => `${code.serverUrl}/link/${encodeURIComponent(code.token)}`

/** The new device announces its key. Returns the key it polls with. */
export async function relayRequest(code: LinkCode, body: { epk: string; mac: string; info: string }): Promise<string> {
  const response = await fetch(relayUrl(code), { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) })
  if (!response.ok) throw relayError(response.status)
  return ((await response.json()) as { key: string }).key
}

export async function relayPoll(code: LinkCode, readKey: string): Promise<RelayState> {
  const response = await fetch(`${relayUrl(code)}?key=${encodeURIComponent(readKey)}`, { cache: 'no-store' })
  if (!response.ok) throw relayError(response.status)
  return (await response.json()) as RelayState
}

/** The existing device uploads the sealed payload (with the put key from link.create). */
export async function relayDeliver(serverUrl: string, token: string, putKey: string, sealed: Uint8Array): Promise<void> {
  const response = await fetch(`${serverUrl}/link/${encodeURIComponent(token)}?key=${encodeURIComponent(putKey)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: sealed as BodyInit,
  })
  if (!response.ok) throw relayError(response.status)
}
