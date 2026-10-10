// How DM copies from many servers and devices merge into one history. A message is identified by its
// sender and the id inside its encrypted header: a peer can't reuse one of your ids to rewrite your
// messages, and nobody can rewrite their own message later by sending the same id again.

/** A sender's clock may be off by this much before we order its message by the server's time instead. */
export const MAX_CLOCK_SKEW = 10 * 60_000

export interface MergeableDm {
  id: string
  from: string
  sentAt: number
  pending?: string
  error?: string
}

export const dmKey = (m: { from: string; id: string }) => `${m.from}\n${m.id}`

/**
 * Adds a copy of a message. The first readable copy wins: later copies with the same key are ignored,
 * even with different content. A copy we can't read never hides one we can, but a readable copy
 * replaces an unreadable one (e.g. an old envelope whose prekey is gone, then the local copy).
 */
export function mergeDm<T extends MergeableDm>(list: T[], dm: T): T[] {
  const key = dmKey(dm)
  const index = list.findIndex((m) => dmKey(m) === key)
  if (index >= 0 && (!list[index].error || (dm.error && !dm.pending))) return list
  const without = index >= 0 ? list.filter((_, i) => i !== index) : list
  return [...without, dm].sort((a, b) => a.sentAt - b.sentAt || a.id.localeCompare(b.id))
}

/** The time to order a received message by: the sender's claim, unless it is far from when the server got it. */
export function orderTime(claimedSentAt: number, serverCreatedAt: number): number {
  return Math.abs(claimedSentAt - serverCreatedAt) > MAX_CLOCK_SKEW ? serverCreatedAt : claimedSentAt
}
