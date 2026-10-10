// Pure helpers for organizing a server: grouping channels into categories, drag-and-drop targets, and how
// notification settings combine. No React or socket here, so it's easy to test.
import type { Category, Channel, NotifyLevel, NotifySetting } from '../core/protocol'

export interface ChannelLayout {
  /** Channels outside any category (shown at the top). */
  uncategorized: Channel[]
  groups: { category: Category; channels: Channel[] }[]
}

const byPosition = <T extends { position: number; id: number }>(a: T, b: T) => a.position - b.position || a.id - b.id

/** Channels in display order, under their categories. A channel whose category we don't know counts as uncategorized. */
export function layoutChannels(channels: Channel[], categories: Category[]): ChannelLayout {
  const sorted = [...channels].sort(byPosition)
  const known = new Set(categories.map((c) => c.id))
  return {
    uncategorized: sorted.filter((c) => c.categoryId == null || !known.has(c.categoryId)),
    groups: [...categories].sort(byPosition).map((category) => ({ category, channels: sorted.filter((c) => c.categoryId === category.id) })),
  }
}

/** The channels of one place in the layout (null = uncategorized), in order. */
export function channelsIn(layout: ChannelLayout, categoryId: number | null): Channel[] {
  if (categoryId === null) return layout.uncategorized
  return layout.groups.find((g) => g.category.id === categoryId)?.channels ?? []
}

export interface ChannelMove {
  categoryId: number | null
  /** Put it before this channel; null = at the end of the category. */
  before: number | null
}

/**
 * Dropping <paramref name="moving"/> on a channel row: before it, or after it when dropped on its lower half.
 * Null when nothing would change.
 */
export function dropOnChannel(layout: ChannelLayout, moving: number, target: Channel, after: boolean): ChannelMove | null {
  if (target.id === moving) return null
  const categoryId = placeOf(layout, target)
  const list = channelsIn(layout, categoryId).filter((c) => c.id !== moving)
  const index = list.findIndex((c) => c.id === target.id)
  const before = after ? list[index + 1]?.id ?? null : target.id
  return sameSpot(layout, moving, categoryId, before) ? null : { categoryId, before }
}

/** Voice and stage channels are listed together, after text channels and forums. */
export const isVoiceLike = (c: Pick<Channel, 'kind'>) => c.kind === 'voice' || c.kind === 'stage'

/** Where a channel sits in the layout: its category, or null when it's uncategorized. */
const placeOf = (layout: ChannelLayout, channel: Channel) =>
  layout.uncategorized.some((c) => c.id === channel.id) ? null : channel.categoryId ?? null

/**
 * One step up or down within its category (phones, keyboard). Null at either end. Uncategorized channels are
 * shown text first, then voice, so there they step among channels of their own kind.
 */
export function stepChannel(layout: ChannelLayout, channel: Channel, direction: -1 | 1): ChannelMove | null {
  const categoryId = placeOf(layout, channel)
  const all = channelsIn(layout, categoryId)
  const shown = categoryId === null ? all.filter((c) => isVoiceLike(c) === isVoiceLike(channel)) : all
  const index = shown.findIndex((c) => c.id === channel.id)
  if (index < 0) return null
  if (direction === -1) return index === 0 ? null : { categoryId, before: shown[index - 1].id }
  const next = shown[index + 1]
  if (!next) return null
  const rest = all.filter((c) => c.id !== channel.id)
  return { categoryId, before: rest[rest.findIndex((c) => c.id === next.id) + 1]?.id ?? null }
}

function sameSpot(layout: ChannelLayout, moving: number, categoryId: number | null, before: number | null): boolean {
  const list = channelsIn(layout, categoryId)
  const index = list.findIndex((c) => c.id === moving)
  if (index < 0) return false
  return (list[index + 1]?.id ?? null) === before
}

/** Moving a category before another (null = to the end). Null when nothing would change. */
export function stepCategory(categories: Category[], id: number, direction: -1 | 1): { before: number | null } | null {
  const list = [...categories].sort(byPosition)
  const index = list.findIndex((c) => c.id === id)
  if (index < 0) return null
  if (direction === -1) return index === 0 ? null : { before: list[index - 1].id }
  if (index === list.length - 1) return null
  return { before: list[index + 2]?.id ?? null }
}

