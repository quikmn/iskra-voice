// Key transparency: checking a server's signed key log, comparing what different servers and friends see, and
// gossiping signed digests inside end-to-end encrypted DMs. See "Key transparency" in protocol/PROTOCOL.md.
//
// It doesn't make a lying server impossible; it makes lying noticeable. A server that shows one person a different
// key (or a different history) than everyone else has to fork its signed log, and any two people who compare heads,
// directly or through a friend's DM, catch the fork. Pure logic only: no storage, no sockets.
import sodium from 'libsodium-wrappers-sumo'
import { b64u, fromB64u, sign, signedPayload, u64be, verify } from './crypto'
import type { Identity } from './identity'
import { verifyRotation, type Rotation } from './rotation'

export const KEYLOG_ENTRY_CONTEXT = 'iskra/keylog-entry/v1'
export const KEYLOG_HEAD_CONTEXT = 'iskra/keylog-head/v1'
export const GOSSIP_CONTEXT = 'iskra/kt-gossip/v1'
export const MAX_GOSSIP_HEADS = 16
export const MAX_GOSSIP_ROTATIONS = 16
export const MAX_GOSSIP_DEVICES = 20
const CHECKPOINTS = 512
const ZERO = new Uint8Array(32)

export interface LogHead {
  seq: number
  hash: string
  at: number
  sig: string
}

export interface WireLogEntry {
  seq: number
  data: string
}

export type LogEntry =
  | { kind: 'join' | 'name'; at: number; key: string; name: string }
  | { kind: 'rotate' | 'contest'; at: number; rotation: Rotation }
  | { kind: 'resolve'; at: number; rotation: Rotation; previousKey: string }

/** What this device keeps per server: the verified head and what the log says so far. */
export interface LogView {
  serverKey: string
  head: LogHead
  /** Account key → the latest name logged for it (keys that moved on keep theirs under the new key). */
  names: Record<string, string>
  /** Old key → the key the log says holds the account now. */
  rotations: Record<string, string>
  /** Old key → a second claim the log recorded. */
  contests: Record<string, string>
  /** Recent (seq, hash) pairs, oldest first, to check heads friends saw. */
  checkpoints: [number, string][]
  /** Heads friends saw that are ahead of ours: our log must pass through them. */
  expect?: { seq: number; hash: string; from: string }[]
}

export type LogProblem = 'bad-signature' | 'rollback' | 'fork' | 'bad-entry' | 'gap'

export class LogError extends Error {
  readonly problem: LogProblem
  constructor(problem: LogProblem, message: string = problem) {
    super(message)
    this.problem = problem
  }
}

export function entryHash(prev: Uint8Array, seq: number, data: string): Uint8Array {
  return sodium.crypto_hash_sha256(signedPayload(KEYLOG_ENTRY_CONTEXT, prev, u64be(seq), new TextEncoder().encode(data)))
}

export const headPayload = (serverKey: Uint8Array, head: Pick<LogHead, 'seq' | 'hash' | 'at'>) =>
  signedPayload(KEYLOG_HEAD_CONTEXT, serverKey, u64be(head.seq), fromB64u(head.hash), u64be(head.at))

/** The server signed this head (with the key we pinned for it). */
export function verifyHead(serverKey: string, head: LogHead | null | undefined): head is LogHead {
  try {
    if (!head || !Number.isSafeInteger(head.seq) || head.seq < 0 || !Number.isSafeInteger(head.at) || head.at < 0) return false
    const hash = fromB64u(head.hash)
    if (hash.length !== 32) return false
    return verify(fromB64u(head.sig), headPayload(fromB64u(serverKey), head), fromB64u(serverKey))
  } catch {
    return false
  }
}

const isKey = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v)

