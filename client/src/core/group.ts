// End-to-end encrypted group DMs. See "Group DMs" in protocol/PROTOCOL.md.
//
// - Membership is a chain of changes. Each one is signed by the account of the member who made it, names the change
//   before it by hash, and lists every member after it. Anyone in the group adds people and can leave; the
//   longest-standing member (the first in the list: the creator, until they leave) removes people. The server checks
//   the same rules, but clients never take its word: they verify the whole chain, so a server can't add anyone.
// - Messages reuse the DM envelope v2 (one XChaCha20-Poly1305 ciphertext, the key wrapped per device, to signed prekeys
//   where possible). The associated data binds the group id and the exact chain head (version + hash) the sender
//   encrypted for, so a message can't be moved to another group or replayed as if sent to a different member list.
// - Senders encrypt only to the member list of the chain they verified, never to a list the server hands them.
import sodium from 'libsodium-wrappers-sumo'
import { b64u, fromB64u, randomBytes, sign, signedPayload, verify } from './crypto'
import type { SignedPrekey } from './devices'
import { checkText, DmError, openContent, revokedFor, sealContent, validDevices, type DmContent, type DmEnvelope, type EncryptOptions } from './dm'
import { verifyDeviceCert, type DeviceCert, type Identity } from './identity'

export const GROUP_CHANGE_CONTEXT = 'iskra/group-change/v1'
export const MAX_GROUP_MEMBERS = 10
export const MIN_GROUP_MEMBERS = 3
export const MAX_GROUP_NAME = 64
/** Same as the server: a change's time may be off by this much. */
export const MAX_CHANGE_SKEW_MS = 10 * 60_000

export type GroupAction = 'create' | 'add' | 'remove' | 'leave'

/** A change as it travels: the exact payload bytes (base64url JSON) and the author's signature over them. */
export interface GroupChange {
  payload: string
  sig: string
}

export interface ChangeBody {
  v: 1
  group: string
  version: number
  /** The previous change's head ("" for the first). */
  prev: string
  by: string
  action: GroupAction
  targets: string[]
  members: string[]
  at: number
}

export interface VerifiedChange extends ChangeBody {
  head: string
}

/** A group as this device verified it. */
export interface GroupView {
  id: string
  version: number
  head: string
  /** In join order; the first one is the owner. */
  members: string[]
  changes: VerifiedChange[]
}

export class GroupError extends Error {}

/** The envelope hasn't caught up: it's for a version this device hasn't verified yet. Fetch the chain and try again. */
export class GroupBehindError extends GroupError {}

const ID = /^[A-Za-z0-9_-]{22}$/
const KEY = /^[A-Za-z0-9_-]{43}$/
const ACTIONS: GroupAction[] = ['create', 'add', 'remove', 'leave']

export const newGroupId = () => b64u(randomBytes(16))
export const ownerOf = (view: Pick<GroupView, 'members'>) => view.members[0]

/** The head of a change: SHA-256 of its exact payload bytes. */
export const headOf = (payload: Uint8Array) => b64u(sodium.crypto_hash_sha256(payload))

const isKeyList = (x: unknown, max: number): x is string[] => Array.isArray(x) && x.length <= max && x.every((k) => typeof k === 'string' && KEY.test(k))
export const isCount = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0

/** Decodes a change and checks its format and signature (by its own `by`). */
export function parseChange(change: GroupChange): { body: ChangeBody; head: string } {
  return parseSignedChange(change, GROUP_CHANGE_CONTEXT, MAX_GROUP_MEMBERS, ACTIONS) as { body: ChangeBody; head: string }
}

/** The same signed-change format for other chains (encrypted channels), with their own context, size and actions. */
export function parseSignedChange(change: GroupChange, context: string, maxMembers: number, actions: readonly string[]): { body: Omit<ChangeBody, 'action'> & { action: string }; head: string } {
  let bytes: Uint8Array
  let body: Partial<ChangeBody>
  try {
    bytes = fromB64u(change.payload)
    body = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new GroupError("A change to this group couldn't be read.")
  }
  if (!body || body.v !== 1 || typeof body.group !== 'string' || !ID.test(body.group) || !isCount(body.version) || typeof body.prev !== 'string'
    || typeof body.by !== 'string' || !KEY.test(body.by) || !actions.includes(body.action as string) || !isKeyList(body.targets, maxMembers)
    || !isKeyList(body.members, maxMembers) || !isCount(body.at))
    throw new GroupError("A change to this group isn't valid.")
  let signed = false
  try {
    signed = verify(fromB64u(change.sig), signedPayload(context, bytes), fromB64u(body.by))
  } catch {
    signed = false
  }
  if (!signed) throw new GroupError("A change to this group wasn't signed by the person it claims.")
  return { body: body as ChangeBody, head: headOf(bytes) }
}

