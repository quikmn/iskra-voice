// Unread navigation: the "New messages" divider (where you left off when you opened a channel), marking channels
// and servers read, and moving to the previous or next unread channel.
import { create } from 'zustand'
import type { PendingMessage, ServerState } from './store'
import { activeChannelId, patchServer, selectChannel, useApp } from './store'
import { threadMentions, useThreads } from './threads'
import { notifyFor, useOrganize } from './organize'
import { channelBadges, layoutChannels } from './organizeLogic'

export interface UnreadMarker {
  /** How many messages were new when you opened the channel. */
  count: number
  /** The newest message then (the count is of messages up to it). */
  anchorId: number | null
  /** The first new message, once it's loaded. */
  firstId: number | null
  since: number | null
}

export const useUnread = create<{ markers: Record<string, UnreadMarker> }>(() => ({ markers: {} }))

export const markerKey = (serverKey: string, channelId: number) => `${serverKey}:${channelId}`

export const useUnreadMarker = (serverKey: string, channelId: number) => useUnread((s) => s.markers[markerKey(serverKey, channelId)])

/** Finds the first new message in what's loaded (null if older messages still need loading). */
export function resolveMarker(marker: UnreadMarker, list: PendingMessage[] | undefined, hasMore: boolean): UnreadMarker {
  if (marker.firstId !== null || !list) return marker
  const confirmed = list.filter((m) => !m.tempId)
  const anchorId = marker.anchorId ?? confirmed.at(-1)?.id ?? null
  if (anchorId === null) return marker
  const upTo = confirmed.filter((m) => m.id <= anchorId)
  const first = upTo.length >= marker.count ? upTo[upTo.length - marker.count] : hasMore ? undefined : upTo[0]
  return { ...marker, anchorId, firstId: first?.id ?? null, since: first ? first.createdAt : marker.since }
}

function setMarker(key: string, marker: UnreadMarker | null): void {
  useUnread.setState((s) => {
    const markers = { ...s.markers }
    if (marker) markers[key] = marker
    else delete markers[key]
    return { markers }
  })
}

// Watches which channel is open: opening one with unread messages leaves a marker; leaving it clears it.
let viewing: { server: string; channel: number } | null = null
useApp.subscribe((state) => {
  const server = state.activeServer
  const channel = activeChannelId(state)
  const current = server && channel !== null ? { server, channel } : null
  if (current?.server !== viewing?.server || current?.channel !== viewing?.channel) {
    if (viewing) setMarker(markerKey(viewing.server, viewing.channel), null)
    viewing = current
    if (current) {
      const s = state.servers[current.server]
      const count = s?.unread[current.channel] ?? 0
      if (count > 0) {
        const list = s.messages[current.channel]
        setMarker(markerKey(current.server, current.channel),
          resolveMarker({ count, anchorId: list ? list.filter((m) => !m.tempId).at(-1)?.id ?? null : null, firstId: null, since: null }, list, !!s.hasMore[current.channel]))
      }
    }
  }
  // Resolve the open channel's marker as its history loads.
  if (current) {
    const key = markerKey(current.server, current.channel)
    const marker = useUnread.getState().markers[key]
    const s = state.servers[current.server]
    if (marker && marker.firstId === null && s) {
      const next = resolveMarker(marker, s.messages[current.channel], !!s.hasMore[current.channel])
      if (next !== marker) setMarker(key, next)
    }
  }
})

// ── Marking read ────────────────────────────────────────────────────────────

export function markChannelRead(serverKey: string, channelId: number): void {
  const threads = useThreads.getState().threads[serverKey] ?? {}
  const ids = [channelId, ...Object.values(threads).filter((t) => t.channelId === channelId).map((t) => t.id)]
  patchServer(serverKey, (s) => ({
    unread: { ...s.unread, ...Object.fromEntries(ids.map((id) => [id, 0])) },
    mentions: { ...s.mentions, ...Object.fromEntries(ids.map((id) => [id, 0])) },
  }))
  setMarker(markerKey(serverKey, channelId), null)
}

export function markServerRead(serverKey: string): void {
  patchServer(serverKey, () => ({ unread: {}, mentions: {} }))
  useUnread.setState((s) => ({ markers: Object.fromEntries(Object.entries(s.markers).filter(([k]) => !k.startsWith(`${serverKey}:`))) }))
}

// ── Moving between unread channels ──────────────────────────────────────────

/** Text channels in sidebar order, with whether each has something unread for you. */
export function unreadOrder(server: ServerState): { id: number; unread: boolean }[] {
  const layout = layoutChannels(server.channels, useOrganize.getState().categories[server.key] ?? [])
  const ordered = [...layout.uncategorized, ...layout.groups.flatMap((g) => g.channels)].filter((c) => c.kind === 'text')
  return ordered.map((c) => {
    const shown = channelBadges(server.unread[c.id] ?? 0, (server.mentions[c.id] ?? 0) + threadMentions(server, c.id), notifyFor(server.key, c.id))
    return { id: c.id, unread: shown.unread || shown.pings > 0 }
  })
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
