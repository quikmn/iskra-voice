// Friend requests. A friend action (request, accept, cancel, decline, remove) travels inside an ordinary end-to-end
// encrypted DM, and is also signed by the sender's account key, so it can't be forged or moved to another pair of
// people, whichever server or device it came through. See "Friends" in protocol/PROTOCOL.md.
import { b64u, fromB64u, randomBytes, sign, signedPayload, verify } from './crypto'
import type { Identity } from './identity'

export const FRIEND_CONTEXT = 'iskra/friend/v1'
export const FRIEND_KINDS = ['request', 'accept', 'cancel', 'decline', 'remove'] as const
export type FriendKind = (typeof FRIEND_KINDS)[number]

export interface FriendAction {
  kind: FriendKind
  from: string
  to: string
  /** When the sender made it (ms, sender's clock). */
  at: number
  /** Random, 12 bytes b64u: one action, however many copies arrive. */
  id: string
  sig: string
}

/** A sender's clock may be ahead by at most this much. */
export const MAX_FUTURE_MS = 10 * 60_000

const payload = (a: Omit<FriendAction, 'sig'>) =>
  signedPayload(FRIEND_CONTEXT, new TextEncoder().encode(JSON.stringify([a.kind, a.from, a.to, a.at, a.id])))

export function signFriend(identity: Identity, kind: FriendKind, to: string, now = Date.now()): FriendAction {
  const from = b64u(identity.account.publicKey)
  const action = { kind, from, to, at: now, id: b64u(randomBytes(12)) }
  return { ...action, sig: b64u(sign(payload(action), identity.account.secretKey)) }
}

/**
 * Checks a friend action from a DM: well formed, signed by `from`'s account key, from the DM's sender to its
 * recipient, not from the future. `same` says whether two account keys are one person (a checked key rotation).
 * Null if anything is off.
 */
export function checkFriend(
  raw: unknown, sender: string, recipient: string, now = Date.now(),
  same: (a: string, b: string) => boolean = (a, b) => a === b,
): FriendAction | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const { kind, from, to, at, id, sig } = raw as Record<string, unknown>
  if (typeof kind !== 'string' || !(FRIEND_KINDS as readonly string[]).includes(kind)) return null
  if (typeof from !== 'string' || typeof to !== 'string' || from.length > 64 || to.length > 64 || from === to) return null
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0 || at > now + MAX_FUTURE_MS) return null
  if (typeof id !== 'string' || id.length === 0 || id.length > 32 || typeof sig !== 'string' || sig.length > 128) return null
  if (!same(from, sender) || !same(to, recipient)) return null
  const action = { kind: kind as FriendKind, from, to, at, id }
  try {
    const key = fromB64u(from)
    if (key.length !== 32 || !verify(fromB64u(sig), payload(action), key)) return null
  } catch {
    return null
  }
  return { ...action, sig }
}

/** What older apps show instead (they don't know friend actions). Quiet kinds say as little as possible. */
export function friendFallback(kind: FriendKind): string {
  if (kind === 'request') return 'Sent you a friend request.'
  if (kind === 'accept') return 'Accepted your friend request.'
  return 'Friends list updated.'
}
