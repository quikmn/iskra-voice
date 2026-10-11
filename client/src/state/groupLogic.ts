// Pure helpers for group DMs (no sockets, no stores), so they can be tested on their own.
import type { GroupView, VerifiedChange } from '../core/group'

export interface GroupMsg {
  /** The id inside the encrypted header; the same on every device. */
  id: string
  from: string
  text: string
  sentAt: number
  pending?: 'sending' | 'failed'
  /** Set when a message couldn't be decrypted (shown as a notice, never as text). */
  error?: string
  /** A call line (see groupCalls.ts). */
  call?: Record<string, unknown>
  /** A rename (see core/group.ts asRename). */
  group?: Record<string, unknown>
}

/** One row of a group conversation: a message, or a membership change from the signed chain. */
export type TimelineItem =
  | { kind: 'message'; at: number; message: GroupMsg }
  | { kind: 'change'; at: number; change: VerifiedChange }

/** Messages and membership changes, oldest first. A change sorts before a message sent at the same moment. */
export function timeline(messages: GroupMsg[], view: GroupView | null): TimelineItem[] {
  const items: TimelineItem[] = [
    ...(view?.changes ?? []).map((change) => ({ kind: 'change' as const, at: change.at, change })),
    ...messages.map((message) => ({ kind: 'message' as const, at: message.sentAt, message })),
  ]
  return items.sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === 'change' ? -1 : 1))
}

function list(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/** "Alice added Bob and Carol", with "you" for yourself. */
export function changeText(change: Pick<VerifiedChange, 'action' | 'by' | 'targets'>, me: string, nameOf: (key: string) => string): string {
  const who = (key: string, start = false) => (key === me ? (start ? 'You' : 'you') : nameOf(key))
  const targets = list(change.targets.map((t) => who(t)))
  switch (change.action) {
    case 'create': return `${who(change.by, true)} created the group with ${targets}`
    case 'add': return `${who(change.by, true)} added ${targets}`
    case 'remove': return `${who(change.by, true)} removed ${targets}`
    case 'leave': return `${who(change.by, true)} left the group`
  }
}

/** What a group is called: its name, or the other members' names. */
export function groupTitle(name: string | null, members: string[], me: string, nameOf: (key: string) => string): string {
  if (name) return name
  const others = members.filter((m) => m !== me).map(nameOf)
  if (others.length === 0) return 'Just you'
  if (others.length <= 4) return list(others)
  return `${others.slice(0, 3).join(', ')} and ${others.length - 3} more`
}

/** Grid columns for a call with `count` tiles: fills a wide screen, stacks on a phone. */
export function callColumns(count: number, narrow: boolean): number {
  if (narrow) return count <= 2 ? 1 : 2
  if (count <= 1) return 1
  if (count <= 4) return 2
  if (count <= 9) return 3
  return 4
}

export interface GroupKeyContent {
  kind: 'group-key'
  id: string
  key: string
  index: number
  video: boolean
}

const B64U = /^[A-Za-z0-9_-]+$/

/** A decrypted group call key, checked against the call it's for. LiveKit keeps 16 key slots, so index is 0–15. */
export function checkGroupKey(call: unknown, callId: string): GroupKeyContent | null {
  if (!call || typeof call !== 'object') return null
  const c = call as Partial<GroupKeyContent>
  if (c.kind !== 'group-key' || c.id !== callId || typeof c.key !== 'string' || c.key.length !== 43 || !B64U.test(c.key)) return null
  if (typeof c.index !== 'number' || !Number.isInteger(c.index) || c.index < 0 || c.index > 15 || typeof c.video !== 'boolean') return null
  return { kind: 'group-key', id: c.id, key: c.key, index: c.index, video: c.video }
}

/** A key only ever replaces an older one: a newer group version, or the same version sent later. Stops replays of old keys. */
export function isNewerKey(next: { version: number; sentAt: number }, current: { version: number; sentAt: number } | undefined): boolean {
  if (!current) return true
  return next.version > current.version || (next.version === current.version && next.sentAt > current.sentAt)
}

/** Who sends the next key: the person who has been in the call longest (first in the server's join order) and is still in the group. */
export function keyholder(participants: string[], members: string[]): string | undefined {
  return participants.find((p) => members.includes(p))
}

/** A "started a call" line in a group conversation. */
export function asGroupCallLine(call: unknown): { kind: 'group-start'; id: string; video: boolean } | null {
  if (!call || typeof call !== 'object') return null
  const c = call as { kind?: unknown; id?: unknown; video?: unknown }
  if (c.kind !== 'group-start' || typeof c.id !== 'string' || typeof c.video !== 'boolean') return null
  return { kind: 'group-start', id: c.id, video: c.video }
}

/**
 * The system notification for a ringing group call, or null when it shouldn't show: like a 1:1 call, only while the
 * window isn't focused, desktop notifications are on and the browser allows them.
 */
export function ringNotice(caller: string, group: string, video: boolean, env: { focused: boolean; enabled: boolean; permission: string }): { title: string; body: string } | null {
  if (env.focused || !env.enabled || env.permission !== 'granted') return null
  return { title: `${caller} started a group call`, body: `${group} · ${video ? 'Video' : 'Voice'} call · end-to-end encrypted` }
}
