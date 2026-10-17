// "While it was quiet": when quiet hours end on this device (the schedule ends, or they're turned off), a card sums up
// what came in meanwhile across every server here. The stretch is watched on the device (it works without push and in
// encrypted channels and DMs); dismissing the card records it in the synced alert settings, so it closes on your other
// devices too. Counting rules: quietDigestLogic.ts.
import { create } from 'zustand'
import { b64u } from '../core/crypto'
import { updateAlerts, useAlerts } from './alerts'
import { withAlertHits } from './inboxLogic'
import { useInbox } from './inbox'
import { useDms } from './dms'
import { useGroups } from './groups'
import { useEvents } from './events'
import { useReminders } from './reminders'
import { isBlocked, useBlocks } from './moderation'
import { useApp } from './store'
import { advance, buildDigest, digestSeen, STALE_AFTER, type Digest, type DigestWindow, type QuietWatch } from './quietDigestLogic'

const WATCH_KEY = 'iskra.quietDigest.watch'
const CARD_KEY = 'iskra.quietDigest.card'

interface QuietDigestState {
  /** The stretch whose card is up (or waiting for something to show), or null. */
  window: DigestWindow | null
}

function read<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') as T | null
  } catch {
    return null
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* private mode */
  }
}

/** A card kept from before (not yet dismissed), unless it's from long ago. */
const keptWindow = (w: DigestWindow | null): DigestWindow | null =>
  w && typeof w.start === 'number' && typeof w.end === 'number' && w.end >= w.start && Date.now() - w.end < STALE_AFTER ? { start: w.start, end: w.end } : null

export const useQuietDigest = create<QuietDigestState>(() => ({ window: keptWindow(read<DigestWindow>(CARD_KEY)) }))

function setWindow(stretch: DigestWindow | null): void {
  useQuietDigest.setState({ window: stretch })
  write(CARD_KEY, stretch)
}

/** Checks whether quiet hours began or ended (every half minute, and whenever the settings change). */
export function checkQuietDigest(now = Date.now()): void {
  const { quietOn, quiet, digestSeen: seenUntil } = useAlerts.getState().settings
  const before = read<QuietWatch>(WATCH_KEY)
  const watch = before && typeof before.since === 'number' && typeof before.seen === 'number' ? before : null
  const step = advance(quietOn, quiet, watch, now)
  write(WATCH_KEY, step.watch)
  if (step.ended && quiet.digest !== false && !digestSeen(step.ended, seenUntil)) setWindow(step.ended)
  // A new stretch began: an old card that was never dismissed goes.
  if (step.watch && !watch && useQuietDigest.getState().window) setWindow(null)
}

/** Closes the card here and, through the synced settings, on your other devices. */
export function dismissQuietDigest(): void {
  const stretch = useQuietDigest.getState().window
  setWindow(null)
  if (stretch && useAlerts.getState().settings.digestSeen < stretch.end) updateAlerts({ digestSeen: stretch.end })
}

// Dismissed on another device, or the summary turned off: the card goes here too.
useAlerts.subscribe((state, prev) => {
  if (state.settings === prev.settings) return
  const stretch = useQuietDigest.getState().window
  if (stretch && (digestSeen(stretch, state.settings.digestSeen) || state.settings.quiet.digest === false)) setWindow(null)
  checkQuietDigest()
})

if (typeof window !== 'undefined') {
  checkQuietDigest()
  setInterval(() => checkQuietDigest(), 30_000)
}

// ── The digest ──────────────────────────────────────────────────────────────

/** What came in during the card's stretch, across every server here (null: no card). Re-renders as things load. */
export function useDigest(): Digest | null {
  const stretch = useQuietDigest((s) => s.window)
  const servers = useApp((s) => s.servers)
  const order = useApp((s) => s.order)
  const identity = useApp((s) => s.identity)
  const items = useInbox((s) => s.items)
  const hits = useAlerts((s) => s.hits)
  const conversations = useDms((s) => s.conversations)
  const groups = useGroups((s) => s.groups)
  const events = useEvents((s) => s.events)
  const reminders = useReminders((s) => s.all)
  const blocks = useBlocks((s) => s.entries)
  if (!stretch || !identity) return null
  return buildDigest({
    window: stretch,
    me: b64u(identity.account.publicKey),
    servers: order.filter((k) => servers[k]).map((k) => ({ key: k, name: servers[k].name, online: servers[k].status.state === 'online' })),
    pings: Object.entries(withAlertHits(items, hits)).flatMap(([server, list]) => list.map((item) => ({ server, item }))),
    dms: Object.entries(conversations).map(([peer, c]) => ({ peer, messages: c.messages.filter((m) => !m.notice && !m.friend && !m.error) })),
    groups: Object.values(groups).map((g) => ({ key: g.key, messages: g.messages.filter((m) => !m.group && !m.error) })),
    events: Object.entries(events).flatMap(([server, byId]) => Object.values(byId).map((event) => ({ server, event }))),
    reminders: Object.values(reminders).filter((r) => r.firedAt !== null).map((r) => ({ server: r.server, id: r.id, firedAt: r.firedAt! })),
    blocked: (key) => isBlocked(blocks, key),
  })
}
