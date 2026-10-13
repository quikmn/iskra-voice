// What this device remembers about each message of an encrypted channel, to catch a server that replays an envelope
// under another message, moves an edit to another message, or serves an edited message's older text again (security
// review L13). The signature binds the channel and thread (core/channelChain.ts); these checks need memory, so they live
// here. No network or store, so it's easy to test.
import { MOVED, type ChannelHeader } from '../core/channelChain'

export const REPLAYED = 'This message is a copy of an earlier one.'
export const ROLLED_BACK = 'The server showed an older version of this message.'

/** Envelope ids kept per message (its first envelope and its edits). */
const MAX_IDS = 20

/** What a message's envelopes said so far (kept with the local copy). */
export interface Seen {
  /** Ids of every envelope seen for this message (first and edits). */
  hids?: string[]
  /** v2: the id of the message's first envelope (an edit names it). */
  origin?: string
  /** The newest envelope seen: its id, its signed time, whether it was a v2 edit, and whether it was the older format. */
  last?: string
  sentAt?: number
  edited?: boolean
  legacy?: boolean
}

type Header = Pick<ChannelHeader, 'id' | 'sentAt' | 'edit'>

/**
 * Why an envelope can't be shown for message `messageId` (null: it can). `owner(id)` is the message an envelope id (or a
 * v2 origin) already belongs to on this device.
 */
export function checkSeen(seen: Seen | undefined, owner: (hid: string) => number | undefined, messageId: number, header: Header, legacy: boolean): string | null {
  const other = (hid: string | undefined) => {
    if (!hid) return false
    const at = owner(hid)
    return at !== undefined && at !== messageId
  }
  if (other(header.id)) return REPLAYED
  if (!legacy) {
    if (other(header.edit)) return MOVED
    const origin = header.edit ?? header.id
    if (seen?.origin && seen.origin !== origin) return MOVED
  }
  if (seen?.last && header.id !== seen.last) {
    // An envelope replaced since, an original after an edit, or an older edit after a newer one. Between formats only
    // the time counts.
    if ((seen.hids ?? []).includes(header.id)) return ROLLED_BACK
    const both = !legacy && seen.legacy === false
    const older = both && !!seen.edited !== !!header.edit ? !header.edit : header.sentAt < (seen.sentAt ?? 0)
    if (older) return ROLLED_BACK
  }
  return null
}

/** The bookkeeping after an envelope passed {@link checkSeen} and was shown (it is now the newest). */
export function noteSeen(seen: Seen | undefined, header: Header, legacy: boolean): Seen {
  const hids = [...(seen?.hids ?? []).filter((h) => h !== header.id), header.id].slice(-MAX_IDS)
  const origin = seen?.origin ?? (legacy ? undefined : header.edit ?? header.id)
  return { hids, ...(origin ? { origin } : {}), last: header.id, sentAt: header.sentAt, edited: !!header.edit, legacy }
}

/** The message each envelope id (and v2 origin) belongs to. */
export function seenIndex(messages: Iterable<Seen & { id: number }>): Map<string, number> {
  const index = new Map<string, number>()
  for (const m of messages) {
    for (const h of m.hids ?? []) index.set(h, m.id)
    if (m.origin) index.set(m.origin, m.id)
  }
  return index
}