// ── Account key rotations ───────────────────────────────────────────────────
// Someone who replaced their account key (a verified rotation) is the same member under their new key. Changes stay
// signed by whichever key made them; member lists are compared under everyone's current key.

let currentKey: (accountKey: string) => string = (k) => k

/** Set by the app (state/keyMap.ts): maps an earlier account key to the current one, from verified rotations. */
export function setGroupKeyResolver(resolve: (accountKey: string) => string): void {
  currentKey = resolve
}

export const sameKey = (a: string, b: string) => a === b || currentKey(a) === currentKey(b)

/** An account key as the member it is now (after verified rotations). */
export const resolveKey = (accountKey: string) => currentKey(accountKey)

/** The member list a change must produce (null view: a new group). Throws if the change breaks the rules. */
export function expectedMembers(view: GroupView | null, change: Pick<ChangeBody, 'action' | 'by' | 'targets' | 'version' | 'prev'>): string[] {
  const distinct = (keys: string[]) => new Set(keys).size === keys.length
  const c = { ...change, by: currentKey(change.by), targets: change.targets.map(currentKey) }
  if (view) view = { ...view, members: view.members.map(currentKey) }
  let members: string[]
  if (c.action === 'create') {
    if (view) throw new GroupError('This group was created twice.')
    if (c.version !== 1 || c.prev !== '') throw new GroupError('A new group starts at version 1.')
    if (c.targets.length + 1 < MIN_GROUP_MEMBERS || !distinct([c.by, ...c.targets]))
      throw new GroupError(`A group needs ${MIN_GROUP_MEMBERS}–${MAX_GROUP_MEMBERS} different people.`)
    members = [c.by, ...c.targets]
  } else {
    if (!view) throw new GroupError("This group's history doesn't start at its creation.")
    if (c.version !== view.version + 1 || c.prev !== view.head) throw new GroupError("This group's history doesn't fit together.")
    if (!view.members.includes(c.by)) throw new GroupError('Someone outside the group tried to change it.')
    if (c.action === 'add') {
      if (c.targets.length === 0 || !distinct(c.targets) || c.targets.some((t) => view.members.includes(t)))
        throw new GroupError('Add people who aren’t in the group yet.')
      members = [...view.members, ...c.targets]
    } else {
      const [target] = c.targets
      if (c.targets.length !== 1 || !view.members.includes(target)) throw new GroupError('Name one person in the group.')
      if (c.action === 'leave' && target !== c.by) throw new GroupError('People can only leave for themselves.')
      if (c.action === 'remove' && (target === c.by || ownerOf(view) !== c.by)) throw new GroupError('Only the group’s owner can remove people.')
      members = view.members.filter((m) => m !== target)
    }
  }
  if (members.length > MAX_GROUP_MEMBERS) throw new GroupError(`A group can have at most ${MAX_GROUP_MEMBERS} people.`)
  return members
}

/** Applies one verified change. */
function apply(view: GroupView | null, change: GroupChange, groupId: string): GroupView {
  const { body, head } = parseChange(change)
  if (body.group !== groupId) throw new GroupError('A change from another group was mixed in.')
  const members = expectedMembers(view, body)
  if (members.length !== body.members.length || members.some((m, i) => !sameKey(m, body.members[i])))
    throw new GroupError("A change's member list doesn't match what it did.")
  return { id: groupId, version: body.version, head, members, changes: [...(view?.changes ?? []), { ...body, head }] }
}

/**
 * Verifies a chain of changes, from creation or continuing `base` (what this device verified before).
 * A server can leave out the newest changes, but never invent one or rewrite one we've seen.
 */
export function verifyChain(groupId: string, changes: GroupChange[], base: GroupView | null = null): GroupView {
  if (!ID.test(groupId)) throw new GroupError('Not a group.')
  let view = base
  for (const change of changes) view = apply(view, change, groupId)
  if (!view) throw new GroupError("This group's history is missing.")
  return view
}

/** Builds and signs the next change (or the first, with a null view). */
export function signChange(identity: Identity, view: GroupView | null, groupId: string, action: GroupAction, targets: string[], now = Date.now()): GroupChange {
  const by = b64u(identity.account.publicKey)
  const version = view ? view.version + 1 : 1
  const prev = view?.head ?? ''
  const members = expectedMembers(view, { action, by, targets, version, prev })
  const body: ChangeBody = { v: 1, group: groupId, version, prev, by, action, targets, members, at: now }
  const bytes = new TextEncoder().encode(JSON.stringify(body))
  return { payload: b64u(bytes), sig: b64u(sign(signedPayload(GROUP_CHANGE_CONTEXT, bytes), identity.account.secretKey)) }
}

