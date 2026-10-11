// The friend relation with one person, worked out from the signed actions both of you sent (core/friend.ts).
// Actions are kept per person and folded in time order, so it comes out the same whichever order copies arrive in,
// from whichever server or device. Pure: no DOM, no network.
import type { FriendKind } from '../core/friend'

export type Relation = 'none' | 'outgoing' | 'incoming' | 'friends'

export interface FriendEvent {
  id: string
  kind: FriendKind
  /** Sent by you (any of your devices), else by them. */
  mine: boolean
  at: number
}

/** Kept per person: enough to fold, bounded. */
export const MAX_EVENTS = 32

function step(relation: Relation, e: FriendEvent): Relation {
  switch (e.kind) {
    case 'request':
      // Two requests meet: you're friends, as if one accepted the other.
      if (e.mine) return relation === 'incoming' ? 'friends' : relation === 'none' ? 'outgoing' : relation
      return relation === 'outgoing' ? 'friends' : relation === 'none' ? 'incoming' : relation
    case 'accept':
      // Only accepts an open request; an accept out of nowhere means nothing.
      return e.mine ? (relation === 'incoming' ? 'friends' : relation) : (relation === 'outgoing' ? 'friends' : relation)
    case 'cancel':
      return relation === (e.mine ? 'outgoing' : 'incoming') ? 'none' : relation
    case 'decline':
      // Ignoring is quiet: the sender's request still looks pending to them.
      return e.mine && relation === 'incoming' ? 'none' : relation
    case 'remove':
      return 'none'
  }
}

const order = (a: FriendEvent, b: FriendEvent) => a.at - b.at || Number(a.mine) - Number(b.mine) || a.id.localeCompare(b.id)

export function relationOf(events: FriendEvent[]): Relation {
  return [...events].sort(order).reduce(step, 'none' as Relation)
}

/** Adds an event (once per sender and id); keeps the newest MAX_EVENTS. Returns the same list if it's a copy. */
export function addEvent(events: FriendEvent[], e: FriendEvent): FriendEvent[] {
  if (events.some((x) => x.id === e.id && x.mine === e.mine)) return events
  return [...events, e].sort(order).slice(-MAX_EVENTS)
}

/** When the current relation began (the event that made it), for "Friends since". */
export function sinceOf(events: FriendEvent[]): number {
  let relation: Relation = 'none'
  let since = 0
  for (const e of [...events].sort(order)) {
    const next = step(relation, e)
    if (next !== relation) since = e.at
    relation = next
  }
  return since
}

/** What to send for what you want to do, given where things stand; null if there's nothing to send. */
export function actionFor(relation: Relation, intent: 'add' | 'accept' | 'ignore' | 'cancel' | 'remove'): FriendKind | null {
  switch (intent) {
    case 'add':
      return relation === 'none' ? 'request' : relation === 'incoming' ? 'accept' : null
    case 'accept':
      return relation === 'incoming' ? 'accept' : null
    case 'ignore':
      return relation === 'incoming' ? 'decline' : null
    case 'cancel':
      return relation === 'outgoing' ? 'cancel' : null
    case 'remove':
      return relation === 'friends' ? 'remove' : null
  }
}

/** Kinds that never notify, never count as unread and aren't shown in the conversation. */
export const quietKind = (kind: FriendKind) => kind === 'cancel' || kind === 'decline' || kind === 'remove'

const KINDS: readonly string[] = ['request', 'accept', 'cancel', 'decline', 'remove']

/** Friend state from another of your devices (device linking): only well-formed entries, bounded. Null if unusable. */
export function cleanFriendState(raw: unknown): { v: 1; peers: Record<string, { name: string; events: FriendEvent[] }>; unsent: string[] } | null {
  if (!raw || typeof raw !== 'object') return null
  const { v, peers, unsent } = raw as Record<string, unknown>
  if (v !== 1 || !peers || typeof peers !== 'object' || Array.isArray(peers)) return null
  const out: Record<string, { name: string; events: FriendEvent[] }> = {}
  for (const [key, p] of Object.entries(peers as Record<string, unknown>).slice(0, 1000)) {
    if (key.length > 64 || !p || typeof p !== 'object') continue
    const { name, events } = p as Record<string, unknown>
    if (!Array.isArray(events)) continue
    const clean = events.filter((e): e is FriendEvent => !!e && typeof e === 'object'
      && typeof e.id === 'string' && e.id.length <= 64 && KINDS.includes(e.kind) && typeof e.mine === 'boolean'
      && typeof e.at === 'number' && Number.isSafeInteger(e.at))
      .map((e) => ({ id: e.id, kind: e.kind, mine: e.mine, at: e.at }))
    out[key] = { name: typeof name === 'string' ? name.slice(0, 64) : '', events: clean.reduce(addEvent, []) }
  }
  const list = Array.isArray(unsent) ? unsent.filter((k): k is string => typeof k === 'string' && k.length <= 64 && !!out[k]).slice(0, 1000) : []
  return { v: 1, peers: out, unsent: list }
}
