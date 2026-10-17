// Invite options and the "active invites" list (see PROTOCOL.md "invite.create").
import type { Invite, Requests } from '../core/protocol'

/** The "Never" choice in the expiry picker (admins and owners only; the server checks). */
export const NEVER = 0

const HOUR = 3600_000
const DAY = 24 * HOUR

export interface Lifetime { ms: number; hours?: number; days?: number }

export const LIFETIMES: Lifetime[] = [
  { hours: 1, ms: HOUR },
  { days: 1, ms: DAY },
  { days: 7, ms: 7 * DAY },
  { days: 30, ms: 30 * DAY },
]

/** The picker's choices: "Never" is added for admins. */
export function lifetimeChoices(admin: boolean): Lifetime[] {
  return admin ? [...LIFETIMES, { ms: NEVER }] : LIFETIMES
}

/** The `invite.create` body for the picked options (`approve`: joiners wait for a moderator). */
export function inviteRequest(lifetimeMs: number, singleUse: boolean, approve = false): Requests['invite.create'][0] {
  const maxUses = singleUse ? 1 : undefined
  const base = lifetimeMs === NEVER ? { neverExpires: true, maxUses } : { expiresInMs: lifetimeMs, maxUses }
  return approve ? { ...base, approve: true } : base
}

/** Never-expiring invites first (they're the ones that stay around), then newest first. */
export function sortInvites(invites: Invite[]): Invite[] {
  return [...invites].sort((a, b) => Number(a.expiresAt !== null) - Number(b.expiresAt !== null) || b.createdAt - a.createdAt)
}
