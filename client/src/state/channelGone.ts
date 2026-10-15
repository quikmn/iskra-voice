// Which channels a device must forget. Everything kept per channel (messages, drafts, read state, decrypted messages
// and keys, docs, boards…) is keyed by its id, so when a channel is deleted, or this member can't read it any more,
// all of it goes. A channel that comes back under an id we kept data for, with a different createdAt, is a different
// channel: what we kept is dropped too (servers never reuse ids now, but older ones did).
// Remembered per server on this device (id → createdAt), so it also works across restarts.
// No imports from other state files.

/** The parts of a channel this needs. */
export interface ChannelStamp {
  id: number
  createdAt?: number
}

/** id → createdAt (0 when the server didn't say). */
export type Stamps = Record<number, number>

export const stampsOf = (channels: ChannelStamp[]): Stamps => Object.fromEntries(channels.map((c) => [c.id, c.createdAt ?? 0]))

/**
 * Channels in `known` that `now` no longer lists (`hidden`: deleted, or not readable any more; the app can't tell
 * which), and ones listed under a different createdAt (`replaced`: another channel with that id).
 */
export function classifyGone(known: Stamps, now: ChannelStamp[]): { hidden: number[]; replaced: number[] } {
  const listed = new Map(now.map((c) => [c.id, c.createdAt ?? 0]))
  const hidden: number[] = []
  const replaced: number[] = []
  for (const [raw, was] of Object.entries(known)) {
    const id = Number(raw)
    const is = listed.get(id)
    if (is === undefined) hidden.push(id)
    else if (was !== 0 && is !== 0 && was !== is) replaced.push(id)
  }
  return { hidden, replaced }
}

/** Every channel in `known` whose cached content must go (hidden or replaced). */
export function goneChannels(known: Stamps, now: ChannelStamp[]): number[] {
  const { hidden, replaced } = classifyGone(known, now)
  return [...hidden, ...replaced]
}

const KEY = 'iskra.channelStamps'

function loadAll(): Record<string, Stamps> {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, Stamps>) : {}
  } catch {
    return {}
  }
}

let all: Record<string, Stamps> | null = null

/** What this device last saw of a server's channels (null: never, e.g. right after an update). */
export function knownStamps(serverKey: string): Stamps | null {
  all ??= loadAll()
  return all[serverKey] ?? null
}

export function rememberStamps(serverKey: string, channels: ChannelStamp[]): void {
  all ??= loadAll()
  all[serverKey] = stampsOf(channels)
  try {
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    /* private mode or full: this session still knows */
  }
}

export function forgetStamps(serverKey: string): void {
  all ??= loadAll()
  delete all[serverKey]
  try {
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    /* private mode */
  }
}

/** Tests start from nothing. */
export function resetStampsForTests(): void {
  all = {}
}

/** A record keyed `${serverKey}:${channelId}` without those channels (the same object when none were there). */
export function withoutChannels<T>(record: Record<string, T>, serverKey: string, channelIds: number[]): Record<string, T> {
  const drop = new Set(channelIds.map((id) => `${serverKey}:${id}`))
  if (!Object.keys(record).some((k) => drop.has(k))) return record
  return Object.fromEntries(Object.entries(record).filter(([k]) => !drop.has(k)))
}
