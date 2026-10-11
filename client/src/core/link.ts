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

/** Does what the person typed match the confirmation code (spaces and dashes ignored)? */
export function sameConfirmation(typed: string, code: string): boolean {
  const digits = typed.replace(/[\s-]/g, '')
  return /^\d{6}$/.test(digits) && digits === code.replace(/ /g, '')
}

/** Six digits from both ephemeral keys: "042 917". The new device shows them, the person types them into the existing one. */
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
  | { state: 'done'; payload: string; parts?: number }

export class LinkRelayError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function relayError(status: number): LinkRelayError {
  if (status === 404) return new LinkRelayError(status, 'This code has expired or was cancelled. Make a new one on your other device.')
  if (status === 409) {
    return new LinkRelayError(status,
      "Another device already used this code. If that wasn't you, someone may have seen it: cancel the link on your other device and don't confirm anything there.")
  }
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
export async function relayDeliver(serverUrl: string, token: string, putKey: string, sealed: Uint8Array, parts = 0): Promise<void> {
  const response = await fetch(`${serverUrl}/link/${encodeURIComponent(token)}?key=${encodeURIComponent(putKey)}${parts ? `&parts=${parts}` : ''}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: sealed as BodyInit,
  })
  if (!response.ok) throw relayError(response.status)
}

// ── History parts: message history follows the account in sealed parts, each ≤ 1 MB on the relay ──

/** Plaintext bytes per part (the sealed part adds 40 bytes and 8 for the index and count). */
export const PART_BYTES = 768 * 1024

/** Splits bytes into parts of at most `size`. */
export function splitParts(bytes: Uint8Array, size = PART_BYTES): Uint8Array[] {
  const parts: Uint8Array[] = []
  for (let i = 0; i < bytes.length; i += size) parts.push(bytes.slice(i, i + size))
  return parts.length ? parts : [new Uint8Array()]
}

/** nonce(24) || crypto_box(u32be(index) || u32be(count) || bytes): the index and count are sealed with the part, so the relay can't reorder, swap or drop parts unnoticed. */
export function sealPart(index: number, count: number, bytes: Uint8Array, existing: EphemeralKey, newKey: Uint8Array): Uint8Array {
  const plain = new Uint8Array(8 + bytes.length)
  const view = new DataView(plain.buffer)
  view.setUint32(0, index)
  view.setUint32(4, count)
  plain.set(bytes, 8)
  const nonce = randomBytes(sodium.crypto_box_NONCEBYTES)
  return new Uint8Array([...nonce, ...sodium.crypto_box_easy(plain, nonce, newKey, existing.secretKey)])
}

export function openPart(sealed: Uint8Array, index: number, count: number, existingKey: Uint8Array, mine: EphemeralKey): Uint8Array {
  const n = sodium.crypto_box_NONCEBYTES
  const plain = sodium.crypto_box_open_easy(sealed.slice(n), sealed.slice(0, n), existingKey, mine.secretKey)
  const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength)
  if (plain.length < 8 || view.getUint32(0) !== index || view.getUint32(4) !== count) throw new Error('Part of the history arrived out of order.')
  return plain.slice(8)
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The existing device uploads part `index`; waits while the new device catches up (the relay holds only a few). */
export async function relayPutPart(serverUrl: string, token: string, putKey: string, index: number, sealed: Uint8Array, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const response = await fetch(`${serverUrl}/link/${encodeURIComponent(token)}/part/${index}?key=${encodeURIComponent(putKey)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: sealed as BodyInit,
    })
    if (response.ok) return
    if (response.status !== 429 || Date.now() > deadline) throw response.status === 429 ? new LinkRelayError(429, 'The new device stopped receiving your history.') : relayError(response.status)
    await wait(400)
  }
}

/** The new device takes part `index`, waiting for it to arrive. */
export async function relayTakePart(code: LinkCode, readKey: string, index: number, timeoutMs = 120_000): Promise<Uint8Array> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const response = await fetch(`${relayUrl(code)}/part/${index}?key=${encodeURIComponent(readKey)}`, { cache: 'no-store' })
    if (response.status === 200) return new Uint8Array(await response.arrayBuffer())
    if (response.status !== 204 || Date.now() > deadline) throw response.status === 204 ? new LinkRelayError(408, 'Your other device stopped sending your history.') : relayError(response.status)
  }
}
