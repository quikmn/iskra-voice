// End-to-end encrypted direct messages. The server only ever sees envelopes produced here.
//
// - Every device's Ed25519 key converts to an X25519 key (libsodium's supported conversion), so the
//   account-signed device certificates also vouch for the encryption keys.
// - A message is encrypted once (XChaCha20-Poly1305) with a random key; the header (from, to, time, id)
//   is bound as associated data so it can't be swapped or replayed into another conversation.
// - That key is wrapped with crypto_box (authenticated: sender device → each recipient device and each of
//   the sender's own devices, so your other devices and your history can read it too).
// - No device keys means no message. There is no plaintext fallback.
import sodium from 'libsodium-wrappers-sumo'
import { b64u, fromB64u, randomBytes } from './crypto'
import { verifyDeviceCert, type DeviceCert, type Identity } from './identity'

export interface DmHeader {
  from: string
  to: string
  sentAt: number
  id: string
}

export interface DmEnvelope {
  v: 1
  header: DmHeader
  sender: DeviceCert
  nonce: string
  ct: string
  keys: { device: string; nonce: string; box: string }[]
}

export interface DmContent {
  text: string
  /** A call invite or call log entry (see state/calls.ts, which checks it). `text` is the fallback for other apps. */
  call?: Record<string, unknown>
}

export class DmError extends Error {}

const MAX_TEXT = 4000

function associatedData(header: DmHeader): Uint8Array {
  // An array has a fixed order, unlike object keys.
  return new TextEncoder().encode(JSON.stringify(['iskra/dm/v1', header.from, header.to, header.sentAt, header.id]))
}

const toX25519Public = (deviceKey: string) => sodium.crypto_sign_ed25519_pk_to_curve25519(fromB64u(deviceKey))
const toX25519Secret = (identity: Identity) => sodium.crypto_sign_ed25519_sk_to_curve25519(identity.device.secretKey)

/** Only certificates actually signed by the account they claim. */
function validDevices(certs: DeviceCert[], accountKey: string): DeviceCert[] {
  const seen = new Set<string>()
  return certs.filter((c) => {
    if (c.accountKey !== accountKey || seen.has(c.deviceKey) || !verifyDeviceCert(c)) return false
    seen.add(c.deviceKey)
    return true
  })
}

export function encryptDm(
  identity: Identity,
  to: string,
  recipientDevices: DeviceCert[],
  ownDevices: DeviceCert[],
  content: DmContent,
  now = Date.now(),
): DmEnvelope {
  const from = b64u(identity.account.publicKey)
  const recipients = validDevices(recipientDevices, to)
  if (recipients.length === 0) throw new DmError("This person hasn't got any devices we can encrypt to yet.")
  if (content.text.length === 0 || content.text.length > MAX_TEXT) throw new DmError(`Messages must be 1–${MAX_TEXT} characters.`)

  // Always include this device, so the sender can read their own history later.
  const mine = validDevices([identity.cert, ...ownDevices], from)
  const targets = [...recipients, ...mine.filter((d) => !recipients.some((r) => r.deviceKey === d.deviceKey))]

  const header: DmHeader = { from, to, sentAt: now, id: b64u(randomBytes(12)) }
  const messageKey = sodium.crypto_aead_xchacha20poly1305_ietf_keygen()
  const nonce = randomBytes(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
  const plaintext = new TextEncoder().encode(JSON.stringify(content))
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, associatedData(header), null, nonce, messageKey)

  const mySecret = toX25519Secret(identity)
  const keys = targets.map((device) => {
    const boxNonce = randomBytes(sodium.crypto_box_NONCEBYTES)
    const box = sodium.crypto_box_easy(messageKey, boxNonce, toX25519Public(device.deviceKey), mySecret)
    return { device: device.deviceKey, nonce: b64u(boxNonce), box: b64u(box) }
  })
  sodium.memzero(messageKey)
  sodium.memzero(mySecret)

  return { v: 1, header, sender: identity.cert, nonce: b64u(nonce), ct: b64u(ct), keys }
}

/**
 * Decrypts an envelope. <paramref name="from"/> and <paramref name="to"/> are what the server says
 * (it routed the message); they must match the encrypted header.
 */
export function decryptDm(identity: Identity, envelope: DmEnvelope, from: string, to: string): DmContent & { header: DmHeader } {
  if (!envelope || envelope.v !== 1 || !envelope.header || !envelope.sender || !Array.isArray(envelope.keys))
    throw new DmError('Unsupported message format.')
  const { header, sender } = envelope
  const me = b64u(identity.account.publicKey)

  if (header.from !== from || header.to !== to) throw new DmError("This message's sender or recipient doesn't match.")
  if (from !== me && to !== me) throw new DmError("This message isn't for you.")
  if (sender.accountKey !== header.from || !verifyDeviceCert(sender)) throw new DmError("The sender's device couldn't be verified.")

  const myDevice = b64u(identity.device.publicKey)
  const slot = envelope.keys.find((k) => k.device === myDevice)
  if (!slot) throw new DmError("This message wasn't encrypted for this device.")

  const mySecret = toX25519Secret(identity)
  let messageKey: Uint8Array
  try {
    messageKey = sodium.crypto_box_open_easy(fromB64u(slot.box), fromB64u(slot.nonce), toX25519Public(sender.deviceKey), mySecret)
  } catch {
    throw new DmError("This message couldn't be decrypted.")
  } finally {
    sodium.memzero(mySecret)
  }

  let plaintext: Uint8Array
  try {
    plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, fromB64u(envelope.ct), associatedData(header), fromB64u(envelope.nonce), messageKey)
  } catch {
    throw new DmError('This message was tampered with.')
  } finally {
    sodium.memzero(messageKey)
  }

  const content = JSON.parse(new TextDecoder().decode(plaintext)) as Partial<DmContent>
  if (typeof content.text !== 'string' || content.text.length > MAX_TEXT) throw new DmError('Unsupported message content.')
  const call = content.call && typeof content.call === 'object' && !Array.isArray(content.call) ? { call: content.call } : {}
  return { text: content.text, header, ...call }
}

/**
 * A number two people can compare (in person or on a call) to be sure they have each other's real keys.
 * The same for both sides: 12 groups of 5 digits.
 */
export function safetyNumber(a: string, b: string): string {
  const [first, second] = [a, b].sort()
  const hash = sodium.crypto_generichash(60, new Uint8Array([...fromB64u(first), ...fromB64u(second)]), null)
  const groups: string[] = []
  for (let i = 0; i < 60; i += 5) {
    let n = 0
    for (let j = 0; j < 5; j++) n = n * 256 + hash[i + j]
    groups.push(String(n % 100000).padStart(5, '0'))
  }
  return groups.join(' ')
}
