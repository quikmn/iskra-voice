// Encrypted photos channels: one envelope per photo (its file keys, name, size, date and caption) and per album (its
// name), sealed with the channel's epoch key and signed by the sender's device, like board envelopes
// (core/boardCrypto.ts). See "Encrypted photos channels" in protocol/PROTOCOL.md.
import sodium from 'libsodium-wrappers-sumo'
import { b64u, fromB64u, randomBytes, sign, signedPayload, u64be, verify } from './crypto'
import { membersAt, type ChannelView } from './channelChain'
import { DmError } from './dm'
import { checkFiles, type DmFile } from './dmFiles'
import { GroupBehindError, GroupError, isCount, sameKey } from './group'
import { verifyDeviceCert, type DeviceCert, type Identity } from './identity'

export const PHOTO_CONTEXT = 'iskra/photo/v1'
export const MAX_CAPTION = 500
export const MAX_ALBUM_NAME = 80

export type PhotoWhat = 'photo' | 'album'

export interface PhotoHeader {
  from: string
  chain: string
  version: number
  sentAt: number
  id: string
  channel: number
  what: PhotoWhat
}

export interface PhotoEnvelope {
  v: 1
  kind: 'photo'
  header: PhotoHeader
  sender: DeviceCert
  nonce: string
  ct: string
  sig: string
}

/** What a photo's envelope holds: everything the server doesn't need to store the ciphertext. */
export interface SealedPhoto {
  file: DmFile
  thumb?: DmFile
  kind: 'image' | 'video'
  name: string
  width: number
  height: number
  /** Videos: milliseconds. */
  duration?: number
  takenAt?: number
  caption: string
}

export interface SealedAlbum {
  name: string
}

function photoAd(h: PhotoHeader, head: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([PHOTO_CONTEXT, h.from, h.chain, h.version, head, h.sentAt, h.id, h.channel, h.what]))
}

const signed = (ad: Uint8Array, nonce: Uint8Array, ct: Uint8Array) => signedPayload(PHOTO_CONTEXT, u64be(ad.length), ad, u64be(nonce.length), nonce, ct)

/** Seals a photo or an album name for the channel under the current epoch of `view`. */
export function sealPhoto(identity: Identity, view: ChannelView, epochKey: Uint8Array, channel: number, what: PhotoWhat, content: SealedPhoto | SealedAlbum, now = Date.now()): PhotoEnvelope {
  const from = b64u(identity.account.publicKey)
  if (!view.members.some((m) => sameKey(m, from))) throw new GroupError("You're not in this channel's encryption.")
  const header: PhotoHeader = { from, chain: view.chain, version: view.version, sentAt: now, id: b64u(randomBytes(12)), channel, what }
  const ad = photoAd(header, view.head)
  const nonce = randomBytes(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(new TextEncoder().encode(JSON.stringify(content)), ad, null, nonce, epochKey)
  return { v: 1, kind: 'photo', header, sender: identity.cert, nonce: b64u(nonce), ct: b64u(ct), sig: b64u(sign(signed(ad, nonce, ct), identity.device.secretKey)) }
}

/**
 * Opens an envelope: the chain, version (one this device verified), sender (a member then), device certificate and
 * signature, and that it was sealed for this channel and purpose. `from`: who must have sealed it (a photo's uploader,
 * as the server names them); null accepts any member (album names, which any member may set).
 */
function open(envelope: PhotoEnvelope, from: string | null, channel: number, what: PhotoWhat, view: ChannelView, keyFor: (version: number) => Uint8Array | undefined): unknown {
  if (!envelope || envelope.v !== 1 || envelope.kind !== 'photo' || !envelope.header || !envelope.sender
    || typeof envelope.nonce !== 'string' || typeof envelope.ct !== 'string' || typeof envelope.sig !== 'string')
    throw new DmError('Unsupported photo format.')
  const h = envelope.header
  if (h.chain !== view.chain) throw new DmError('This belongs to another channel.')
  if (!isCount(h.version) || !isCount(h.sentAt) || typeof h.id !== 'string' || h.id.length > 32 || typeof h.from !== 'string') throw new DmError('Unsupported photo format.')
  if (h.channel !== channel || h.what !== what) throw new DmError('This was moved here from somewhere else.')
  if (from !== null && !sameKey(h.from, from)) throw new DmError("The sender doesn't match.")
  if (h.version > view.version) throw new GroupBehindError('This is for a newer version of the channel.')
  const at = membersAt(view, h.version)
  if (!at || !at.members.some((m) => sameKey(m, h.from))) throw new DmError("This is from someone who wasn't in the channel.")
  if (!sameKey(envelope.sender.accountKey, h.from) || !verifyDeviceCert(envelope.sender)) throw new DmError("The sender's device couldn't be verified.")
  const ad = photoAd(h, at.head)
  let nonce: Uint8Array
  let ct: Uint8Array
  let ok = false
  try {
    nonce = fromB64u(envelope.nonce)
    ct = fromB64u(envelope.ct)
    ok = verify(fromB64u(envelope.sig), signed(ad, nonce, ct), fromB64u(envelope.sender.deviceKey))
  } catch {
    ok = false
  }
  if (!ok) throw new DmError('This was tampered with.')
  const key = keyFor(h.version)
  if (!key) throw new MissingPhotoKey()
  try {
    return JSON.parse(new TextDecoder().decode(sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct!, ad, nonce!, key)))
  } catch {
    throw new DmError('This was tampered with.')
  }
}

/** This device has no key for the envelope's version: it was sealed before you could read the channel, or the key is on its way. */
export class MissingPhotoKey extends DmError {
  constructor() {
    super("This device doesn't have the key for this.")
  }
}

const size = (v: unknown, max: number) => (Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max ? (v as number) : 0)

/** Opens a photo's envelope and checks its content field by field. `uploader` is who the server says added it. */
export function openPhoto(envelope: PhotoEnvelope, uploader: string, channel: number, view: ChannelView, keyFor: (version: number) => Uint8Array | undefined): SealedPhoto {
  const raw = open(envelope, uploader, channel, 'photo', view, keyFor) as Partial<SealedPhoto> | null
  if (!raw || typeof raw !== 'object') throw new DmError('Unsupported photo format.')
  const [file] = checkFiles([raw.file])
  const thumb = raw.thumb === undefined ? undefined : checkFiles([raw.thumb])[0]
  if (raw.kind !== 'image' && raw.kind !== 'video') throw new DmError('Unsupported photo format.')
  const caption = typeof raw.caption === 'string' ? raw.caption.slice(0, MAX_CAPTION) : ''
  const duration = size(raw.duration, 24 * 3600 * 1000)
  const takenAt = size(raw.takenAt, 8.64e15)
  return {
    file, ...(thumb ? { thumb } : {}), kind: raw.kind, name: file.name, width: size(raw.width, 100_000), height: size(raw.height, 100_000),
    ...(raw.kind === 'video' && duration ? { duration } : {}), ...(takenAt ? { takenAt } : {}), caption,
  }
}

/** Opens an album's envelope (sealed by any member of the channel at the time). */
export function openAlbum(envelope: PhotoEnvelope, channel: number, view: ChannelView, keyFor: (version: number) => Uint8Array | undefined): SealedAlbum {
  const raw = open(envelope, null, channel, 'album', view, keyFor) as Partial<SealedAlbum> | null
  if (!raw || typeof raw.name !== 'string' || !raw.name.trim()) throw new DmError('Unsupported photo format.')
  return { name: raw.name.trim().slice(0, MAX_ALBUM_NAME) }
}
