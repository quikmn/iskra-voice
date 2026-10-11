// Pure rules for saved messages, reminders and scheduled messages: which message something points at, the times
// offered in the pickers, and how the saved list merges and fits into one synced preference.

/** A message anywhere: a channel (or thread) message on a server, a DM, or a group DM message. */
export type MessageRef =
  | { kind: 'channel'; server: string; channelId: number; messageId: number }
  | { kind: 'dm'; peer: string; from: string; id: string }
  | { kind: 'group'; group: string; from: string; id: string }

/** What the message looked like when it was saved, so lists can show it without loading anything. */
export interface MessageSnap {
  author: string
  authorName: string
  /** Plain text, shortened. */
  preview: string
  /** When the message was sent. */
  at: number
  /** "#general · Gaming", a person's name, or a group's title. */
  where: string
}

export const refKey = (ref: MessageRef): string =>
  ref.kind === 'channel' ? `c:${ref.server}:${ref.channelId}:${ref.messageId}`
    : ref.kind === 'dm' ? `d:${ref.peer}:${ref.from}:${ref.id}` : `g:${ref.group}:${ref.from}:${ref.id}`

const KEY = /^[A-Za-z0-9_-]{43}$/
const ID = /^[A-Za-z0-9_-]{1,64}$/
const GROUP = /^[A-Za-z0-9_-]{43}\/[A-Za-z0-9_-]{22}$/
const isId = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0
const isTime = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

/** A ref from storage or another device, checked field by field (null if anything is off). */
export function checkRef(raw: unknown): MessageRef | null {
  const r = raw as Record<string, unknown> | null
  if (!r || typeof r !== 'object') return null
  if (r.kind === 'channel' && typeof r.server === 'string' && KEY.test(r.server) && isId(r.channelId) && isId(r.messageId))
    return { kind: 'channel', server: r.server, channelId: r.channelId, messageId: r.messageId }
  if (r.kind === 'dm' && typeof r.peer === 'string' && KEY.test(r.peer) && typeof r.from === 'string' && KEY.test(r.from)
    && typeof r.id === 'string' && ID.test(r.id))
    return { kind: 'dm', peer: r.peer, from: r.from, id: r.id }
  if (r.kind === 'group' && typeof r.group === 'string' && GROUP.test(r.group) && typeof r.from === 'string' && KEY.test(r.from)
    && typeof r.id === 'string' && ID.test(r.id))
    return { kind: 'group', group: r.group, from: r.from, id: r.id }
  return null
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')

export function checkSnap(raw: unknown): MessageSnap | null {
  const s = raw as Record<string, unknown> | null
  if (!s || typeof s !== 'object' || !isTime(s.at)) return null
  return { author: text(s.author, 64), authorName: text(s.authorName, 64), preview: text(s.preview, PREVIEW), at: s.at, where: text(s.where, 120) }
}

/** Previews kept on the device that saved something. */
export const PREVIEW = 200

export function shorten(value: string, max = PREVIEW): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

// ── Times ───────────────────────────────────────────────────────────────────

export type Preset = '20m' | '1h' | '3h' | 'tomorrow' | 'nextWeek'

const MINUTE = 60_000

/** Tomorrow at 09:00 local time. */
export function tomorrowMorning(now: Date): number {
  const d = new Date(now)
  d.setDate(d.getDate() + 1)
  d.setHours(9, 0, 0, 0)
  return d.getTime()
}

/** Next Monday at 09:00 local time (a week ahead when it's Monday already). */
export function nextWeekMorning(now: Date): number {
  const d = new Date(now)
  const days = ((8 - d.getDay()) % 7) || 7
  d.setDate(d.getDate() + days)
  d.setHours(9, 0, 0, 0)
  return d.getTime()
}

export function presetTime(preset: Preset, now: Date): number {
  switch (preset) {
    case '20m': return now.getTime() + 20 * MINUTE
    case '1h': return now.getTime() + 60 * MINUTE
    case '3h': return now.getTime() + 180 * MINUTE
    case 'tomorrow': return tomorrowMorning(now)
    case 'nextWeek': return nextWeekMorning(now)
  }
}

const pad = (n: number) => String(n).padStart(2, '0')

/** For <input type="datetime-local" step="1">: local time with seconds. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** The time a datetime-local value means here, or null if it isn't one. */
export function fromLocalInput(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(value)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0))
  return Number.isNaN(d.getTime()) ? null : d.getTime()
}

/** Why a picked time won't do (null if it's fine): it must be ahead, and not further than the limit. */
export function timeProblem(at: number | null, now: number, maxAheadMs: number): 'invalid' | 'past' | 'far' | null {
  if (at === null) return 'invalid'
  if (at <= now) return 'past'
  if (at > now + maxAheadMs) return 'far'
  return null
}

export const REMINDER_MAX_AHEAD = 365 * 24 * 60 * MINUTE
export const CHANNEL_SEND_MAX_AHEAD = 90 * 24 * 60 * MINUTE
/** Encrypted messages are encrypted when scheduled; their prekeys are kept for at least 30 days. */
export const ENCRYPTED_SEND_MAX_AHEAD = 30 * 24 * 60 * MINUTE - MINUTE

// ── Saved messages ──────────────────────────────────────────────────────────

export interface SavedEntry {
  key: string
  ref: MessageRef
  savedAt: number
  /** Set when removed: kept for a while so other devices learn about it. */
  removedAt?: number
  snap?: MessageSnap
}

