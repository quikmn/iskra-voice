// Unread on servers and at Home: which conversations are on screen, a channel's counts (its threads included), the
// server and title badges, marking things read or unread, and moving to the previous or next unread channel.
// The read state itself lives in readState.ts.
import type { Channel } from '../core/protocol'
import type { ServerState } from './store'
import { activeChannelId, railHooks, selectChannel, useApp } from './store'
import { useThreads } from './threads'
import { useDms } from './dms'
import { notifyFor, useOrganize } from './organize'
import { channelBadges, layoutChannels } from './organizeLogic'
import { resetForumSeen } from './forums'
import { hasPosts } from './forumLogic'
import { senderRules } from './senderRules'
import {
  channelConv, dmConv, groupConv, markConversationRead, markConversationUnread, markReadWhere, serverPrefix, setShown, useReads,
  type ConversationRead,
} from './readState'

// ── What's on screen ────────────────────────────────────────────────────────

function syncShown(): void {
  const app = useApp.getState()
  const server = app.activeServer
  const channel = activeChannelId(app)
  setShown('channel', server && channel !== null ? channelConv(server, channel) : null)
  const thread = useThreads.getState().open
  setShown('thread', thread && thread.key === server ? channelConv(thread.key, thread.id) : null)
  const home = useDms.getState().open
  setShown('home', server !== null ? null : home.kind === 'dm' ? dmConv(home.peer) : home.kind === 'group' ? groupConv(home.key) : null)
}
useApp.subscribe(syncShown)
useThreads.subscribe(syncShown)
useDms.subscribe(syncShown)
syncShown()

// ── Counts ──────────────────────────────────────────────────────────────────

type Counts = { unread: number; mentions: number }

/** A channel row's counts: its own, plus mentions in its threads (and, for a forum, every new reply in its posts). */
export function channelCounts(serverKey: string, channel: Pick<Channel, 'id' | 'kind'>,
  convs = useReads.getState().convs, threads = useThreads.getState().threads[serverKey] ?? {}): Counts {
  const own = convs[channelConv(serverKey, channel.id)]
  let unread = own?.unread ?? 0
  let mentions = own?.mentions ?? 0
  for (const thread of Object.values(threads)) {
    if (thread.channelId !== channel.id) continue
    const r = convs[channelConv(serverKey, thread.id)]
    if (!r) continue
    mentions += r.mentions
    if (hasPosts(channel.kind)) unread += r.unread
  }
  return { unread, mentions }
}

/** channelCounts, re-rendering when read state or the server's threads change. */
export function useChannelCounts(serverKey: string, channel: Pick<Channel, 'id' | 'kind'>): Counts {
  const convs = useReads((s) => s.convs)
  const threads = useThreads((s) => s.threads[serverKey])
  return channelCounts(serverKey, channel, convs, threads ?? {})
}

/** Channels that can show unread in the sidebar (text, forums, and the chat of voice and stage channels), in sidebar order. */
function listedChannels(server: ServerState): Channel[] {
  const layout = layoutChannels(server.channels, useOrganize.getState().categories[server.key] ?? [])
  return [...layout.uncategorized, ...layout.groups.flatMap((g) => g.channels)]
}

/** What each listed channel shows once notification settings apply (muted: no dot; "Nothing": no mention badge). */
export function channelRows(server: ServerState): { id: number; unread: boolean; pings: number; count: number }[] {
  return listedChannels(server).map((c) => {
    const counts = channelCounts(server.key, c)
    const shown = channelBadges(counts.unread, counts.mentions, notifyFor(server.key, c.id))
    return { id: c.id, unread: shown.unread, pings: shown.pings, count: counts.unread }
  })
}

/** The server icon's badge and dot: the sum of what its channel rows show. */
export function serverBadges(server: ServerState): { pings: number; unread: number } {
  let pings = 0
  let unread = 0
  for (const row of channelRows(server)) {
    pings += row.pings
    if (row.unread) unread += row.count
  }
  return { pings, unread }
}

/** Unread messages in DMs and group DMs (the Home badge). */
export function homeUnread(convs: Record<string, ConversationRead> = useReads.getState().convs): number {
  let total = 0
  for (const [k, r] of Object.entries(convs)) if (k.startsWith('d:') || k.startsWith('g:')) total += r.unread
  return total
}

