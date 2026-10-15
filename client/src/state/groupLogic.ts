// Pure helpers for group DMs (no sockets, no stores), so they can be tested on their own.
import type { GroupView, VerifiedChange } from '../core/group'
import { t } from '../i18n'

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
  /** End-to-end encrypted attachments (core/dmFiles.ts). */
  files?: import('../core/dmFiles').DmFile[]
  /** When it disappears from this device (state/disappearing.ts deletes it then). */
  expiresAt?: number
  /** A disappearing messages timer change line (seconds, 0 = off). */
  disappear?: { seconds: number }
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
  return t('groups.change.and', { list: names.slice(0, -1).join(', '), last: names.at(-1)! })
}

/** "Alice added Bob and Carol", with "you" for yourself. */
export function changeText(change: Pick<VerifiedChange, 'action' | 'by' | 'targets'>, me: string, nameOf: (key: string) => string): string {
  const who = (key: string, start = false) => (key === me ? (start ? t('groups.change.youSubject') : t('groups.change.youObject')) : nameOf(key))
  const targets = list(change.targets.map((k) => who(k)))
  switch (change.action) {
    case 'create': return t('groups.change.created', { who: who(change.by, true), targets })
    case 'add': return t('groups.change.added', { who: who(change.by, true), targets })
    case 'remove': return t('groups.change.removed', { who: who(change.by, true), targets })
    case 'leave': return t('groups.change.left', { who: who(change.by, true) })
  }
}

/** What a group is called: its name, or the other members' names. */
export function groupTitle(name: string | null, members: string[], me: string, nameOf: (key: string) => string): string {
  if (name) return name
  const others = members.filter((m) => m !== me).map(nameOf)
  if (others.length === 0) return t('groups.title.justYou')
  if (others.length <= 4) return list(others)
  return t('groups.title.andMore', { names: others.slice(0, 3).join(', '), count: others.length - 3 })
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
  return {
    title: t('groups.call.started', { name: caller }),
    body: video ? t('groups.call.ringBodyVideo', { group }) : t('groups.call.ringBodyVoice', { group }),
  }
}