/** Parses one entry. Null if it's malformed or a rotation in it isn't correctly signed. */
export function parseEntry(data: string): LogEntry | null {
  let e: Record<string, unknown>
  try {
    e = JSON.parse(data)
  } catch {
    return null
  }
  if (!e || typeof e !== 'object' || !Number.isSafeInteger(e.at)) return null
  const at = e.at as number
  switch (e.kind) {
    case 'join':
    case 'name':
      return isKey(e.key) && typeof e.name === 'string' && e.name.length <= 64 ? { kind: e.kind, at, key: e.key, name: e.name } : null
    case 'rotate':
    case 'contest':
      return verifyRotation(e.rotation as Rotation) ? { kind: e.kind, at, rotation: e.rotation as Rotation } : null
    case 'resolve':
      return verifyRotation(e.rotation as Rotation) && isKey(e.previousKey)
        ? { kind: 'resolve', at, rotation: e.rotation as Rotation, previousKey: e.previousKey } : null
    default:
      return null
  }
}

export function emptyView(serverKey: string): LogView {
  return { serverKey, head: { seq: 0, hash: b64u(ZERO), at: 0, sig: '' }, names: {}, rotations: {}, contests: {}, checkpoints: [] }
}

function apply(view: LogView, entry: LogEntry): void {
  switch (entry.kind) {
    case 'join':
    case 'name':
      view.names[entry.key] = entry.name
      return
    case 'rotate': {
      const { oldKey, newKey } = entry.rotation
      view.rotations[oldKey] = newKey
      if (oldKey in view.names) {
        view.names[newKey] = view.names[oldKey]
        delete view.names[oldKey]
      }
      return
    }
    case 'contest':
      view.contests[entry.rotation.oldKey] = entry.rotation.newKey
      return
    case 'resolve': {
      const { oldKey, newKey } = entry.rotation
      if (entry.previousKey !== newKey) {
        view.contests[oldKey] = entry.previousKey
        view.rotations[oldKey] = newKey
        if (entry.previousKey in view.names) {
          view.names[newKey] = view.names[entry.previousKey]
          delete view.names[entry.previousKey]
        }
      }
    }
  }
}

/**
 * Moves <paramref name="view"/> forward to <paramref name="head"/> with the entries in between, checking the head's
 * signature and every link of the chain from the head we had. Throws LogError: `rollback` (an older head than one the
 * server already signed for us), `fork` (a different history than the one we have), `bad-entry`, `gap`.
 */
export function extendView(view: LogView, head: LogHead, entries: WireLogEntry[]): { view: LogView; added: LogEntry[] } {
  if (!verifyHead(view.serverKey, head)) throw new LogError('bad-signature')
  if (head.seq < view.head.seq) throw new LogError('rollback')
  if (head.seq === view.head.seq) {
    if (head.hash !== view.head.hash) throw new LogError('fork')
    return { view: { ...view, head }, added: [] }
  }
  const next: LogView = {
    ...view, names: { ...view.names }, rotations: { ...view.rotations }, contests: { ...view.contests }, checkpoints: [...view.checkpoints],
  }
  let hash = fromB64u(view.head.hash)
  let seq = view.head.seq
  const added: LogEntry[] = []
  for (const wire of entries) {
    if (wire.seq <= seq) continue
    if (wire.seq !== seq + 1 || typeof wire.data !== 'string') throw new LogError('gap')
    const entry = parseEntry(wire.data)
    if (!entry) throw new LogError('bad-entry')
    hash = entryHash(hash, wire.seq, wire.data)
    seq = wire.seq
    apply(next, entry)
    added.push(entry)
    next.checkpoints.push([seq, b64u(hash)])
    if (seq === head.seq) break
  }
  if (seq !== head.seq) throw new LogError('gap')
  if (b64u(hash) !== head.hash) throw new LogError('fork')
  next.checkpoints = next.checkpoints.slice(-CHECKPOINTS)
  next.head = head
  // Heads friends saw ahead of us: now we can check them.
  const pending = next.expect ?? []
  const broken = pending.find((e) => e.seq <= seq && hashAt(next, e.seq) !== null && hashAt(next, e.seq) !== e.hash)
  if (broken) throw new LogError('fork', broken.from)
  next.expect = pending.filter((e) => e.seq > seq)
  if (!next.expect.length) delete next.expect
  return { view: next, added }
}