/** The title and taskbar count: the mention badges on server icons, plus unread DMs and group DMs. */
export function badgeTotal(): number {
  // Hidden servers stay quiet.
  return Object.values(useApp.getState().servers).reduce((n, s) => n + (railHooks.isHidden(s.key) ? 0 : serverBadges(s).pings), 0) + homeUnread()
}

// ── Marking read and unread ─────────────────────────────────────────────────

export function markChannelRead(serverKey: string, channelId: number): void {
  const threads = useThreads.getState().threads[serverKey] ?? {}
  const keys = new Set([channelId, ...Object.values(threads).filter((t) => t.channelId === channelId).map((t) => t.id)]
    .map((id) => channelConv(serverKey, id)))
  markReadWhere((k) => keys.has(k))
  const channel = useApp.getState().servers[serverKey]?.channels.find((c) => c.id === channelId)
  if (hasPosts(channel?.kind)) resetForumSeen(serverKey, channelId)
}

export function markServerRead(serverKey: string): void {
  markReadWhere((k) => k.startsWith(serverPrefix(serverKey)))
  for (const c of useApp.getState().servers[serverKey]?.channels ?? []) if (hasPosts(c.kind)) resetForumSeen(serverKey, c.id)
}

/** "Mark unread" on a message: unread from there on, counted the way arriving messages are. */
export function markUnread(serverKey: string, channelId: number, messageId: number): void {
  const server = useApp.getState().servers[serverKey]
  const message = server?.messages[channelId]?.find((m) => m.id === messageId && !m.tempId)
  if (!server || !message) return
  const counted = server.messages[channelId].filter((m) => !m.tempId && m.id >= messageId
    && m.author !== server.me?.accountKey && !senderRules.ignored(m.author))
  const mentions = counted.filter((m) => !m.forwarded && senderRules.pingsMe(server, m)).length
  markConversationUnread(channelConv(serverKey, channelId), { id: message.id, at: message.createdAt }, { unread: counted.length, mentions })
}

/** Esc: what's open is read (the channel and its threads, or the DM or group). */
export function markOpenRead(): void {
  const app = useApp.getState()
  if (app.activeServer) {
    const channel = activeChannelId(app)
    if (channel !== null) markChannelRead(app.activeServer, channel)
    const thread = useThreads.getState().open
    if (thread?.key === app.activeServer) markConversationRead(channelConv(thread.key, thread.id))
    return
  }
  const home = useDms.getState().open
  if (home.kind === 'dm') markConversationRead(dmConv(home.peer))
  if (home.kind === 'group') markConversationRead(groupConv(home.key))
}

/** Shift+Esc: the whole server, or every DM and group at Home. */
export function markAllRead(): void {
  const server = useApp.getState().activeServer
  if (server) markServerRead(server)
  else markReadWhere((k) => k.startsWith('d:') || k.startsWith('g:'))
}

// ── Moving between unread channels ──────────────────────────────────────────

/** Listed channels in sidebar order, with whether each shows something unread for you. */
export function unreadOrder(server: ServerState): { id: number; unread: boolean }[] {
  return channelRows(server).map((row) => ({ id: row.id, unread: row.unread || row.pings > 0 }))
}

/** The next unread channel after (or before) the current one, wrapping around. */
export function nextUnread(order: { id: number; unread: boolean }[], current: number | null, direction: 1 | -1): number | null {
  const n = order.length
  if (n === 0) return null
  const found = order.findIndex((c) => c.id === current)
  const base = found >= 0 ? found : direction === 1 ? -1 : 0
  for (let step = 1; step <= n; step++) {
    const at = (((base + step * direction) % n) + n) % n
    if (order[at].id !== current && order[at].unread) return order[at].id
  }
  return null
}

export function goToUnread(direction: 1 | -1): boolean {
  const state = useApp.getState()
  const server = state.activeServer ? state.servers[state.activeServer] : null
  if (!server) return false
  const target = nextUnread(unreadOrder(server), activeChannelId(state), direction)
  if (target === null) return false
  selectChannel(server.key, target)
  return true
}