// ── Messages ────────────────────────────────────────────────────────────────

export interface GroupHeader {
  from: string
  group: string
  version: number
  head: string
  sentAt: number
  id: string
}

export interface GroupEnvelope extends Omit<DmEnvelope, 'header' | 'v'> {
  v: 2
  kind: 'group'
  header: GroupHeader
}

/** One member's devices as a server published them (`dm.devices`). */
export interface MemberBundle {
  accountKey: string
  devices: DeviceCert[]
}

function groupAd(h: GroupHeader): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(['iskra/group-dm/v1', h.from, h.group, h.version, h.head, h.sentAt, h.id]))
}

/**
 * Encrypts for every device of every member of `view` (your own included), forward secret where devices have prekeys.
 * Members without devices we can encrypt to (e.g. no longer on the server) are skipped: they couldn't read it anyway.
 */
export function encryptGroup(
  identity: Identity, view: GroupView, bundles: MemberBundle[], content: DmContent, now = Date.now(),
  options: EncryptOptions & { prekeys: SignedPrekey[] } = { prekeys: [] },
): GroupEnvelope {
  const from = b64u(identity.account.publicKey)
  if (!view.members.some((m) => sameKey(m, from))) throw new GroupError("You're not in this group any more.")
  checkText(content)
  const revoked = revokedFor(identity, options)
  const targets: DeviceCert[] = validDevices([identity.cert], from, revoked)
  for (const member of view.members) {
    // Only the members of the verified chain, whatever else the bundles hold.
    const bundle = bundles.filter((b) => sameKey(b.accountKey, member))
    const devices = bundle.flatMap((b) => b.devices)
    for (const d of validDevices(devices, bundle[0]?.accountKey ?? member, revoked)) if (!targets.some((t) => t.deviceKey === d.deviceKey)) targets.push(d)
  }
  if (!targets.some((t) => t.accountKey !== from)) throw new DmError("Nobody else in this group has a device we can encrypt to yet.")
  const header: GroupHeader = { from, group: view.id, version: view.version, head: view.head, sentAt: now, id: b64u(randomBytes(12)) }
  return { v: 2, kind: 'group', header, sender: identity.cert, ...sealContent(identity, groupAd(header), targets, content, now, options.prekeys) }
}

/**
 * Decrypts a group envelope. `routed` is what the server says about it (group, sender, version); it must match the
 * encrypted header, the header must name a change in the chain this device verified, and the sender must have been a
 * member at that version.
 */
export function decryptGroup(
  identity: Identity, envelope: GroupEnvelope, routed: { group: string; from: string; version: number }, view: GroupView,
): DmContent & { header: GroupHeader } {
  if (!envelope || envelope.v !== 2 || envelope.kind !== 'group' || !envelope.header || !envelope.sender || !Array.isArray(envelope.keys))
    throw new DmError('Unsupported message format.')
  const { header, sender } = envelope
  if (header.group !== routed.group || header.group !== view.id) throw new DmError('This message belongs to another conversation.')
  if (header.from !== routed.from || header.version !== routed.version) throw new DmError("This message's sender or version doesn't match.")
  if (!isCount(header.version) || !isCount(header.sentAt) || typeof header.id !== 'string') throw new DmError('Unsupported message format.')
  if (header.version > view.version) throw new GroupBehindError('This message is for a newer version of the group.')
  const at = view.changes.find((c) => c.version === header.version)
  if (!at || at.head !== header.head) throw new DmError("This message was sent to a member list this group never had.")
  if (!at.members.some((m) => sameKey(m, header.from))) throw new DmError("This message is from someone who wasn't in the group.")
  if (sender.accountKey !== header.from || !verifyDeviceCert(sender)) throw new DmError("The sender's device couldn't be verified.")
  return { ...openContent(identity, { ...envelope, v: 2 }, groupAd(header)), header }
}

/** A rename inside a group message, or null if it isn't a well-formed one. "" clears the name. */
export function asRename(group: unknown): { kind: 'rename'; name: string } | null {
  if (!group || typeof group !== 'object') return null
  const g = group as { kind?: unknown; name?: unknown }
  if (g.kind !== 'rename' || typeof g.name !== 'string' || g.name.length > MAX_GROUP_NAME) return null
  return { kind: 'rename', name: g.name.trim() }
}
