// End-to-end encrypted channels. See "End-to-end encrypted channels" in protocol/PROTOCOL.md.
//
// Built from the group DM pieces (core/group.ts, core/dm.ts), not new crypto:
// - Membership is a signed chain in the group-change format (its own context, up to 50 members, actions create / add /
//   remove / rekey). Any member adds or removes; the server also checks that adds and removes follow the channel's read
//   permission, but clients never take its word for who is in: they verify the chain.
// - Every change starts a new epoch with a fresh random 32-byte channel key. Whoever made the change wraps it for every
//   device of every member in DM envelopes v2 (forward secret through signed prekeys), bound to the chain id, version and
//   head. Receivers only accept an epoch key from the member who made that change.
// - Messages are XChaCha20-Poly1305 under the epoch key, the header bound as associated data, and signed by the
//   sender's device key (a shared key alone would let any member write as another). v2 also binds the channel, thread
//   and (for edits) the message, so a server can't move an envelope; v1 messages still open, marked as older.
// - Epoch keys are independent random keys: someone removed at version n never gets the key of version n or later.
import sodium from 'libsodium-wrappers-sumo'
import { b64u, fromB64u, randomBytes, sign, signedPayload, u64be, verify } from './crypto'
import type { SignedPrekey } from './devices'
import { DmError, openContent, revokedFor, sealContent, validDevices } from './dm'
import { checkFiles, type DmFile } from './dmFiles'
import {
  GroupBehindError, GroupError, isCount, parseSignedChange, resolveKey, sameKey,
  type ChangeBody, type GroupChange,
} from './group'
import { verifyDeviceCert, type DeviceCert, type Identity } from './identity'

export const CHANNEL_CHANGE_CONTEXT = 'iskra/channel-change/v1'
export const CHANNEL_MESSAGE_CONTEXT = 'iskra/channel-msg/v1'
/** Messages bound to their channel, thread and (for edits) message. Apps send only this one. */
export const CHANNEL_MESSAGE_CONTEXT_V2 = 'iskra/channel-msg/v2'
export const CHANNEL_KEY_CONTEXT = 'iskra/channel-key/v1'
export const MAX_CHANNEL_MEMBERS = 50
/** Key slots per key envelope, so each stays well under the server's 52 KB limit. */
export const SLOTS_PER_KEY_ENVELOPE = 150
const MAX_TEXT = 4000

export type ChannelAction = 'create' | 'add' | 'remove' | 'rekey'
const ACTIONS: readonly ChannelAction[] = ['create', 'add', 'remove', 'rekey']

export interface ChannelChange extends Omit<ChangeBody, 'action'> {
  action: ChannelAction
  head: string
}

/** An encrypted channel's membership as this device verified it. */
export interface ChannelView {
  chain: string
  version: number
  head: string
  /** In the order they joined the chain. */
  members: string[]
  changes: ChannelChange[]
}

export const newChainId = () => b64u(randomBytes(16))
export const newEpochKey = () => sodium.crypto_aead_xchacha20poly1305_ietf_keygen()

/** The member list a change must produce (null view: a new chain). Throws if the change breaks the rules. */
export function expectedChannelMembers(view: ChannelView | null, change: Pick<ChannelChange, 'action' | 'by' | 'targets' | 'version' | 'prev'>): string[] {
  const distinct = (keys: string[]) => new Set(keys).size === keys.length
  const c = { ...change, by: resolveKey(change.by), targets: change.targets.map(resolveKey) }
  const current = view?.members.map(resolveKey) ?? []
  let members: string[]
  if (c.action === 'create') {
    if (view) throw new GroupError('This channel’s encryption was set up twice.')
    if (c.version !== 1 || c.prev !== '' || !distinct([c.by, ...c.targets])) throw new GroupError('A new chain starts at version 1 with different people.')
    members = [c.by, ...c.targets]
  } else {
    if (!view) throw new GroupError("This channel's history doesn't start at its creation.")
    if (c.version !== view.version + 1 || c.prev !== view.head) throw new GroupError("This channel's history doesn't fit together.")
    if (!current.includes(c.by)) throw new GroupError('Someone outside the channel tried to change it.')
    if (c.action === 'add') {
      if (c.targets.length === 0 || !distinct(c.targets) || c.targets.some((t) => current.includes(t))) throw new GroupError('Add people who aren’t in the channel yet.')
      members = [...current, ...c.targets]
    } else if (c.action === 'remove') {
      if (c.targets.length === 0 || !distinct(c.targets) || c.targets.some((t) => !current.includes(t)) || c.targets.includes(c.by))
        throw new GroupError('Remove people who are in the channel.')
      members = current.filter((m) => !c.targets.includes(m))
    } else {
      if (c.targets.length !== 0) throw new GroupError('A new key names nobody.')
      members = current
    }
  }
  if (members.length > MAX_CHANNEL_MEMBERS) throw new GroupError(`At most ${MAX_CHANNEL_MEMBERS} people can be in an encrypted channel.`)
  return members
}

