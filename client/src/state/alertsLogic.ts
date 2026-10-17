// Keyword alerts, follows and quiet hours, the pure part: cleaning words, matching them and follows (the same rules as
// the server's), which copy a server gets, and whether quiet hours are on at a moment in their time zone.
import type { FollowRule, QuietHours, ServerAlerts } from '../core/protocol'

export const MAX_WORDS = 25
export const MAX_WORD_LENGTH = 50
/** Follows per server. */
export const MAX_FOLLOWS = 50

/** An alert word or phrase; `server` limits it to one server (none: everywhere). */
export interface AlertWord {
  text: string
  server?: string
}

/** Alert me when `member` (or anyone with `role`) posts on `server`, in `channel` (none: any channel there). */
export interface Follow {
  server: string
  member?: string
  role?: number
  channel?: number
}

export interface AlertSettings {
  words: AlertWord[]
  follows: Follow[]
  /** "Also when Iskra is closed": servers keep the words and follows so push can match them (words only in channels that aren't encrypted). */
  closed: boolean
  quietOn: boolean
  quiet: QuietHours
  /** The end of the last quiet hours summary dismissed on any device (state/quietDigest.ts). */
  digestSeen: number
  updatedAt: number
}

export const localTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** Weeknights 22:00–07:00 here, off until chosen. */
export const defaultQuiet = (): QuietHours => ({ days: 0b0111110, from: 22 * 60, to: 7 * 60, timeZone: localTimeZone(), mentions: true, digest: true })

export const emptyAlerts = (): AlertSettings => ({ words: [], follows: [], closed: false, quietOn: false, quiet: defaultQuiet(), digestSeen: 0, updatedAt: 0 })

/** Trimmed, runs of spaces as one; null if it can't be an alert word. */
export function cleanWord(raw: string): string | null {
  if (/\p{Cc}/u.test(raw)) return null
  const word = raw.trim().replace(/\s+/g, ' ')
  return word && word.length <= MAX_WORD_LENGTH ? word : null
}

const sameWord = (a: AlertWord, b: AlertWord) => a.text.toLowerCase() === b.text.toLowerCase() && (a.server ?? '') === (b.server ?? '')

/** Adds a word (no duplicates, at most 25). Null if it can't be added. */
export function addWord(words: AlertWord[], raw: string, server?: string): AlertWord[] | null {
  const text = cleanWord(raw)
  if (!text || words.length >= MAX_WORDS) return null
  const word: AlertWord = server ? { text, server } : { text }
  if (words.some((w) => sameWord(w, word))) return null
  return [...words, word]
}

/** The words that count on a server (everywhere ones and its own), duplicates once. */
export function wordsFor(words: AlertWord[], serverKey: string | null): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const w of words) {
    if (w.server && w.server !== serverKey) continue
    const key = w.text.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      out.push(w.text)
    }
  }
  return out.slice(0, MAX_WORDS)
}

// ── Follows ─────────────────────────────────────────────────────────────────

export const sameFollow = (a: Follow, b: Follow): boolean =>
  a.server === b.server && (a.member ?? '') === (b.member ?? '') && (a.role ?? 0) === (b.role ?? 0) && (a.channel ?? 0) === (b.channel ?? 0)

/** A well-formed follow: a person or a role (not both), in a channel or anywhere. */
export function cleanFollow(raw: Follow): Follow | null {
  const key = (s: unknown) => typeof s === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s)
  const id = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n > 0
  if (!key(raw.server) || key(raw.member) === id(raw.role)) return null
  if (raw.channel !== undefined && !id(raw.channel)) return null
  const follow: Follow = { server: raw.server }
  if (raw.member !== undefined) follow.member = raw.member
  if (raw.role !== undefined) follow.role = raw.role
  if (raw.channel !== undefined) follow.channel = raw.channel
  return follow
}

/** Adds a follow (no duplicates, at most 50 per server). Null if it can't be added. */
export function addFollow(follows: Follow[], raw: Follow): Follow[] | null {
  const follow = cleanFollow(raw)
  if (!follow || follows.some((f) => sameFollow(f, follow))) return null
  if (follows.filter((f) => f.server === follow.server).length >= MAX_FOLLOWS) return null
  return [...follows, follow]
}

export const removeFollow = (follows: Follow[], follow: Follow): Follow[] => follows.filter((f) => !sameFollow(f, follow))

/** The follows on one server, as the server's copy wants them. */
export const followsFor = (follows: Follow[], serverKey: string): FollowRule[] =>
  follows.filter((f) => f.server === serverKey).map((f) => ({ member: f.member ?? null, role: f.role ?? null, channelId: f.channel ?? null }))

/**
 * Does one of the follows cover a message by `author` in `channelId` on `serverKey`? Same rule as the server
 * (AlertFeature.FollowMatches): the followed person, or anyone with the followed role, in the followed channel or anywhere.
 */
