// The inbox's rules (pure): which entries it lists, in what order, under which filter, and which are unread. Unread
// comes from the read state (readState.ts) only: a ping is unread while its conversation is unread from it on.
import type { InboxItem } from '../core/protocol'
import type { ConversationRead } from './readState'

export type InboxFilter = 'all' | 'mentions' | 'replies' | 'reminders' | 'requests'

export type InboxEntry =
  | { type: 'ping'; key: string; server: string; conv: string; item: InboxItem; unread: boolean; at: number }
  | { type: 'dm'; key: string; conv: string; peer: string; count: number; at: number }
  | { type: 'group'; key: string; conv: string; group: string; count: number; at: number }
  | { type: 'request'; key: string; peer: string; at: number }
  | { type: 'reminder'; key: string; server: string; id: number; at: number }

export interface InboxSources {
  pings: { server: string; conv: string; item: InboxItem }[]
  convs: Record<string, ConversationRead>
  requests: { peer: string; at: number }[]
  /** Fired reminders still waiting for you. */
  reminders: { server: string; id: number; firedAt: number }[]
  includeEveryone: boolean
}

/** Unread while the conversation's unread stretch reaches back to (or before) this message. */
export function pingUnread(item: InboxItem, conv: ConversationRead | undefined): boolean {
  const from = conv?.from
  if (!from) return false
  return typeof from.id === 'number' ? item.message.id >= from.id : item.message.createdAt >= from.at
}

export function buildInbox(src: InboxSources): InboxEntry[] {
  const entries: InboxEntry[] = []
  for (const { server, conv, item } of src.pings) {
    if (!src.includeEveryone && item.kind === 'everyone') continue
    entries.push({ type: 'ping', key: `p:${server}:${item.message.id}`, server, conv, item, unread: pingUnread(item, src.convs[conv]), at: item.message.createdAt })
  }
  for (const [conv, read] of Object.entries(src.convs)) {
    if (read.unread === 0 || !read.from) continue
    if (conv.startsWith('d:')) entries.push({ type: 'dm', key: conv, conv, peer: conv.slice(2), count: read.unread, at: read.from.at })
    if (conv.startsWith('g:')) entries.push({ type: 'group', key: conv, conv, group: conv.slice(2), count: read.unread, at: read.from.at })
  }
  for (const r of src.requests) entries.push({ type: 'request', key: `f:${r.peer}`, peer: r.peer, at: r.at })
  for (const r of src.reminders) entries.push({ type: 'reminder', key: `r:${r.server}:${r.id}`, server: r.server, id: r.id, at: r.firedAt })
  return entries.sort((a, b) => b.at - a.at)
}

export function filterInbox(entries: InboxEntry[], filter: InboxFilter): InboxEntry[] {
  switch (filter) {
    case 'all': return entries
    case 'mentions': return entries.filter((e) => e.type === 'ping' && e.item.kind !== 'reply')
    case 'replies': return entries.filter((e) => e.type === 'ping' && e.item.kind === 'reply')
    case 'reminders': return entries.filter((e) => e.type === 'reminder')
    case 'requests': return entries.filter((e) => e.type === 'request')
  }
}

/** The bell's number: unread pings, reminders waiting and friend requests (unread DMs already badge Home). */
export function inboxBadge(entries: InboxEntry[]): number {
  return entries.filter((e) => (e.type === 'ping' && e.unread) || e.type === 'reminder' || e.type === 'request').length
}

/** Keeps the newest copy per message, newest first, at most `max`. */
export function mergeItems(list: InboxItem[], incoming: InboxItem[], max = 200): InboxItem[] {
  const byId = new Map<number, InboxItem>()
  for (const item of [...list, ...incoming]) byId.set(item.message.id, item)
  return [...byId.values()].sort((a, b) => b.message.id - a.message.id).slice(0, max)
}

/** Items newer than what this device already counted (none the first time, so old pings don't all turn unread). */
export function missedItems(items: InboxItem[], seen: number | undefined): InboxItem[] {
  if (seen === undefined) return []
  return items.filter((i) => i.message.id > seen)
}