export function dropOnCategory(categories: Category[], moving: number, target: number): { before: number | null } | null {
  if (moving === target) return null
  const list = [...categories].sort(byPosition)
  const from = list.findIndex((c) => c.id === moving)
  const to = list.findIndex((c) => c.id === target)
  // Dropped on the next one down: it goes after it, so the drag always lands where the pointer is.
  if (from >= 0 && to === from + 1) return { before: list[to + 1]?.id ?? null }
  return { before: target }
}

// ── Notification settings ───────────────────────────────────────────────────

/** Settings keyed by "server" or the channel id. */
export type NotifyMap = Record<string, NotifySetting>

export const notifyKey = (channelId: number | null) => (channelId === null ? 'server' : String(channelId))

export const DEFAULT_LEVEL: NotifyLevel = 'mentions'

export const muteActive = (setting: NotifySetting | undefined, now: number) =>
  !!setting && setting.mutedUntil !== null && (setting.mutedUntil === -1 || setting.mutedUntil > now)

export interface EffectiveNotify {
  /** What you're notified about: "all" drops to "mentions" while muted. */
  level: NotifyLevel
  /** The level as chosen (channel, else server, else the default), before muting. */
  chosen: NotifyLevel
  muted: boolean
}

/** Same rules as the server (NotifyFeature.EffectiveLevel): channel, else server, else default; muting caps at mentions. */
export function effectiveNotify(map: NotifyMap | undefined, channelId: number | null, now: number): EffectiveNotify {
  const channel = channelId === null ? undefined : map?.[notifyKey(channelId)]
  const server = map?.server
  const chosen = channel?.level ?? server?.level ?? DEFAULT_LEVEL
  const muted = muteActive(channel, now) || muteActive(server, now)
  return { level: muted && chosen === 'all' ? 'mentions' : chosen, chosen, muted }
}

/** What a channel row shows: dimmed when muted, no unread marker while muted, no mention badge at "Nothing". */
export function channelBadges(unread: number, pings: number, notify: EffectiveNotify): { unread: boolean; pings: number; dimmed: boolean } {
  return { unread: unread > 0 && !notify.muted, pings: notify.chosen === 'none' ? 0 : pings, dimmed: notify.muted }
}

/** Should this message raise a desktop notification? */
export function shouldNotify(notify: EffectiveNotify, mentionsYou: boolean): boolean {
  if (notify.chosen === 'none') return false
  return mentionsYou || notify.level === 'all'
}

/** The soonest timed mute that hasn't ended yet, so the UI can refresh when it does. */
export function nextMuteEnd(maps: NotifyMap[], now: number): number | null {
  let soonest: number | null = null
  for (const map of maps)
    for (const s of Object.values(map))
      if (s.mutedUntil !== null && s.mutedUntil > now && (soonest === null || s.mutedUntil < soonest)) soonest = s.mutedUntil
  return soonest
}

export const MUTE_CHOICES: { label: string; minutes: number }[] = [
  { label: 'For 15 minutes', minutes: 15 },
  { label: 'For 1 hour', minutes: 60 },
  { label: 'For 8 hours', minutes: 8 * 60 },
  { label: 'For 24 hours', minutes: 24 * 60 },
  { label: 'Until I turn it back on', minutes: -1 },
]

export const LEVEL_LABELS: Record<NotifyLevel, string> = { all: 'All messages', mentions: 'Only @mentions', none: 'Nothing' }

/** "Muted until 14:30", "Muted until Tue 09:00", or "Muted". */
export function muteLabel(until: number | null, now: number): string {
  if (until === null || (until !== -1 && until <= now)) return ''
  if (until === -1) return 'Muted'
  const date = new Date(until)
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const sameDay = new Date(now).toDateString() === date.toDateString()
  return sameDay ? `Muted until ${time}` : `Muted until ${date.toLocaleDateString([], { weekday: 'short' })} ${time}`
}
