// The quiet hours digest, the pure part: when a quiet stretch began and ended, and what came in during it, gathered
// across every server on this device ("While it was quiet"). The server sends its own summary push for devices that
// aren't open (see "Quiet hours digest" in PROTOCOL.md); this is the card for the ones that are.
import type { InboxItem, QuietHours, ServerEvent } from '../core/protocol'
import { quietActive } from './alertsLogic'

const MINUTE = 60_000
/** How far back a stretch can reach (an all-week schedule never ends on its own). Same as the server. */
export const MAX_STRETCH = 7 * 24 * 60 * MINUTE
/** Events starting this soon after quiet hours end count as "starting soon". Same as the server. */
export const SOON = 60 * MINUTE
/** A card for a stretch that ended longer ago than this (the device was off) isn't shown. */
export const STALE_AFTER = 24 * 60 * MINUTE
/** Items listed per kind; the counts cover everything. */
export const TOP = 3

export interface DigestWindow {
  start: number
  end: number
}

/** When the quiet stretch running at `at` began, to the minute, at most a week back. Same rule as the server's StretchStart. */
export function stretchStart(quiet: QuietHours, at: number): number {
  let t = at - (at % MINUTE)
  const limit = at - MAX_STRETCH
  const coarse = 15 * MINUTE
  while (t - coarse >= limit && quietActive(quiet, new Date(t - coarse))) t -= coarse
  for (let i = 0; i < 15 && t - MINUTE >= limit && quietActive(quiet, new Date(t - MINUTE)); i++) t -= MINUTE
  return t
}

/** When a stretch that began at `start` ended by the schedule (at most `now`). */
export function stretchEnd(quiet: QuietHours, start: number, now: number): number {
  let t = start - (start % MINUTE)
  const coarse = 15 * MINUTE
  while (t + coarse <= now && quietActive(quiet, new Date(t + coarse))) t += coarse
  while (t + MINUTE <= now && quietActive(quiet, new Date(t + MINUTE))) t += MINUTE
  return Math.min(now, t + MINUTE)
}

/** The running stretch as this device saw it: when it began, and when the device last saw it running. */
export interface QuietWatch {
  since: number
  seen: number
}

/**
 * One step of the watcher: the running stretch to remember (null outside one), and the window of a stretch that just
 * ended (if any). `on`: quiet hours are turned on; turning them off ends a running stretch. Watching (seen within the
 * last two minutes), the end is now; after a gap (the device was off) it's when the schedule ended it.
 */
export function advance(on: boolean, quiet: QuietHours, watch: QuietWatch | null, now: number): { watch: QuietWatch | null; ended: DigestWindow | null } {
  if (on && quietActive(quiet, new Date(now))) return { watch: { since: watch?.since ?? stretchStart(quiet, now), seen: now }, ended: null }
  if (!watch) return { watch: null, ended: null }
  const end = now - watch.seen < 2 * MINUTE ? now : Math.max(watch.seen, on ? stretchEnd(quiet, watch.since, now) : watch.seen)
  if (now - end > STALE_AFTER) return { watch: null, ended: null }
  return { watch: null, ended: { start: watch.since, end } }
}

// ── What came in ────────────────────────────────────────────────────────────

export type DigestKind = 'mentions' | 'messages' | 'keywords' | 'follows' | 'events' | 'reminders'
export const DIGEST_KINDS: readonly DigestKind[] = ['mentions', 'messages', 'keywords', 'follows', 'events', 'reminders']

export type DigestItem =
  | { type: 'ping'; key: string; server: string; channelId: number; messageId: number; author: string; kind: InboxItem['kind']; at: number }
  | { type: 'dm'; key: string; peer: string; count: number; at: number }
  | { type: 'group'; key: string; group: string; count: number; at: number }
  | { type: 'event'; key: string; server: string; eventId: number; title: string; at: number; started: boolean }
  | { type: 'reminder'; key: string; server: string; id: number; at: number }

export interface DigestSection {
  kind: DigestKind
  count: number
  /** The newest few (events: the soonest). */
  items: DigestItem[]
}

export interface DigestServer {
  key: string
  name: string
  online: boolean
}

