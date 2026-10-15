// The inbox: one list across every server and DM of what's for you — mentions, replies, role and @everyone pings,
// unread DMs and groups, friend requests and reminders that are due. Pings come from each server's mention index
// (inbox.list / inbox.new); whether they're unread comes from the read state, like every other badge.
import { create } from 'zustand'
import type { Events, InboxItem } from '../core/protocol'
import { connectionFor, onServerEvent, onWelcomeHook, useApp } from './store'
import { channelConv, markConversationRead, noteMessage, useReads } from './readState'
import { useFriends } from './friends'
import { deleteReminder, splitReminders, useReminders } from './reminders'
import { buildInbox, inboxBadge, mergeItems, missedItems, withAlertHits, type InboxEntry, type InboxFilter } from './inboxLogic'
import { useAlerts } from './alerts'

const SEEN_KEY = 'iskra.inbox.seen'
const EVERYONE_KEY = 'iskra.inbox.everyone'

export type InboxTab = 'inbox' | 'saved' | 'reminders' | 'scheduled'

interface InboxState {
  items: Record<string, InboxItem[]>
  hasMore: Record<string, boolean>
  open: InboxTab | null
  filter: InboxFilter
  includeEveryone: boolean
}

function loadEveryone(): boolean {
  try {
    return localStorage.getItem(EVERYONE_KEY) !== '0'
  } catch {
    return true
  }
}

export const useInbox = create<InboxState>(() => ({ items: {}, hasMore: {}, open: null, filter: 'all', includeEveryone: loadEveryone() }))

export const openInbox = (tab: InboxTab = 'inbox') => useInbox.setState({ open: tab })
export const closeInbox = () => useInbox.setState({ open: null })
export const setInboxFilter = (filter: InboxFilter) => useInbox.setState({ filter })

export function setIncludeEveryone(on: boolean): void {
  useInbox.setState({ includeEveryone: on })
  try {
    localStorage.setItem(EVERYONE_KEY, on ? '1' : '0')
  } catch {
    /* private mode */
  }
}

// ── What this device already counted, per server (the newest ping id) ─────

function seenMap(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}') as Record<string, number>
  } catch {
    return {}
  }
}

function markSeen(server: string, id: number): void {
  const map = seenMap()
  if ((map[server] ?? 0) >= id) return
  map[server] = id
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(map))
  } catch {
    /* private mode */
  }
}

// ── Entries ─────────────────────────────────────────────────────────────────

const convOf = (server: string, item: InboxItem) => channelConv(server, item.channelId)

/** Everything the inbox lists right now. */
export function inboxEntries(): InboxEntry[] {
  const { items, includeEveryone } = useInbox.getState()
  const servers = useApp.getState().servers
  // Alert words this app matched (encrypted channels too) join the server's own list.
  const pings = Object.entries(withAlertHits(items, useAlerts.getState().hits)).filter(([server]) => servers[server])
    .flatMap(([server, list]) => list.map((item) => ({ server, conv: convOf(server, item), item })))
  const requests = Object.entries(useFriends.getState().peers).filter(([, p]) => p.relation === 'incoming').map(([peer, p]) => ({ peer, at: p.since }))
  const reminders = splitReminders(useReminders.getState().all).due.map((r) => ({ server: r.server, id: r.id, firedAt: r.firedAt ?? r.dueAt }))
  return buildInbox({ pings, convs: useReads.getState().convs, requests, reminders, includeEveryone })
}

/** Re-renders with any of the inbox's sources. */
export function useInboxEntries(): InboxEntry[] {
  useInbox((s) => s.items)
  useInbox((s) => s.includeEveryone)
  useAlerts((s) => s.hits)
  useReads((s) => s.convs)
  useFriends((s) => s.peers)
  useReminders((s) => s.all)
  useApp((s) => s.servers)
  return inboxEntries()
}

export const useInboxBadge = () => inboxBadge(useInboxEntries())

export function markEntryRead(entry: InboxEntry): void {
  if (entry.type === 'ping' || entry.type === 'dm' || entry.type === 'group') markConversationRead(entry.conv)
  if (entry.type === 'reminder') {
    const reminder = useReminders.getState().all[`${entry.server}:${entry.id}`]
    if (reminder) void deleteReminder(reminder).catch(() => undefined)
  }
}

/** Every listed conversation read, and reminders that are due done. Friend requests wait for an answer. */
export function markAllInboxRead(): void {
  for (const entry of inboxEntries()) if (entry.type !== 'request') markEntryRead(entry)
}

// ── Loading ─────────────────────────────────────────────────────────────────

const PAGE = 50

async function load(server: string): Promise<void> {
  const connection = connectionFor(server)
  if (!connection) return
  try {
    const { items, hasMore } = await connection.request('inbox.list', { limit: PAGE })
    // Pings that arrived while we were away count as unread now (live ones were counted as they came).
    const seen = seenMap()[server]
    for (const item of missedItems(items, seen).reverse()) {
      noteMessage(convOf(server, item), { id: item.message.id, at: item.message.createdAt }, true)
    }
    if (items.length) markSeen(server, items[0].message.id)
    else if (seen === undefined) markSeen(server, 0)
    useInbox.setState((s) => ({ items: { ...s.items, [server]: mergeItems([], items) }, hasMore: { ...s.hasMore, [server]: hasMore } }))
  } catch {
    /* an older server without the inbox */
  }
}

/** Older pings from every server that has more. */
export async function loadMoreInbox(): Promise<void> {
  const { items, hasMore } = useInbox.getState()
  await Promise.all(Object.entries(hasMore).filter(([, more]) => more).map(async ([server]) => {
    const oldest = items[server]?.at(-1)?.message.id
    const connection = connectionFor(server)
    if (!connection || !oldest) return
    try {
      const page = await connection.request('inbox.list', { limit: PAGE, before: oldest })
      useInbox.setState((s) => ({
        items: { ...s.items, [server]: mergeItems(s.items[server] ?? [], page.items, 1000) },
        hasMore: { ...s.hasMore, [server]: page.hasMore },
      }))
    } catch {
      /* try again later */
    }
  }))
}

function patchItems(server: string, change: (list: InboxItem[]) => InboxItem[]): void {
  useInbox.setState((s) => (s.items[server] ? { items: { ...s.items, [server]: change(s.items[server]) } } : s))
}

onWelcomeHook((server) => void load(server))
onServerEvent((server, type, body) => {
  if (type === 'inbox.new') {
    const { item } = body as Events['inbox.new']
    markSeen(server, item.message.id)
    useInbox.setState((s) => ({ items: { ...s.items, [server]: mergeItems(s.items[server] ?? [], [item]) } }))
  }
  if (type === 'chat.edited') {
    const { message } = body as Events['chat.edited']
    patchItems(server, (list) => list.map((i) => (i.message.id === message.id ? { ...i, message } : i)))
  }
  if (type === 'chat.deleted') {
    const { id } = body as Events['chat.deleted']
    patchItems(server, (list) => list.filter((i) => i.message.id !== id))
  }
})
useApp.subscribe((state, before) => {
  if (state.order === before.order) return
  const gone = before.order.filter((k) => !state.order.includes(k))
  if (!gone.length) return
  useInbox.setState((s) => ({ items: Object.fromEntries(Object.entries(s.items).filter(([k]) => !gone.includes(k))) }))
})
