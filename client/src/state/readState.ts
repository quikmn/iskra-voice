// Read state: one record per conversation (channel, thread, DM, group DM). Every unread badge, mention count, the
// "New messages" divider, the jump bar, the unread shortcuts and the title/taskbar count derive from it.
// Kept on this device (the server doesn't track what you've read). No imports from other state files, so any of
// them can feed it; state/unread.ts tells it which conversations are on screen.
import { create } from 'zustand'

/** A message by id and time (channel ids are numbers, DM and group ids strings). */
export interface MessageRef {
  id: number | string
  at: number
}

export interface ConversationRead {
  /** Unread messages (the dot and the count). */
  unread: number
  /** Unread messages that mention you. */
  mentions: number
  /** The oldest unread message: where "new" starts. Null once read. */
  from: MessageRef | null
  /** While it's on screen: where the "New messages" divider sits and how many were new when you got there. */
  divider: { from: MessageRef; count: number } | null
  /** Marked unread while on screen: it stays unread until you leave it or mark it read. */
  held: boolean
}

export const NOTHING_UNREAD: ConversationRead = { unread: 0, mentions: 0, from: null, divider: null, held: false }

export const channelConv = (serverKey: string, channelId: number) => `c:${serverKey}:${channelId}`
export const dmConv = (peer: string) => `d:${peer}`
export const groupConv = (key: string) => `g:${key}`
export const serverPrefix = (serverKey: string) => `c:${serverKey}:`

// ── Transitions (pure) ──────────────────────────────────────────────────────

/** A message from someone else arrived; it's read straight away if you're looking at the conversation. */
export function arrive(r: ConversationRead, message: MessageRef, mention: boolean, onScreen: boolean): ConversationRead {
  if (onScreen && !r.held) return r
  return { ...r, unread: r.unread + 1, mentions: r.mentions + (mention ? 1 : 0), from: r.from ?? message }
}

/** You're looking at it now: what was unread becomes read, and the divider marks where it started. */
export function see(r: ConversationRead): ConversationRead {
  if (r.held || (r.unread === 0 && r.mentions === 0)) return r
  const divider = !r.from ? r.divider : r.divider ? { ...r.divider, count: r.divider.count + r.unread } : { from: r.from, count: r.unread }
  return { ...r, unread: 0, mentions: 0, from: null, divider }
}

/** You moved somewhere else: the divider goes, and a conversation marked unread stays unread. */
export function leave(r: ConversationRead): ConversationRead {
  return r.divider || r.held ? { ...r, divider: null, held: false } : r
}

/** "Mark unread" on a message: unread from there on (at least that message), with the divider there if it's on screen. */
export function unreadFrom(message: MessageRef, counts: { unread: number; mentions: number }, onScreen: boolean): ConversationRead {
  return { unread: Math.max(1, counts.unread), mentions: counts.mentions, from: message, divider: null, held: onScreen }
}

/** Where the divider is and how many messages it counts (null: no divider). */
export function dividerOf(r: ConversationRead): { from: MessageRef; count: number } | null {
  if (r.held && r.from) return { from: r.from, count: r.unread }
  return r.divider
}

/** The first message (in a list, oldest first) the divider goes above: the marked one, or the first one after it. */
export function dividerTarget<T>(list: T[], from: MessageRef, ref: (m: T) => MessageRef | null): T | null {
  for (const m of list) {
    const r = ref(m)
    if (!r) continue
    if (r.id === from.id) return m
    if (typeof r.id === 'number' && typeof from.id === 'number' ? r.id > from.id : r.at > from.at) return m
  }
  return null
}

const isRead = (r: ConversationRead) => r.unread === 0 && r.mentions === 0 && !r.from && !r.divider && !r.held

// ── The store ───────────────────────────────────────────────────────────────

interface ReadStore {
  convs: Record<string, ConversationRead>
  /** Conversations on screen (the open channel, the thread panel, the open DM or group). */
  shown: string[]
}

export const useReads = create<ReadStore>(() => ({ convs: {}, shown: [] }))

const focused = () => typeof document !== 'undefined' && document.hasFocus()

export const readOf = (conv: string): ConversationRead => useReads.getState().convs[conv] ?? NOTHING_UNREAD

export const useRead = (conv: string): ConversationRead => useReads((s) => s.convs[conv]) ?? NOTHING_UNREAD

/** On screen and the window has focus: new messages there are read as they arrive. */
export const isOnScreen = (conv: string): boolean => useReads.getState().shown.includes(conv) && focused()

function patch(conv: string, next: (r: ConversationRead) => ConversationRead): void {
  useReads.setState((s) => {
    const current = s.convs[conv] ?? NOTHING_UNREAD
    const updated = next(current)
    if (updated === current) return s
    const convs = { ...s.convs }
    if (isRead(updated)) delete convs[conv]
    else convs[conv] = updated
    return { convs }
  })
}

export function noteMessage(conv: string, message: MessageRef, mention: boolean): void {
  patch(conv, (r) => arrive(r, message, mention, isOnScreen(conv)))
}

/** Opened on purpose (even without window focus, e.g. from a notification): what's unread there is read now. */
export function seeConversation(conv: string): void {
  patch(conv, see)
}

export function markConversationRead(conv: string): void {
  patch(conv, () => NOTHING_UNREAD)
}

export function markReadWhere(test: (conv: string) => boolean): void {
  useReads.setState((s) => ({ convs: Object.fromEntries(Object.entries(s.convs).filter(([k]) => !test(k))) }))
}

export function markConversationUnread(conv: string, message: MessageRef, counts: { unread: number; mentions: number }): void {
  patch(conv, () => unreadFrom(message, counts, useReads.getState().shown.includes(conv)))
}

/** A conversation that's gone (a deleted thread, a removed group). */
export const forgetConversation = markConversationRead

/** A DM conversation moved to someone's new account key: its unread counts move along. */
export function moveConversation(from: string, to: string): void {
  if (from === to) return
  const old = useReads.getState().convs[from]
  if (!old) return
  markConversationRead(from)
  patch(to, (r) => ({ ...r, unread: r.unread + old.unread, mentions: r.mentions + old.mentions, from: r.from ?? old.from }))
}

const sources: Record<string, string | null> = {}

/** What a part of the screen shows: opening a conversation reads it, leaving it drops its divider. */
export function setShown(source: string, conv: string | null): void {
  if (sources[source] === conv) return
  sources[source] = conv
  const before = useReads.getState().shown
  const now = [...new Set(Object.values(sources).filter((c): c is string => !!c))]
  useReads.setState({ shown: now })
  for (const c of before) if (!now.includes(c)) patch(c, leave)
  for (const c of now) if (!before.includes(c)) patch(c, see)
}

// Coming back to the window reads what arrived on screen while you were away.
if (typeof window !== 'undefined') {
  window.addEventListener('focus', () => {
    for (const c of useReads.getState().shown) patch(c, see)
  })
}
