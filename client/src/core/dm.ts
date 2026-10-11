// End-to-end encrypted direct messages. The server only ever sees envelopes produced here.
//
// - Every device's Ed25519 key converts to an X25519 key (libsodium's supported conversion), so the
//   account-signed device certificates also vouch for the encryption keys.
// - A message is encrypted once (XChaCha20-Poly1305) with a random key; the header (from, to, time, id)
//   is bound as associated data so it can't be swapped or replayed into another conversation.
// - That key is wrapped for each recipient device and each of the sender's own devices, so your other
//   devices and your history can read it too.
//   - v2 (forward secret): to the device's current signed prekey. crypto_box from the sender's device key
//     (authenticates the sender), inside crypto_box_seal (a fresh ephemeral key per message). Once the
//     recipient deletes that prekey, nobody can unwrap it again, not even with every long-term key.
//   - v1, and v2 for a device without a usable prekey: crypto_box from the sender's device key to the
//     recipient's device key.
// - No device keys means no message. There is no plaintext fallback.
import { checkFiles, type DmFile } from './dmFiles'
import sodium from 'libsodium-wrappers-sumo'
import { b64u, fromB64u, randomBytes } from './crypto'
import { currentPrekey, usablePrekeys, type SignedPrekey } from './devices'
import { verifyDeviceCert, type DeviceCert, type Identity } from './identity'

export interface DmHeader {
  from: string
  to: string
  sentAt: number
  id: string
}

/** Key slot wrapped to the device's long-term key (v1, or v2 without a prekey). */
export interface DmStaticSlot {
  device: string
  nonce: string
  box: string
}

/** Forward-secret key slot (v2): sealed to one of the device's signed prekeys. */
export interface DmPrekeySlot {
  device: string
  prekey: string
  seal: string
}

export interface DmEnvelope {
  v: 1 | 2
  header: DmHeader
  sender: DeviceCert
  nonce: string
  ct: string
  keys: (DmStaticSlot | DmPrekeySlot)[]
}

export interface DmContent {
  text: string
  /** A call invite or call log entry (see state/calls.ts, which checks it). `text` is the fallback for other apps. */
  call?: Record<string, unknown>
  /** Group DMs only: a rename and the like (see state/groups.ts, which checks it). */
  group?: Record<string, unknown>
  /** A forwarded message: where from (null: not shown) and its files, as links. */
  forward?: DmForward
  /** End-to-end encrypted attachments (core/dmFiles.ts); `text` may then be empty. */
  files?: DmFile[]
  /** A signed friend action (core/friend.ts, which checks it). `text` is the fallback for other apps. */
  friend?: Record<string, unknown>
}

export interface DmForward {
  from: string | null
  files: { name: string; url: string; size: number; type: string }[]
}

/** Checks a forward from someone else's device: plain strings, http(s) links only, bounded sizes. Null if unusable. */
export function cleanForward(raw: unknown): DmForward | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const { from, files } = raw as Record<string, unknown>
  if (from !== null && (typeof from !== 'string' || from.length > 120)) return null
  if (!Array.isArray(files) || files.length > 10) return null
  const clean: DmForward['files'] = []
  for (const f of files) {
    if (!f || typeof f !== 'object') return null
    const { name, url, size, type } = f as Record<string, unknown>
    if (typeof name !== 'string' || name.length === 0 || name.length > 200) return null
    if (typeof url !== 'string' || url.length > 2000 || !/^https?:\/\/[^\s]+$/i.test(url)) return null
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return null
    if (typeof type !== 'string' || type.length > 100) return null
    clean.push({ name, url, size, type })
  }
  return { from: from as string | null, files: clean }
}

export interface EncryptOptions {
  /**
   * Signed prekeys of the recipient's and your own devices (from `dm.devices`). Passing this, even empty,
   * makes a v2 envelope: forward secret for every device with a usable prekey.
   */
  prekeys?: SignedPrekey[]
  /** Device keys known to be revoked (checked revocations); they get no key slot. */
  revokedDevices?: Iterable<string>
}

export class DmError extends Error {}

const MAX_TEXT = 4000

function associatedData(v: 1 | 2, header: DmHeader): Uint8Array {
  // An array has a fixed order, unlike object keys.
  return new TextEncoder().encode(JSON.stringify([`iskra/dm/v${v}`, header.from, header.to, header.sentAt, header.id]))
}

