// Pure presence helpers (no state, no DOM), shared by state/presence.ts and the UI.
import type { ChosenStatus, CustomStatus, Member, Presence, PresenceStatus } from '../core/protocol'
import { t } from '../i18n'

export const MAX_STATUS_TEXT = 128
export const MAX_STATUS_EMOJI = 16

/** How a member looks: invisible only ever shows for yourself. */
export type ShownStatus = PresenceStatus | 'invisible'

/** Read at render time: each label is translated when it's looked up. */
export const STATUS_LABELS: Readonly<Record<ShownStatus, string>> = {
  get online() { return t('presence.status.online') },
  get idle() { return t('presence.status.idle') },
  get dnd() { return t('presence.status.dnd') },
  get invisible() { return t('presence.status.invisible') },
  get offline() { return t('presence.status.offline') },
}

export const STATUS_HINTS: Readonly<Record<ChosenStatus, string>> = {
  online: '',
  get idle() { return t('presence.hints.idle') },
  get dnd() { return t('presence.hints.dnd') },
  get invisible() { return t('presence.hints.invisible') },
}

export type ClearAfter = '30m' | '1h' | '4h' | 'today' | 'never'

export const CLEAR_AFTER: readonly { readonly value: ClearAfter; readonly label: string }[] = [
  { value: '30m', get label() { return t('presence.clearAfter.30m') } },
  { value: '1h', get label() { return t('presence.clearAfter.1h') } },
  { value: '4h', get label() { return t('presence.clearAfter.4h') } },
  { value: 'today', get label() { return t('presence.clearAfter.today') } },
  { value: 'never', get label() { return t('presence.clearAfter.never') } },
]

/** When a custom status set now should clear (null: never). "Today" is the next local midnight. */
export function expiryFor(choice: ClearAfter, now: Date = new Date()): number | null {
  const at = now.getTime()
  switch (choice) {
    case '30m': return at + 30 * 60_000
    case '1h': return at + 60 * 60_000
    case '4h': return at + 4 * 60 * 60_000
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
  const clean = text.trim().replace(/\s+/g, ' ')
  if (!e && !clean) return null
  if (e.length > MAX_STATUS_EMOJI || /\s/.test(e)) throw new Error(t('presence.errors.singleEmoji'))
  if (clean.length > MAX_STATUS_TEXT) throw new Error(t('presence.errors.tooLong', { max: MAX_STATUS_TEXT }))
  return { emoji: e || null, text: clean || null, expiresAt }
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
  if (minutes < 60) return t('presence.clearsInMinutes', { minutes })
  const hours = Math.round(minutes / 60)
  return t('presence.clearsInHours', { hours })
}