export function parseChannelChange(change: GroupChange): { body: Omit<ChannelChange, 'head'>; head: string } {
  const { body, head } = parseSignedChange(change, CHANNEL_CHANGE_CONTEXT, MAX_CHANNEL_MEMBERS, ACTIONS)
  return { body: body as Omit<ChannelChange, 'head'>, head }
}

/**
 * Verifies changes from creation, or continuing `base` (what this device verified before). A server can hold back the
 * newest changes, but never invent one (it would need a member's signature) or rewrite one we've seen.
 */
export function verifyChannelChain(chain: string, changes: GroupChange[], base: ChannelView | null = null): ChannelView {
  let view = base
  for (const change of changes) {
    const { body, head } = parseChannelChange(change)
    if (body.group !== chain) throw new GroupError('A change from another channel was mixed in.')
    const members = expectedChannelMembers(view, body)
    if (members.length !== body.members.length || members.some((m, i) => !sameKey(m, body.members[i])))
      throw new GroupError("A change's member list doesn't match what it did.")
    view = { chain, version: body.version, head, members, changes: [...(view?.changes ?? []), { ...body, head }] }
  }
  if (!view) throw new GroupError("This channel's history is missing.")
  return view
}

export function signChannelChange(identity: Identity, view: ChannelView | null, chain: string, action: ChannelAction, targets: string[], now = Date.now()): GroupChange {
  const by = b64u(identity.account.publicKey)
  const version = view ? view.version + 1 : 1
  const prev = view?.head ?? ''
  const members = expectedChannelMembers(view, { action, by, targets, version, prev })
  const body = { v: 1, group: chain, version, prev, by, action, targets, members, at: now }
  const bytes = new TextEncoder().encode(JSON.stringify(body))
  return { payload: b64u(bytes), sig: b64u(sign(signedPayload(CHANNEL_CHANGE_CONTEXT, bytes), identity.account.secretKey)) }
}

/** Who was in the channel at a version (null: this device never verified that version). */
export function membersAt(view: ChannelView, version: number): ChannelChange | null {
  const change = view.changes.find((c) => c.version === version)
  return change ?? null
}

// ── Epoch keys ───────────────────────────────────────────────────────────────

export interface ChannelKeyHeader {
  from: string
  chain: string
  version: number
  head: string
  sentAt: number
  id: string
}

export interface ChannelKeyEnvelope {
  v: 2
  kind: 'channel-key'
  header: ChannelKeyHeader
  sender: DeviceCert
  nonce: string
  ct: string
  keys: { device: string }[]
}

export interface MemberDevices {
  accountKey: string
  devices: DeviceCert[]
}

const keyAd = (h: ChannelKeyHeader) => new TextEncoder().encode(JSON.stringify([CHANNEL_KEY_CONTEXT, h.from, h.chain, h.version, h.head, h.sentAt, h.id]))

/**
 * Wraps a new epoch key for every valid, unrevoked device of every member of `view` (the verified chain, never a list
 * from the server), this device included. Several envelopes when there are many devices. Forward secret where devices
 * have prekeys. Throws if `view` isn't a change you made.
 */
