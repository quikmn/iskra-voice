// Search box syntax → a structured search request, and match ranges → highlighted pieces of text.
// Supported: plain words, in:channel, from:name (or from:"two words"), has:file / has:link,
// before:/after:/during: with YYYY-MM-DD, "today" or "yesterday".
import type { Channel, Member, SearchRequest } from '../../core/protocol'

export interface ParsedSearch {
  request: SearchRequest
  /** Filters that couldn't be understood, as messages for the user. */
  errors: string[]
  /** Whether there is anything to search for. */
  empty: boolean
}

const TOKEN = /([a-z]+):(?:"([^"]*)"|(\S+))|"([^"]*)"|(\S+)/gi

function parseDay(value: string, now: Date): Date | null {
  const lower = value.toLowerCase()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (lower === 'today') return today
  if (lower === 'yesterday') return new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value)
  if (!m) return null
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return date.getMonth() === Number(m[2]) - 1 ? date : null
}

const nextDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)

export function parseSearch(input: string, ctx: { channels: Channel[]; members: Member[]; now?: Date }): ParsedSearch {
  const now = ctx.now ?? new Date()
  const request: SearchRequest = {}
  const words: string[] = []
  const errors: string[] = []

  for (const match of input.matchAll(TOKEN)) {
    const [, rawKey, quotedValue, plainValue, phrase, word] = match
    if (phrase !== undefined || word !== undefined) {
      words.push(phrase ?? word)
      continue
    }
    const key = rawKey.toLowerCase()
    const value = (quotedValue ?? plainValue).trim()
    switch (key) {
      case 'in': {
        const name = value.replace(/^#/, '').toLowerCase()
        const channel = ctx.channels.find((c) => c.kind === 'text' && c.name.toLowerCase() === name)
        if (channel) request.channelId = channel.id
        else errors.push(`No channel called #${name}.`)
        break
      }
      case 'from': {
        const name = value.replace(/^@/, '').toLowerCase()
        // Nicknames and profile names both work.
        const names = (m: (typeof ctx.members)[number]) => [m.name, m.profileName ?? m.name].map((n) => n.toLowerCase())
        const exact = ctx.members.filter((m) => names(m).includes(name))
        const prefix = ctx.members.filter((m) => names(m).some((n) => n.startsWith(name)))
        const found = exact.length === 1 ? exact[0] : prefix.length === 1 ? prefix[0] : null
        if (found) request.author = found.accountKey
        else errors.push(exact.length + prefix.length > 1 ? `More than one person matches "${value}".` : `Nobody called "${value}".`)
        break
      }
      case 'has': {
        const kind = value.toLowerCase().replace(/s$/, '')
        const has: 'file' | 'link' | null = kind === 'file' || kind === 'attachment' || kind === 'image' ? 'file' : kind === 'link' ? 'link' : null
        if (has) request.has = [...new Set([...(request.has ?? []), has])]
        else errors.push('Use has:file or has:link.')
        break
      }
      case 'before':
      case 'after':
      case 'during': {
        const day = parseDay(value, now)
        if (!day) {
          errors.push(`Dates look like 2026-01-31 (in ${key}:).`)
          break
        }
        if (key === 'before') request.before = day.getTime()
        else if (key === 'after') request.after = nextDay(day).getTime()
        else {
          request.after = day.getTime()
          request.before = nextDay(day).getTime()
        }
        break
      }
      default:
        words.push(`${rawKey}:${quotedValue ?? plainValue}`)
    }
  }

  const query = words.join(' ').trim()
  if (query) request.query = query.slice(0, 200)
  const empty = !request.query && !request.author && !request.has && request.before === undefined && request.after === undefined
  return { request, errors, empty }
}

export interface Segment {
  text: string
  hit: boolean
}

const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff

/**
 * Splits text into plain and matched pieces (rendered by React; never HTML). Long texts are cut to a
 * window around the first match, with "…" where text was left out.
 */
export function highlightSegments(text: string, matches: [number, number][], maxLength = 280): Segment[] {
  const ranges = matches
    .filter(([start, length]) => length > 0 && start >= 0 && start < text.length)
    .map(([start, length]) => [start, Math.min(text.length, start + length)] as [number, number])
    .sort((a, b) => a[0] - b[0])

  let from = 0
  let to = text.length
  if (text.length > maxLength) {
    from = Math.max(0, (ranges[0]?.[0] ?? 0) - Math.floor(maxLength / 4))
    to = Math.min(text.length, from + maxLength)
    from = Math.max(0, Math.min(from, to - maxLength))
    if (from > 0 && isLowSurrogate(text.charCodeAt(from))) from++
    if (to < text.length && isLowSurrogate(text.charCodeAt(to))) to--
  }

  const out: Segment[] = []
  const push = (piece: string, hit: boolean) => {
    if (!piece) return
    const last = out.at(-1)
    if (last && last.hit === hit) last.text += piece
    else out.push({ text: piece, hit })
  }
  if (from > 0) push('…', false)
  let cursor = from
  for (const [start, end] of ranges) {
    const s = Math.max(start, cursor)
    const e = Math.min(end, to)
    if (e <= s) continue
    push(text.slice(cursor, s), false)
    push(text.slice(s, e), true)
    cursor = e
  }
  push(text.slice(cursor, to), false)
  if (to < text.length) push('…', false)
  return out
}

/** Mentions are stored as <@accountKey>; show them as @name. */
export function readableMentions(text: string, nameOf: (accountKey: string) => string | null): string {
  return text.replace(/<@([A-Za-z0-9_-]{43})>/g, (_, key: string) => `@${nameOf(key) ?? 'unknown'}`)
}
