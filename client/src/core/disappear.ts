// Disappearing messages (PROTOCOL.md "Disappearing messages"): the timers, and when a message disappears on this device.
// Shared by the app and the bot SDK, so no DOM here.

/** The timers apps offer, in seconds: off, 5 minutes, 1 hour, 8 hours, 1 day, 7 days, 4 weeks. */
export const DISAPPEAR_TIMERS = [0, 300, 3600, 28800, 86400, 604800, 2419200] as const

/** A timer that makes messages disappear (not "off"). */
export const isExpiry = (n: unknown): n is number => typeof n === 'number' && n > 0 && (DISAPPEAR_TIMERS as readonly number[]).includes(n)

/** A timer value, "off" included. */
export const isTimer = (n: unknown): n is number => n === 0 || isExpiry(n)

/**
 * When a message disappears on this device: the sooner of what the server says (`expiresAt`) and what the sender's
 * signed header says (`expires` seconds after it was sent; the earlier of its signed `sentAt` and the server's
 * `createdAt`, so neither clock can stretch it). Undefined: it doesn't disappear.
 */
export function localExpiry(serverExpiresAt: number | null | undefined, signed?: { sentAt: number; expires?: number }, createdAt?: number): number | undefined {
  const times: number[] = []
  if (typeof serverExpiresAt === 'number' && Number.isFinite(serverExpiresAt)) times.push(serverExpiresAt)
  if (signed && isExpiry(signed.expires)) {
    const sent = typeof createdAt === 'number' && Number.isFinite(createdAt) ? Math.min(signed.sentAt, createdAt) : signed.sentAt
    times.push(sent + signed.expires * 1000)
  }
  return times.length ? Math.min(...times) : undefined
}

/**
 * The timer a conversation sends with: the stricter (shorter, not off) of what its servers say and the newest timer change
 * line this device read in it (signed by whoever changed it), so a server can't quietly turn it off.
 */
export function effectiveTimer(server: (number | undefined)[], inBand: number | undefined): number {
  const on = [...server, inBand].filter(isExpiry)
  return on.length ? Math.min(...on) : 0
}