export function sealEpochKey(
  identity: Identity, view: ChannelView, epochKey: Uint8Array, members: MemberDevices[], now = Date.now(),
  options: { prekeys?: SignedPrekey[]; revokedDevices?: Iterable<string> } = {},
): ChannelKeyEnvelope[] {
  const from = b64u(identity.account.publicKey)
  if (!sameKey(view.changes.at(-1)?.by ?? '', from)) throw new GroupError('Only whoever changed the channel hands out its new key.')
  const revoked = revokedFor(identity, options)
  const targets: DeviceCert[] = validDevices([identity.cert], from, revoked)
  for (const member of view.members) {
    const bundle = members.filter((b) => sameKey(b.accountKey, member))
    for (const d of validDevices(bundle.flatMap((b) => b.devices), bundle[0]?.accountKey ?? member, revoked))
      if (!targets.some((t) => t.deviceKey === d.deviceKey)) targets.push(d)
  }
  const envelopes: ChannelKeyEnvelope[] = []
  for (let i = 0; i < targets.length; i += SLOTS_PER_KEY_ENVELOPE) {
    const header: ChannelKeyHeader = { from, chain: view.chain, version: view.version, head: view.head, sentAt: now, id: b64u(randomBytes(12)) }
    const content = { text: '', group: { kind: 'channel-key', key: b64u(epochKey) } }
    const sealed = sealContent(identity, keyAd(header), targets.slice(i, i + SLOTS_PER_KEY_ENVELOPE), content, now, options.prekeys ?? [])
    envelopes.push({ v: 2, kind: 'channel-key', header, sender: identity.cert, ...sealed })
  }
  return envelopes
}

/**
 * Opens an epoch key. It must be for this chain, for a version this device verified (with that exact head), and from
 * the member who made that change (their device certificate checked). Returns the version and the key.
 */
export function openEpochKey(identity: Identity, envelope: ChannelKeyEnvelope, view: ChannelView): { version: number; key: Uint8Array } {
  if (!envelope || envelope.v !== 2 || envelope.kind !== 'channel-key' || !envelope.header || !envelope.sender || !Array.isArray(envelope.keys))
    throw new DmError('Unsupported key format.')
  const { header, sender } = envelope
  if (header.chain !== view.chain) throw new DmError('This key belongs to another channel.')
  if (!isCount(header.version) || !isCount(header.sentAt) || typeof header.id !== 'string') throw new DmError('Unsupported key format.')
  if (header.version > view.version) throw new GroupBehindError('This key is for a newer version of the channel.')
  const change = membersAt(view, header.version)
  if (!change || change.head !== header.head) throw new DmError('This key is for a member list this channel never had.')
  if (!sameKey(change.by, header.from)) throw new DmError('This key wasn’t sent by whoever changed the channel.')
  if (!sameKey(sender.accountKey, header.from) || !verifyDeviceCert(sender)) throw new DmError("The sender's device couldn't be verified.")
  const content = openContent(identity, { ...envelope, keys: envelope.keys as never }, keyAd(header))
  const g = content.group as { kind?: unknown; key?: unknown } | undefined
  if (g?.kind !== 'channel-key' || typeof g.key !== 'string') throw new DmError('Unsupported key format.')
  const key = fromB64u(g.key)
  if (key.length !== sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES) throw new DmError('Unsupported key format.')
  return { version: header.version, key }
}

/** The devices a key envelope has a slot for. */
export const slotDevices = (envelopes: ChannelKeyEnvelope[]) => new Set(envelopes.flatMap((e) => e.keys.map((k) => k.device)))

// ── Messages ────────────────────────────────────────────────────────────────

/**
 * Where a message was sent (v2 binds it): the encrypted channel, and the thread inside it if any. A server that moves
 * an envelope to another channel or thread, or between a message and its edit, is caught.
 */
export interface ChannelPlace {
  channel: number
  thread?: number
}

export interface ChannelHeader {
  from: string
  chain: string
  version: number
  sentAt: number
  id: string
  /** v2: the encrypted channel's id (a thread's parent). */
  channel?: number
  /** v2: the thread's id, when sent in a thread. */
  thread?: number
  /** v2: an edit names the `id` of the message's first envelope. */
  edit?: string
}

export interface ChannelEnvelope {
  /** 1: the older format (not bound to a channel); apps only send 2. */
  v: 1 | 2
  kind: 'channel'
  header: ChannelHeader
  sender: DeviceCert
  nonce: string
  ct: string
  sig: string
}

export interface ChannelContent {
  text: string
  /** End-to-end encrypted attachments (core/dmFiles.ts); `text` may then be empty. */
  files?: DmFile[]
}

/** What decrypting tells about a message besides its content. */
export interface ChannelMessageInfo {
  header: ChannelHeader
  /** Sent in the older format: not bound to its channel, thread or message (shown with a note). */
  legacy: boolean
  /**
   * When the sender lost access (a later change in the verified chain that left them out, or the end of the chain), if
   * the message claims a later time, by its own signed `sentAt` or the server's `createdAt`: not shown as authentic.
   */
  afterRemoval?: number
}