export interface Digest {
  total: number
  sections: DigestSection[]
  /** Servers that couldn't be asked (offline): their items may be missing. */
  offline: DigestServer[]
}

/** A conversation's messages, as far as the digest needs them (counts and who; never the text). */
export interface DigestMessage {
  from: string
  sentAt: number
}

export interface DigestSources {
  window: DigestWindow
  /** Your account key (your own messages don't count). */
  me: string
  servers: DigestServer[]
  pings: { server: string; item: InboxItem }[]
  dms: { peer: string; messages: DigestMessage[] }[]
  groups: { key: string; messages: DigestMessage[] }[]
  events: { server: string; event: ServerEvent }[]
  reminders: { server: string; id: number; firedAt: number }[]
  /** People you blocked (or who blocked you, as far as the app knows): never counted. */
  blocked?: (accountKey: string) => boolean
}

const PING_KIND: Record<InboxItem['kind'], DigestKind> = {
  mention: 'mentions', reply: 'mentions', role: 'mentions', everyone: 'mentions', keyword: 'keywords', follow: 'follows',
}

/** What came in during the window, per kind, across every server (the same counting rules as the server's push). */
export function buildDigest(src: DigestSources): Digest {
  const { start, end } = src.window
  const inWindow = (at: number) => at >= start && at < end
  const blocked = src.blocked ?? (() => false)
  const known = new Set(src.servers.map((s) => s.key))
  const buckets = new Map<DigestKind, { count: number; items: DigestItem[] }>(DIGEST_KINDS.map((k) => [k, { count: 0, items: [] }]))
  const add = (kind: DigestKind, item: DigestItem, count = 1) => {
    const b = buckets.get(kind)!
    b.count += count
    b.items.push(item)
  }

  const seen = new Set<string>()
  for (const { server, item } of src.pings) {
    const key = `p:${server}:${item.message.id}`
    if (!known.has(server) || seen.has(key) || !inWindow(item.at) || blocked(item.message.author)) continue
    seen.add(key)
    add(PING_KIND[item.kind] ?? 'mentions', {
      type: 'ping', key, server, channelId: item.channelId, messageId: item.message.id, author: item.message.author, kind: item.kind, at: item.at,
    })
  }
  for (const { peer, messages } of src.dms) {
    if (blocked(peer)) continue
    const mine = messages.filter((m) => m.from !== src.me && inWindow(m.sentAt))
    if (mine.length) add('messages', { type: 'dm', key: `d:${peer}`, peer, count: mine.length, at: Math.max(...mine.map((m) => m.sentAt)) }, mine.length)
  }
  for (const { key, messages } of src.groups) {
    const mine = messages.filter((m) => m.from !== src.me && !blocked(m.from) && inWindow(m.sentAt))
    if (mine.length) add('messages', { type: 'group', key: `g:${key}`, group: key, count: mine.length, at: Math.max(...mine.map((m) => m.sentAt)) }, mine.length)
  }
  for (const { server, event } of src.events) {
    if (!known.has(server) || event.status === 'cancelled' || !event.interested.includes(src.me)) continue
    if (event.startAt < start || event.startAt >= end + SOON) continue
    add('events', { type: 'event', key: `e:${server}:${event.id}`, server, eventId: event.id, title: event.title, at: event.startAt, started: event.startAt < end })
  }
  for (const r of src.reminders) {
    if (known.has(r.server) && inWindow(r.firedAt)) add('reminders', { type: 'reminder', key: `r:${r.server}:${r.id}`, server: r.server, id: r.id, at: r.firedAt })
  }

  const sections: DigestSection[] = []
  let total = 0
  for (const kind of DIGEST_KINDS) {
    const b = buckets.get(kind)!
    if (b.count === 0) continue
    total += b.count
    const order = kind === 'events' ? (a: DigestItem, z: DigestItem) => a.at - z.at : (a: DigestItem, z: DigestItem) => z.at - a.at
    sections.push({ kind, count: b.count, items: b.items.sort(order).slice(0, TOP) })
  }
  return { total, sections, offline: src.servers.filter((s) => !s.online) }
}

/** Has this stretch's card been dismissed (here or on another device)? The dismissal records the end it saw. */
export const digestSeen = (window: DigestWindow, seenUntil: number): boolean => seenUntil > window.start