const toX25519Public = (deviceKey: string) => sodium.crypto_sign_ed25519_pk_to_curve25519(fromB64u(deviceKey))
const toX25519Secret = (identity: Identity) => sodium.crypto_sign_ed25519_sk_to_curve25519(identity.device.secretKey)

/** Only certificates actually signed by the account they claim, and not revoked. */
export function validDevices(certs: DeviceCert[], accountKey: string, revoked: Set<string>): DeviceCert[] {
  const seen = new Set<string>()
  return certs.filter((c) => {
    if (c.accountKey !== accountKey || seen.has(c.deviceKey) || revoked.has(c.deviceKey) || !verifyDeviceCert(c)) return false
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
  options: EncryptOptions = {},
): DmEnvelope {
  const from = b64u(identity.account.publicKey)
  const revoked = revokedFor(identity, options)
  const recipients = validDevices(recipientDevices, to, revoked)
  if (recipients.length === 0) throw new DmError("This person hasn't got any devices we can encrypt to yet.")
  checkText(content)

  // Always include this device, so the sender can read their own history later.
  const mine = validDevices([identity.cert, ...ownDevices], from, revoked)
  const targets = [...recipients, ...mine.filter((d) => !recipients.some((r) => r.deviceKey === d.deviceKey))]

  const v = options.prekeys ? 2 : 1
  const header: DmHeader = { from, to, sentAt: now, id: b64u(randomBytes(12)) }
  return { v, header, sender: identity.cert, ...sealContent(identity, associatedData(v, header), targets, content, now, v === 2 ? options.prekeys : undefined) }
}

/** Device keys that get no slot: the known revocations, but never the sending device itself. */
export function revokedFor(identity: Identity, options: EncryptOptions): Set<string> {
  const revoked = new Set(options.revokedDevices ?? [])
  revoked.delete(identity.cert.deviceKey) // this device is sending, so it isn't revoked as far as we know
  return revoked
}

export function checkText(content: DmContent): void {
  const hasFiles = (content.files?.length ?? 0) > 0
  if ((content.text.length === 0 && !hasFiles) || content.text.length > MAX_TEXT) throw new DmError(`Messages must be 1–${MAX_TEXT} characters.`)
}

/**
 * Encrypts `content` once and wraps its key for each target device: to its signed prekey when `prekeys` is given
 * and it has a usable one (forward secret), else to its device key. Shared by DMs and group DMs.
 */
export function sealContent(
  identity: Identity, aad: Uint8Array, targets: DeviceCert[], content: unknown, now: number, signedPrekeys: SignedPrekey[] | undefined,
): Pick<DmEnvelope, 'nonce' | 'ct' | 'keys'> {
  const prekeys = usablePrekeys(signedPrekeys, now)
  const ownPrekey = currentPrekey(identity.prekeys)
  const prekeyFor = (deviceKey: string): Uint8Array | undefined => {
    if (!signedPrekeys) return undefined
    if (deviceKey === identity.cert.deviceKey && ownPrekey) return ownPrekey.publicKey
    const signed = prekeys.get(deviceKey)
    return signed ? fromB64u(signed.key) : undefined
  }

  const messageKey = sodium.crypto_aead_xchacha20poly1305_ietf_keygen()
  const nonce = randomBytes(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
  const plaintext = new TextEncoder().encode(JSON.stringify(content))
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, aad, null, nonce, messageKey)

  const mySecret = toX25519Secret(identity)
  const keys = targets.map((device): DmStaticSlot | DmPrekeySlot => {
    const prekey = prekeyFor(device.deviceKey)
    if (prekey) {
      const innerNonce = randomBytes(sodium.crypto_box_NONCEBYTES)
      const inner = sodium.crypto_box_easy(messageKey, innerNonce, prekey, mySecret)
      const seal = sodium.crypto_box_seal(new Uint8Array([...innerNonce, ...inner]), prekey)
      return { device: device.deviceKey, prekey: b64u(prekey), seal: b64u(seal) }
    }
    const boxNonce = randomBytes(sodium.crypto_box_NONCEBYTES)
    const box = sodium.crypto_box_easy(messageKey, boxNonce, toX25519Public(device.deviceKey), mySecret)
    return { device: device.deviceKey, nonce: b64u(boxNonce), box: b64u(box) }
  })
  sodium.memzero(messageKey)
  sodium.memzero(mySecret)
  return { nonce: b64u(nonce), ct: b64u(ct), keys }
}

/** Unwraps the message key from this device's slot. */
function openSlot(identity: Identity, slot: DmStaticSlot | DmPrekeySlot, sender: DeviceCert): Uint8Array {
  const senderPublic = toX25519Public(sender.deviceKey)
  if ('seal' in slot) {
    const prekey = identity.prekeys?.find((p) => b64u(p.publicKey) === slot.prekey)
    if (!prekey) throw new DmError("This message was locked to an older key that this device has since deleted, so it can't be read here.")
    try {
      const inner = sodium.crypto_box_seal_open(fromB64u(slot.seal), prekey.publicKey, prekey.secretKey)
      const n = sodium.crypto_box_NONCEBYTES
      return sodium.crypto_box_open_easy(inner.slice(n), inner.slice(0, n), senderPublic, prekey.secretKey)
    } catch {
      throw new DmError("This message couldn't be decrypted.")
    }
  }
  const mySecret = toX25519Secret(identity)
  try {
    return sodium.crypto_box_open_easy(fromB64u(slot.box), fromB64u(slot.nonce), senderPublic, mySecret)
  } catch {
    throw new DmError("This message couldn't be decrypted.")
  } finally {
    sodium.memzero(mySecret)
  }
}

/**
 * Decrypts an envelope (v1 or v2). <paramref name="from"/> and <paramref name="to"/> are what the server says
 * (it routed the message); they must match the encrypted header. <paramref name="same"/> says whether two account
 * keys are one person (a verified key rotation, see core/rotation.ts): servers re-route old messages to the new key.
 */
export function decryptDm(
  identity: Identity, envelope: DmEnvelope, from: string, to: string,
  same: (a: string, b: string) => boolean = (a, b) => a === b,
): DmContent & { header: DmHeader } {
  if (!envelope || (envelope.v !== 1 && envelope.v !== 2) || !envelope.header || !envelope.sender || !Array.isArray(envelope.keys))
    throw new DmError('Unsupported message format.')
  const { header, sender } = envelope
  const me = b64u(identity.account.publicKey)

  if (!same(header.from, from) || !same(header.to, to)) throw new DmError("This message's sender or recipient doesn't match.")
  if (!same(from, me) && !same(to, me)) throw new DmError("This message isn't for you.")
  if (sender.accountKey !== header.from || !verifyDeviceCert(sender)) throw new DmError("The sender's device couldn't be verified.")

  return { ...openContent(identity, envelope, associatedData(envelope.v, header)), header }
}

/** Finds this device's slot, unwraps the message key and decrypts. The sender certificate must already be checked. */
export function openContent(identity: Identity, envelope: Pick<DmEnvelope, 'v' | 'sender' | 'nonce' | 'ct' | 'keys'>, aad: Uint8Array): DmContent {
  const myDevice = b64u(identity.device.publicKey)
  const slot = envelope.keys.find((k) => k?.device === myDevice)
  if (!slot) throw new DmError("This message wasn't encrypted for this device.")
  // v1 envelopes only ever have static slots.
  if (envelope.v === 1 && 'seal' in slot) throw new DmError('Unsupported message format.')

  const messageKey = openSlot(identity, slot, envelope.sender)
  let plaintext: Uint8Array
  try {
    plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, fromB64u(envelope.ct), aad, fromB64u(envelope.nonce), messageKey)
  } catch {
    throw new DmError('This message was tampered with.')
  } finally {
    sodium.memzero(messageKey)
  }

  const content = JSON.parse(new TextDecoder().decode(plaintext)) as Partial<DmContent> & { group?: unknown }
  if (typeof content.text !== 'string' || content.text.length > MAX_TEXT) throw new DmError('Unsupported message content.')
  const call = content.call && typeof content.call === 'object' && !Array.isArray(content.call) ? { call: content.call } : {}
  const group = content.group && typeof content.group === 'object' && !Array.isArray(content.group) ? { group: content.group as Record<string, unknown> } : {}
  const friend = content.friend && typeof content.friend === 'object' && !Array.isArray(content.friend) ? { friend: content.friend } : {}
  const forward = content.forward === undefined ? null : cleanForward(content.forward)
  const files = checkFiles(content.files)
  return { text: content.text, ...call, ...group, ...friend, ...(forward ? { forward } : {}), ...(files.length ? { files } : {}) }
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