/** How far the signed times of different people's clocks may be apart (the server refuses changes further off). */
export const CLOCK_SKEW_MS = 10 * 60_000

/** A v2 message arrived somewhere other than where it was sent (another channel or thread). */
export const MOVED = 'This message was moved here from somewhere else.'

const isId = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0
const MAX_HEADER_ID = 32

/** The associated data of a message (the head of its version comes from the verified chain, never the envelope). */
export function channelMessageAd(v: 1 | 2, h: ChannelHeader, head: string): Uint8Array {
  const fields = v === 1
    ? [CHANNEL_MESSAGE_CONTEXT, h.from, h.chain, h.version, head, h.sentAt, h.id]
    : [CHANNEL_MESSAGE_CONTEXT_V2, h.from, h.chain, h.version, head, h.sentAt, h.id, h.channel, h.thread ?? 0, h.edit ?? '']
  return new TextEncoder().encode(JSON.stringify(fields))
}

/** What the sender's device signs: the associated data, nonce and ciphertext, each length-prefixed, under the format's context. */
export function channelMessageSigned(v: 1 | 2, ad: Uint8Array, nonce: Uint8Array, ct: Uint8Array): Uint8Array {
  return signedPayload(v === 1 ? CHANNEL_MESSAGE_CONTEXT : CHANNEL_MESSAGE_CONTEXT_V2, u64be(ad.length), ad, u64be(nonce.length), nonce, ct)
}

/** Encrypts a message (always v2) for `place`; `edit` is the first envelope's `id` when it replaces a message's text. */
export function encryptChannelMessage(
  identity: Identity, view: ChannelView, epochKey: Uint8Array, content: ChannelContent, place: ChannelPlace, now = Date.now(), edit?: string,
): ChannelEnvelope {
  const from = b64u(identity.account.publicKey)
  if (!view.members.some((m) => sameKey(m, from))) throw new GroupError("You're not in this channel's encryption.")
  const hasFiles = (content.files?.length ?? 0) > 0
  if ((content.text.length === 0 && !hasFiles) || content.text.length > MAX_TEXT) throw new DmError(`Messages must be 1–${MAX_TEXT} characters.`)
  if (!isId(place.channel) || (place.thread !== undefined && (!isId(place.thread) || place.thread === place.channel))) throw new DmError('Unsupported message format.')
  if (edit !== undefined && (typeof edit !== 'string' || edit.length === 0 || edit.length > MAX_HEADER_ID)) throw new DmError('Unsupported message format.')
  const header: ChannelHeader = {
    from, chain: view.chain, version: view.version, sentAt: now, id: b64u(randomBytes(12)),
    channel: place.channel, ...(place.thread !== undefined ? { thread: place.thread } : {}), ...(edit !== undefined ? { edit } : {}),
  }
  const ad = channelMessageAd(2, header, view.head)
  const nonce = randomBytes(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
  const plain = new TextEncoder().encode(JSON.stringify({ text: content.text, ...(hasFiles ? { files: content.files } : {}) }))
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plain, ad, null, nonce, epochKey)
  const sig = sign(channelMessageSigned(2, ad, nonce, ct), identity.device.secretKey)
  return { v: 2, kind: 'channel', header, sender: identity.cert, nonce: b64u(nonce), ct: b64u(ct), sig: b64u(sig) }
}

/**
 * When `from` lost access after `version` in the verified chain: the `at` of the first later change that leaves them out
 * (signed by the member who made it; the server refuses changes more than 10 minutes off its clock), or `endedAt` (when
 * this device saw the chain replaced) if that comes first. Null while they're still in.
 */
export function accessEnd(view: Pick<ChannelView, 'changes'>, from: string, version: number, endedAt?: number): number | null {
  const out = view.changes.find((c) => c.version > version && !c.members.some((m) => sameKey(m, from)))
  const ends = [out?.at, endedAt].filter((t): t is number => typeof t === 'number' && Number.isFinite(t))
  return ends.length ? Math.min(...ends) : null
}

/** Where the server delivered a message: its author and version, the channel and thread it's in, and its `createdAt`. */
export interface ChannelRouting {
  from: string
  version: number
  channel: number
  thread?: number
  at?: number
}