/** The hash our log has at <paramref name="seq"/>, if we kept it. */
export function hashAt(view: LogView, seq: number): string | null {
  if (seq === view.head.seq) return view.head.hash
  if (seq === 0) return b64u(ZERO)
  return view.checkpoints.find(([s]) => s === seq)?.[1] ?? null
}

/** Keys someone is shown as on this server that its log doesn't explain (never joined, never rotated to). */
export function unloggedKeys(view: LogView, keys: string[]): string[] {
  return keys.filter((k) => !(k in view.names))
}

/** The log records this rotation (as applied, contested or resolved that way). */
export const rotationLogged = (view: LogView, r: Pick<Rotation, 'oldKey' | 'newKey'>) =>
  view.rotations[r.oldKey] === r.newKey || view.contests[r.oldKey] === r.newKey

// ── Comparing servers ───────────────────────────────────────────────────────

export interface Split {
  oldKey: string
  /** New key → the servers whose log says so. */
  claims: Record<string, string[]>
}

/** Old keys that different servers' logs move to different new keys: someone is being shown another person's key. */
export function splitViews(views: LogView[]): Split[] {
  const byOld = new Map<string, Record<string, string[]>>()
  for (const view of views) {
    for (const [oldKey, newKey] of Object.entries(view.rotations)) {
      const claims = byOld.get(oldKey) ?? {}
      claims[newKey] = [...(claims[newKey] ?? []), view.serverKey]
      byOld.set(oldKey, claims)
    }
  }
  return [...byOld].filter(([, claims]) => Object.keys(claims).length > 1).map(([oldKey, claims]) => ({ oldKey, claims }))
}

/** Normalised for lookalike checks: case, width and spacing don't make a different name. */
export const sameName = (a: string, b: string) => {
  const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
  return norm(a) === norm(b)
}

/**
 * Friends who aren't on this server, while someone else there uses their name: what impersonation looks like when a
 * server can't forge a key. `same` says whether two keys are one person (checked rotations).
 */
export function lookalikes(friends: { key: string; name: string }[], members: { key: string; name: string }[], same: (a: string, b: string) => boolean) {
  const found: { friend: string; key: string; name: string }[] = []
  for (const friend of friends) {
    if (members.some((m) => same(m.key, friend.key))) continue
    for (const m of members) if (sameName(m.name, friend.name)) found.push({ friend: friend.key, key: m.key, name: m.name })
  }
  return found
}

// ── Gossip ──────────────────────────────────────────────────────────────────

export interface GossipHead extends LogHead {
  server: string
}

/** A signed digest of what one person's app sees, sent inside an end-to-end encrypted DM. */
export interface Gossip {
  v: 1
  from: string
  to: string
  at: number
  /** Signed heads of key logs on servers both people use. */
  heads: GossipHead[]
  /** Rotations the sender has checked, for people on those servers (and the sender). */
  rotations: Rotation[]
  /** The sender's own device keys, as the sender knows them. */
  devices: string[]
  sig: string
}

const gossipPayload = (g: Omit<Gossip, 'sig' | 'v'>) =>
  signedPayload(GOSSIP_CONTEXT, new TextEncoder().encode(JSON.stringify([
    g.from, g.to, g.at,
    g.heads.map((h) => [h.server, h.seq, h.hash, h.at, h.sig]),
    g.rotations.map((r) => [r.oldKey, r.newKey, r.rotatedAt, r.oldSig, r.newSig]),
    g.devices,
  ])))