export function matchesFollow(follows: Follow[], serverKey: string, author: { accountKey: string; roles?: number[] }, channelId: number): boolean {
  return follows.some((f) => f.server === serverKey && (f.channel === undefined || f.channel === channelId)
    && (f.member !== undefined ? f.member === author.accountKey : f.role !== undefined && (author.roles ?? []).includes(f.role)))
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const patterns = new Map<string, RegExp>()

/**
 * One pattern for a list of words: each matched as a whole word or phrase (no letter, digit, combining mark or "_"
 * right before or after it), ignoring case; words are literal text. Same rule as the server (AlertFeature.Pattern).
 */
export function alertPattern(words: string[]): RegExp | null {
  if (words.length === 0) return null
  const key = words.join('\n')
  const hit = patterns.get(key)
  if (hit) return hit
  const alternatives = words.map((w) => w.split(' ').filter(Boolean).map(escape).join('\\s+'))
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}\\p{M}_])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}\\p{M}_])`, 'giu')
  if (patterns.size > 200) patterns.clear()
  patterns.set(key, pattern)
  return pattern
}

export function matchesAlert(pattern: RegExp | null, text: string): boolean {
  if (!pattern || !text) return false
  pattern.lastIndex = 0
  const found = pattern.test(text)
  pattern.lastIndex = 0 // shared and global: matchAll elsewhere starts from here
  return found
}

/** Where the words are in a piece of text, as [start, end) pairs. */
export function alertRanges(pattern: RegExp | null, text: string): [number, number][] {
  if (!pattern || !text) return []
  const out: [number, number][] = []
  pattern.lastIndex = 0
  for (const m of text.matchAll(pattern)) if (m[0]) out.push([m.index, m.index + m[0].length])
  return out
}

/**
 * What a server keeps: the words and follows only with "Also when Iskra is closed", and quiet hours only where push
 * needs them (push is on for this device there, or another device already put them there).
 */
export function serverCopy(settings: AlertSettings, serverKey: string, pushHere: boolean, stored: ServerAlerts | null): Required<ServerAlerts> {
  const quietThere = settings.quietOn && (pushHere || !!stored?.quiet)
  return {
    words: settings.closed ? wordsFor(settings.words, serverKey) : [],
    follows: settings.closed ? followsFor(settings.follows, serverKey) : [],
    quiet: quietThere ? settings.quiet : null,
  }
}

export function sameCopy(a: ServerAlerts | null, b: ServerAlerts): boolean {
  const q = (x: ServerAlerts['quiet']) => (x ? `${x.days}|${x.from}|${x.to}|${x.timeZone}|${x.mentions}|${x.digest !== false}` : '')
  const f = (x: ServerAlerts['follows']) => (x ?? []).map((r) => `${r.member ?? ''}|${r.role ?? ''}|${r.channelId ?? ''}`).sort().join('\n')
  return !!a && a.words.join('\n') === b.words.join('\n') && f(a.follows) === f(b.follows) && q(a.quiet) === q(b.quiet)
}

// ── Quiet hours ─────────────────────────────────────────────────────────────

const DAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
const clocks = new Map<string, Intl.DateTimeFormat>()

/** Day of the week (0 = Sunday) and minutes after midnight in a time zone; null for a zone this device doesn't know. */
export function wallClock(at: Date, timeZone: string): { day: number; minute: number } | null {
  let clock = clocks.get(timeZone)
  if (!clock) {
    try {
      clock = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    } catch {
      return null
    }
    clocks.set(timeZone, clock)
  }
  const parts = Object.fromEntries(clock.formatToParts(at).map((p) => [p.type, p.value]))
  const day = DAY_INDEX[parts.weekday ?? '']
  if (day === undefined) return null
  return { day, minute: (Number(parts.hour) % 24) * 60 + Number(parts.minute) }
}

/**
 * Are quiet hours on at `at`? From and to are wall-clock times in the schedule's time zone; a stretch that crosses
 * midnight belongs to the day it starts on; from = to is the whole day. Same rule as the server (AlertFeature.Active).
 */
export function quietActive(quiet: QuietHours, at: Date): boolean {
  const now = wallClock(at, quiet.timeZone)
  if (!now) return false
  const on = (day: number) => (quiet.days & (1 << day)) !== 0
  const yesterday = (now.day + 6) % 7
  if (quiet.from === quiet.to) return on(now.day)
  if (quiet.from < quiet.to) return on(now.day) && now.minute >= quiet.from && now.minute < quiet.to
  return (on(now.day) && now.minute >= quiet.from) || (on(yesterday) && now.minute < quiet.to)
}

/** "07:00" for 420. */
export const clockText = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`

/** "22:30" → 1350; null if it isn't a time. */
export function parseClock(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  return h < 24 && min < 60 ? h * 60 + min : null
}

/** Settings from storage or another device, checked (storage and servers are never trusted). */
export function parseAlerts(value: unknown): AlertSettings | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (!Array.isArray(v.words) || typeof v.updatedAt !== 'number') return null
  let words: AlertWord[] = []
  for (const w of v.words.slice(0, MAX_WORDS)) {
    if (!w || typeof w !== 'object' || typeof (w as AlertWord).text !== 'string') continue
    const server = (w as AlertWord).server
    words = addWord(words, (w as AlertWord).text, typeof server === 'string' && /^[A-Za-z0-9_-]{43}$/.test(server) ? server : undefined) ?? words
  }
  let follows: Follow[] = []
  if (Array.isArray(v.follows))
    for (const f of v.follows.slice(0, MAX_FOLLOWS * 20)) if (f && typeof f === 'object') follows = addFollow(follows, f as Follow) ?? follows
  const q = v.quiet as Partial<QuietHours> | undefined
  const minute = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 1440
  const quiet: QuietHours = q && typeof q === 'object' && typeof q.days === 'number' && q.days >= 1 && q.days <= 127 && Number.isInteger(q.days)
    && minute(q.from) && minute(q.to) && typeof q.timeZone === 'string' && q.timeZone.length <= 64 && wallClock(new Date(0), q.timeZone)
    ? { days: q.days, from: q.from!, to: q.to!, timeZone: q.timeZone, mentions: q.mentions === true, digest: q.digest !== false }
    : defaultQuiet()
  const digestSeen = typeof v.digestSeen === 'number' && Number.isFinite(v.digestSeen) && v.digestSeen >= 0 ? v.digestSeen : 0
  return { words, follows, closed: v.closed === true, quietOn: v.quietOn === true, quiet, digestSeen, updatedAt: v.updatedAt }
}