export const MAX_SAVED = 150
/** Removals are remembered this long, then forgotten. */
export const TOMBSTONE_MS = 30 * 24 * 60 * MINUTE

const stamp = (e: SavedEntry) => Math.max(e.savedAt, e.removedAt ?? 0)

/** Both lists' entries, the newest change per message winning (a remove after a save hides it, a save after brings it back). */
export function mergeSaved(a: SavedEntry[], b: SavedEntry[]): SavedEntry[] {
  const out = new Map<string, SavedEntry>()
  for (const entry of [...a, ...b]) {
    const current = out.get(entry.key)
    if (!current || stamp(entry) > stamp(current)) out.set(entry.key, { ...entry, snap: entry.snap ?? (entry.removedAt ? undefined : current?.snap) })
    else if (stamp(entry) === stamp(current) && !current.snap && entry.snap && !current.removedAt) out.set(entry.key, { ...current, snap: entry.snap })
  }
  return [...out.values()].sort((x, y) => y.savedAt - x.savedAt)
}

/** An entry from storage, checked (an empty list if it isn't one). */
export function checkEntry(raw: unknown): SavedEntry[] {
  const e = raw as Partial<SavedEntry> | null
  const ref = checkRef(e?.ref)
  if (!e || !ref || !isTime(e.savedAt)) return []
  const snap = checkSnap(e.snap)
  return [{ key: refKey(ref), ref, savedAt: e.savedAt, ...(isTime(e.removedAt) && e.removedAt ? { removedAt: e.removedAt } : {}), ...(snap ? { snap } : {}) }]
}

export const liveSaved = (list: SavedEntry[]) => list.filter((e) => !e.removedAt)

export function sameSaved(a: SavedEntry[], b: SavedEntry[]): boolean {
  if (a.length !== b.length) return false
  const index = new Map(b.map((e) => [e.key, e]))
  return a.every((e) => {
    const o = index.get(e.key)
    return !!o && o.savedAt === e.savedAt && (o.removedAt ?? 0) === (e.removedAt ?? 0)
  })
}

export function pruneSaved(list: SavedEntry[], now: number): SavedEntry[] {
  return list.filter((e) => !e.removedAt || now - e.removedAt < TOMBSTONE_MS)
}

/**
 * The compact form that syncs (one preference, ≤ 16 KB sealed): long keys go into a table, refs are short arrays, and
 * previews are shortened (and dropped from the oldest entries, then old removals forgotten) until it fits.
 */
export function encodeSaved(list: SavedEntry[], maxChars = 11_500): string {
  let previewLength = 80
  let entries = [...list].sort((x, y) => stamp(y) - stamp(x))
  for (;;) {
    const keys: string[] = []
    const k = (value: string) => {
      const at = keys.indexOf(value)
      if (at >= 0) return at
      keys.push(value)
      return keys.length - 1
    }
    const rows = entries.map((e) => {
      const r = e.ref
      const ref = r.kind === 'channel' ? ['c', k(r.server), r.channelId, r.messageId]
        : r.kind === 'dm' ? ['d', k(r.peer), k(r.from), r.id] : ['g', k(r.group), k(r.from), r.id]
      const row: unknown[] = [ref, e.savedAt, e.removedAt ?? 0]
      if (!e.removedAt && e.snap && previewLength > 0)
        row.push([k(e.snap.author), e.snap.authorName, shorten(e.snap.preview, previewLength), e.snap.at, e.snap.where])
      return row
    })
    const json = JSON.stringify({ v: 1, keys, items: rows })
    if (json.length <= maxChars) return json
    if (previewLength > 0) previewLength = previewLength > 30 ? previewLength - 25 : 0
    else if (entries.some((e) => e.removedAt)) entries = entries.filter((e) => !e.removedAt || e !== entries.findLast((x) => x.removedAt))
    else entries = entries.slice(0, -1) // can't happen within MAX_SAVED, but never refuse to sync
  }
}

export function decodeSaved(json: string): SavedEntry[] | null {
  try {
    const data = JSON.parse(json) as { v?: unknown; keys?: unknown; items?: unknown }
    if (data.v !== 1 || !Array.isArray(data.keys) || !Array.isArray(data.items)) return null
    const keys = data.keys.map((x) => (typeof x === 'string' ? x : ''))
    const key = (i: unknown) => (typeof i === 'number' && keys[i] !== undefined ? keys[i] : '')
    const out: SavedEntry[] = []
    for (const row of data.items.slice(0, MAX_SAVED * 3)) {
      if (!Array.isArray(row) || !Array.isArray(row[0])) continue
      const [kind, a, b, c] = row[0] as unknown[]
      const ref = checkRef(kind === 'c' ? { kind: 'channel', server: key(a), channelId: b, messageId: c }
        : kind === 'd' ? { kind: 'dm', peer: key(a), from: key(b), id: c } : kind === 'g' ? { kind: 'group', group: key(a), from: key(b), id: c } : null)
      if (!ref || !isTime(row[1]) || !isTime(row[2])) continue
      const snapRow = Array.isArray(row[3]) ? row[3] as unknown[] : null
      const snap = snapRow ? checkSnap({ author: key(snapRow[0]), authorName: snapRow[1], preview: snapRow[2], at: snapRow[3], where: snapRow[4] }) : null
      out.push({ key: refKey(ref), ref, savedAt: row[1], ...(row[2] ? { removedAt: row[2] } : {}), ...(snap ? { snap } : {}) })
    }
    return out
  } catch {
    return null
  }
}
