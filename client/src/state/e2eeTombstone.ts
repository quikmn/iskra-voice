// What an encrypted channel leaves on a device when it stops being listed. The app can't tell a deleted channel from
// one it may no longer read (a role or override taken away), and a channel's chain, keys and older chains can't be
// fetched again (the server forgets them on a start-over), nor may a pinned chain be given up: the server could hide
// a channel once and then offer a different chain from scratch. So plaintext goes at once, and the rest stays as a
// tombstone until the channel is listed again (the same createdAt: used again), turns out to be another channel (a
// different createdAt: wiped), or 30 days pass (wiped). No imports from other state files.

export const TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1000

export interface Hidden {
  /** When the channel stopped being listed. */
  at: number
  /** Its createdAt then (0: unknown). */
  createdAt: number
}

interface Kept {
  createdAt?: number
  hidden?: Hidden
  messages?: { text: string }[]
}

/**
 * What to do with what's kept for a channel when it's loaded: `use` it, `lift` its tombstone (listed again), `wait`
 * (a tombstone, still not listed: use nothing), or `wipe` it (another channel under that id, or too old).
 */
export function loadVerdict(stored: Kept | undefined, listed: { createdAt?: number } | null, now: number): 'use' | 'lift' | 'wait' | 'wipe' {
  if (!stored) return 'use'
  if (stored.hidden && now - stored.hidden.at > TOMBSTONE_MS) return 'wipe'
  const was = stored.hidden?.createdAt || stored.createdAt || 0
  const is = listed?.createdAt ?? 0
  if (listed && was !== 0 && is !== 0 && was !== is) return 'wipe'
  if (stored.hidden) return listed ? 'lift' : 'wait'
  return 'use'
}

/** The tombstone of what's kept: every message's text is dropped (what was seen of it stays), the rest is kept. */
export function hideStored<T extends Kept>(stored: T, now: number, createdAt: number): T & { hidden: Hidden } {
  return {
    ...stored,
    messages: (stored.messages ?? []).map((m) => ({ ...m, text: '' })),
    hidden: stored.hidden ?? { at: now, createdAt: stored.createdAt || createdAt || 0 },
  }
}

/** Tombstones (slot → since when) old enough to wipe. */
export const tombstonesToWipe = (all: Record<string, number>, now: number): string[] =>
  Object.entries(all).filter(([, at]) => now - at > TOMBSTONE_MS).map(([slot]) => slot)