/**
 * Decrypts a channel message. `routed` is what the server says; it must match the header. The version must be one this
 * device verified, the sender a member then, the signature by a device certified for them, and `keyFor(version)` the
 * epoch key this device received for it. A v2 message must have been sent to exactly `routed.channel` and
 * `routed.thread`. `endedAt`: when this device saw the chain replaced (a kept old chain).
 */
export function decryptChannelMessage(
  envelope: ChannelEnvelope, routed: ChannelRouting, view: ChannelView, keyFor: (version: number) => Uint8Array | undefined, endedAt?: number,
): ChannelContent & ChannelMessageInfo {
  if (!envelope || (envelope.v !== 1 && envelope.v !== 2) || envelope.kind !== 'channel' || !envelope.header || !envelope.sender
    || typeof envelope.nonce !== 'string' || typeof envelope.ct !== 'string' || typeof envelope.sig !== 'string')
    throw new DmError('Unsupported message format.')
  const { header, sender, v } = envelope
  if (header.chain !== view.chain) throw new DmError('This message belongs to another channel.')
  if (!isCount(header.version) || !isCount(header.sentAt) || typeof header.id !== 'string' || header.id.length > MAX_HEADER_ID) throw new DmError('Unsupported message format.')
  if (v === 2) {
    if (!isId(header.channel) || (header.thread !== undefined && !isId(header.thread))
      || (header.edit !== undefined && (typeof header.edit !== 'string' || header.edit.length === 0 || header.edit.length > MAX_HEADER_ID)))
      throw new DmError('Unsupported message format.')
    if (header.channel !== routed.channel || (header.thread ?? 0) !== (routed.thread ?? 0)) throw new DmError(MOVED)
  }
  if (!sameKey(header.from, routed.from) || header.version !== routed.version) throw new DmError("This message's sender or version doesn't match.")
  if (header.version > view.version) throw new GroupBehindError('This message is for a newer version of the channel.')
  const at = membersAt(view, header.version)
  if (!at) throw new DmError('This message was sent before you could read this channel.')
  if (!at.members.some((m) => sameKey(m, header.from))) throw new DmError("This message is from someone who wasn't in the channel.")
  if (!sameKey(sender.accountKey, header.from) || !verifyDeviceCert(sender)) throw new DmError("The sender's device couldn't be verified.")
  const ad = channelMessageAd(v, header, at.head)
  let nonce: Uint8Array
  let ct: Uint8Array
  try {
    nonce = fromB64u(envelope.nonce)
    ct = fromB64u(envelope.ct)
  } catch {
    throw new DmError('Unsupported message format.')
  }
  let signed = false
  try {
    signed = verify(fromB64u(envelope.sig), channelMessageSigned(v, ad, nonce, ct), fromB64u(sender.deviceKey))
  } catch {
    signed = false
  }
  if (!signed) throw new DmError('This message was tampered with.')
  const key = keyFor(header.version)
  if (!key) throw new MissingKeyError("This device doesn't have the key for this message.")
  let plain: Uint8Array
  try {
    plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, ad, nonce, key)
  } catch {
    throw new DmError('This message was tampered with.')
  }
  const content = JSON.parse(new TextDecoder().decode(plain)) as Partial<ChannelContent>
  if (typeof content.text !== 'string' || content.text.length > MAX_TEXT) throw new DmError('Unsupported message content.')
  const files = checkFiles(content.files)
  // A removed member still holds the keys of the epochs they were in: a message claiming a time after they lost access
  // isn't shown as theirs. Both clocks count (theirs, signed, and the server's); together the two could still backdate.
  const end = accessEnd(view, header.from, header.version, endedAt)
  const late = end !== null && Math.max(header.sentAt, routed.at ?? 0) > end + CLOCK_SKEW_MS
  return { text: content.text, ...(files.length ? { files } : {}), header, legacy: v === 1, ...(late ? { afterRemoval: end } : {}) }
}

/** The message is fine, but this device didn't (yet) get the key of its epoch. */
export class MissingKeyError extends DmError {}

// ── Voice ───────────────────────────────────────────────────────────────────

/** The LiveKit end-to-end encryption key of an epoch (a libsodium KDF subkey, so it never equals the message key). */
export function voiceKey(epochKey: Uint8Array): Uint8Array {
  return sodium.crypto_kdf_derive_from_key(32, 1, 'iskra-vc', epochKey)
}

/** LiveKit keeps 16 key slots: an epoch's voice key goes in slot version mod 16. */
export const voiceKeyIndex = (version: number) => version % 16
