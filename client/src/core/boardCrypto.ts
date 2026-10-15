// Encrypted whiteboards: batches, snapshots and live cursors sealed with an encrypted channel's epoch key and signed by
// the sender's device, like channel messages (core/channelChain.ts). See "Encrypted boards" in protocol/PROTOCOL.md.
import sodium from 'libsodium-wrappers-sumo'
import { b64u, fromB64u, randomBytes, sign, signedPayload, u64be, verify } from './crypto'
import { membersAt, type ChannelView } from './channelChain'
import { DmError } from './dm'
import { GroupBehindError, GroupError, isCount, sameKey } from './group'
import { verifyDeviceCert, type DeviceCert, type Identity } from './identity'

export const BOARD_CONTEXT = 'iskra/wb/v1'

export type BoardWhat = 'ops' | 'snapshot' | 'live'

export interface BoardHeader {
  from: string
  chain: string
  version: number
  sentAt: number
  id: string
  channel: number
  board: string
  what: BoardWhat
  /** Snapshots: the batch they cover up to. */
  seq?: number
}

export interface BoardEnvelope {
  v: 1
  kind: 'wb'
  header: BoardHeader
  sender: DeviceCert
  nonce: string
  ct: string
  sig: string
}

/** Where an envelope must have been sent: the channel and the board (a cleared board has a new id). */
export interface BoardPlace {
  channel: number
  board: string
}

function boardAd(h: BoardHeader, head: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([BOARD_CONTEXT, h.from, h.chain, h.version, head, h.sentAt, h.id, h.channel, h.board, h.what, h.seq ?? 0]))
}

const signed = (ad: Uint8Array, nonce: Uint8Array, ct: Uint8Array) => signedPayload(BOARD_CONTEXT, u64be(ad.length), ad, u64be(nonce.length), nonce, ct)

/** Seals `content` for the board under the current epoch of `view`. */
export function sealBoard(identity: Identity, view: ChannelView, epochKey: Uint8Array, place: BoardPlace, what: BoardWhat, content: unknown, seq?: number, now = Date.now()): BoardEnvelope {
  const from = b64u(identity.account.publicKey)
  if (!view.members.some((m) => sameKey(m, from))) throw new GroupError("You're not in this channel's encryption.")
  const header: BoardHeader = {
    from, chain: view.chain, version: view.version, sentAt: now, id: b64u(randomBytes(12)), channel: place.channel, board: place.board, what,
    ...(seq !== undefined ? { seq } : {}),
  }
  const ad = boardAd(header, view.head)
  const nonce = randomBytes(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(new TextEncoder().encode(JSON.stringify(content)), ad, null, nonce, epochKey)
  return { v: 1, kind: 'wb', header, sender: identity.cert, nonce: b64u(nonce), ct: b64u(ct), sig: b64u(sign(signed(ad, nonce, ct), identity.device.secretKey)) }
}

/**
 * Opens a board envelope: the chain, version (one this device verified), sender (a member then), device certificate and
 * signature, and that it was sent to this channel, board and purpose. `from` is who the server says sent it.
 */
export function openBoard(envelope: BoardEnvelope, from: string, place: BoardPlace, what: BoardWhat, view: ChannelView, keyFor: (version: number) => Uint8Array | undefined): { content: unknown; header: BoardHeader } {
  if (!envelope || envelope.v !== 1 || envelope.kind !== 'wb' || !envelope.header || !envelope.sender
    || typeof envelope.nonce !== 'string' || typeof envelope.ct !== 'string' || typeof envelope.sig !== 'string')
    throw new DmError('Unsupported board format.')
  const h = envelope.header
  if (h.chain !== view.chain) throw new DmError('This belongs to another channel.')
  if (!isCount(h.version) || !isCount(h.sentAt) || typeof h.id !== 'string' || h.id.length > 32) throw new DmError('Unsupported board format.')
  if (h.channel !== place.channel || h.board !== place.board || h.what !== what) throw new DmError('This was moved here from somewhere else.')
  if (!sameKey(h.from, from)) throw new DmError("The sender doesn't match.")
  if (h.version > view.version) throw new GroupBehindError('This is for a newer version of the channel.')
  const at = membersAt(view, h.version)
  if (!at || !at.members.some((m) => sameKey(m, h.from))) throw new DmError("This is from someone who wasn't in the channel.")
  if (!sameKey(envelope.sender.accountKey, h.from) || !verifyDeviceCert(envelope.sender)) throw new DmError("The sender's device couldn't be verified.")
  const ad = boardAd(h, at.head)
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
  if (!key) throw new DmError("This device doesn't have the key for this.")
  let plain: Uint8Array
  try {
    plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct!, ad, nonce!, key)
  } catch {
    throw new DmError('This was tampered with.')
  }
  return { content: JSON.parse(new TextDecoder().decode(plain)), header: h }
}
