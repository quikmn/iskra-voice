// Pure presence helpers (no state, no DOM), shared by state/presence.ts and the UI.
import type { ChosenStatus, CustomStatus, Member, Presence, PresenceStatus } from '../core/protocol'

export const MAX_STATUS_TEXT = 128
export const MAX_STATUS_EMOJI = 16

/** How a member looks: invisible only ever shows for yourself. */
export type ShownStatus = PresenceStatus | 'invisible'

export const STATUS_LABELS: Record<ShownStatus, string> = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'Do not disturb',
  invisible: 'Invisible',
  offline: 'Offline',
}

export const STATUS_HINTS: Record<ChosenStatus, string> = {
  online: '',
  idle: 'Also set automatically when you step away',
  dnd: 'No sounds, notifications or pushes',
  invisible: "You'll look offline, but can use Iskra as usual",
}

export type ClearAfter = '30m' | '1h' | '4h' | 'today' | 'never'

export const CLEAR_AFTER: { value: ClearAfter; label: string }[] = [
  { value: '30m', label: '30 minutes' },
  { value: '1h', label: '1 hour' },
  { value: '4h', label: '4 hours' },
  { value: 'today', label: 'Today' },
  { value: 'never', label: "Don't clear" },
]

/** When a custom status set now should clear (null: never). "Today" is the next local midnight. */
export function expiryFor(choice: ClearAfter, now: Date = new Date()): number | null {
  const t = now.getTime()
  switch (choice) {
    case '30m': return t + 30 * 60_000
    case '1h': return t + 60 * 60_000
    case '4h': return t + 4 * 60 * 60_000
    case 'today': {
      const midnight = new Date(now)
      midnight.setHours(24, 0, 0, 0)
      return midnight.getTime()
    }
    case 'never': return null
  }
}

/** A member's status; older servers only say online or not. */
export function statusOf(member: Pick<Member, 'online' | 'status'> | undefined): PresenceStatus {
  if (!member) return 'offline'
  return member.status ?? (member.online ? 'online' : 'offline')
}

/** The custom status if it's set and hasn't expired. */
export function activeCustom(custom: CustomStatus | null | undefined, now = Date.now()): CustomStatus | null {
  if (!custom || (!custom.emoji && !custom.text)) return null
  if (custom.expiresAt !== null && custom.expiresAt <= now) return null
  return custom
}

/** Trimmed and checked like the server does; null when there's nothing left to show. */
export function cleanCustom(emoji: string, text: string, expiresAt: number | null): CustomStatus | null {
  const e = emoji.trim()
  const t = text.trim().replace(/\s+/g, ' ')
  if (!e && !t) return null
  if (e.length > MAX_STATUS_EMOJI || /\s/.test(e)) throw new Error('Pick a single emoji.')
  if (t.length > MAX_STATUS_TEXT) throw new Error(`Custom statuses can be up to ${MAX_STATUS_TEXT} characters.`)
  return { emoji: e || null, text: t || null, expiresAt }
}

/** Whether a presence from elsewhere should replace ours. */
export const isNewer = (theirs: Presence | null | undefined, ours: Presence): theirs is Presence =>
  !!theirs && theirs.updatedAt > ours.updatedAt

/** One status for someone you may see on several servers: the most present one wins. */
export function bestStatus(statuses: PresenceStatus[]): PresenceStatus {
  for (const s of ['online', 'dnd', 'idle'] as const) if (statuses.includes(s)) return s
  return 'offline'
}

/** "Clears in 25 min" style hint for your own status. */
export function clearsIn(expiresAt: number | null, now = Date.now()): string | null {
  if (expiresAt === null) return null
  const minutes = Math.max(1, Math.round((expiresAt - now) / 60_000))
  if (minutes < 60) return `Clears in ${minutes} min`
  const hours = Math.round(minutes / 60)
  return `Clears in ${hours} h`
}