export function signGossip(identity: Identity, to: string, body: Pick<Gossip, 'heads' | 'rotations' | 'devices'>, now = Date.now()): Gossip {
  const unsigned = {
    from: b64u(identity.account.publicKey), to, at: now,
    heads: body.heads.slice(0, MAX_GOSSIP_HEADS).map(({ server, seq, hash, at, sig }) => ({ server, seq, hash, at, sig })),
    rotations: body.rotations.slice(-MAX_GOSSIP_ROTATIONS).map(({ oldKey, newKey, rotatedAt, oldSig, newSig }) => ({ oldKey, newKey, rotatedAt, oldSig, newSig })),
    devices: body.devices.slice(0, MAX_GOSSIP_DEVICES),
  }
  return { v: 1, ...unsigned, sig: b64u(sign(gossipPayload(unsigned), identity.account.secretKey)) }
}

/**
 * Checks gossip from a DM: well formed, within limits, signed by the sender's account key, from the DM's sender to
 * its recipient, not from the future. Heads and rotations that don't verify are dropped. Null if anything else is off.
 */
export function checkGossip(raw: unknown, sender: string, recipient: string, now = Date.now(), same: (a: string, b: string) => boolean = (a, b) => a === b): Gossip | null {
  if (!raw || typeof raw !== 'object') return null
  const g = raw as Gossip
  try {
    if (g.v !== 1 || !isKey(g.from) || !isKey(g.to) || !Number.isSafeInteger(g.at) || g.at > now + 10 * 60_000) return null
    if (!same(g.from, sender) || !same(g.to, recipient)) return null
    if (!Array.isArray(g.heads) || g.heads.length > MAX_GOSSIP_HEADS || !Array.isArray(g.rotations) || g.rotations.length > MAX_GOSSIP_ROTATIONS) return null
    if (!Array.isArray(g.devices) || g.devices.length > MAX_GOSSIP_DEVICES || !g.devices.every(isKey)) return null
    if (!g.heads.every((h) => h && isKey(h.server)) || !g.rotations.every((r) => r && typeof r === 'object')) return null
    if (!verify(fromB64u(g.sig), gossipPayload(g), fromB64u(g.from))) return null
  } catch {
    return null
  }
  return { ...g, heads: g.heads.filter((h) => verifyHead(h.server, h)), rotations: g.rotations.filter((r) => verifyRotation(r)) }
}

export type GossipFinding =
  | { kind: 'fork'; server: string; seq: number }
  | { kind: 'conflict'; oldKey: string; mine: string; theirs: string }

/**
 * Compares a friend's signed heads and rotations with ours. Two heads the same server signed for the same position
 * but with different hashes are proof it showed us different logs. A head ahead of ours is remembered (`expect`)
 * and checked once our log reaches it. Returns the findings and the views with those expectations added.
 */
export function compareGossip(
  views: Record<string, LogView>, g: Gossip, resolve: (key: string) => string,
): { findings: GossipFinding[]; views: Record<string, LogView> } {
  const findings: GossipFinding[] = []
  const next = { ...views }
  for (const h of g.heads) {
    const view = views[h.server]
    if (!view || !view.head.sig) continue
    if (h.seq <= view.head.seq) {
      const ours = hashAt(view, h.seq)
      if (ours !== null && ours !== h.hash) findings.push({ kind: 'fork', server: h.server, seq: h.seq })
    } else if (!(view.expect ?? []).some((e) => e.seq === h.seq && e.hash === h.hash)) {
      const conflicting = (view.expect ?? []).find((e) => e.seq === h.seq && e.hash !== h.hash)
      if (conflicting) findings.push({ kind: 'fork', server: h.server, seq: h.seq })
      next[h.server] = { ...view, expect: [...(view.expect ?? []), { seq: h.seq, hash: h.hash, from: g.from }].slice(-32) }
    }
  }
  for (const r of g.rotations) {
    const mine = resolve(r.oldKey)
    // We know a different successor for that key, and theirs isn't somewhere along our chain.
    if (mine !== r.oldKey && mine !== resolve(r.newKey)) findings.push({ kind: 'conflict', oldKey: r.oldKey, mine, theirs: r.newKey })
  }
  return { findings, views: next }
}
