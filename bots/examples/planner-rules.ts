// The planner bot's rules, kept apart from the bot so they're easy to test.
import type { Poll } from '../sdk/src/index'

const UNITS: Record<string, number> = { s: 1000, m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }

/** "90s", "10m", "2h", "1h30m", "3d", "1w" → milliseconds. Null if it isn't a duration. */
export function parseDuration(text: string): number | null {
  const parts = /^(?:\d{1,4}(?:s|min|m|h|d|w))+$/i.test(text) ? text.toLowerCase().match(/\d+(?:min|[smhdw])/g)! : null
  if (!parts) return null
  let ms = 0
  for (const part of parts) {
    const [, n, unit] = /^(\d+)(\D+)$/.exec(part)!
    ms += Number(n) * UNITS[unit]
  }
  return ms > 0 ? ms : null
}

/** 5400000 → "1 h 30 min". */
export function formatDuration(ms: number): string {
  const units: [number, string][] = [[86_400_000, 'd'], [3_600_000, 'h'], [60_000, 'min'], [1000, 's']]
  if (ms >= 3_600_000) ms = Math.round(ms / 60_000) * 60_000 // "2 h", not "2 h 35 s"
  const out: string[] = []
  for (const [size, name] of units) {
    if (ms >= size) {
      out.push(`${Math.floor(ms / size)} ${name}`)
      ms %= size
    }
    if (out.length === 2) break
  }
  return out.join(' ') || '0 s'
}

/** Splits "first rest of it" at the first space. */
function firstWord(text: string): [string, string] {
  const at = text.search(/\s/)
  return at < 0 ? [text, ''] : [text.slice(0, at), text.slice(at).trim()]
}

/** Polls without a duration close after a day, so the bot can post the results. */
export const DEFAULT_POLL_MS = 86_400_000

export interface PollRequest {
  question: string
  answers: string[]
  durationMs: number
}

/** "[duration] Question? | answer | answer ...". With no answers given, it's a yes/no question. */
export function parsePoll(args: string): PollRequest | string {
  const [maybe, rest] = firstWord(args)
  const duration = parseDuration(maybe)
  const [question, ...answers] = (duration ? rest : args).split('|').map((s) => s.trim())
  if (!question) return 'Try `/poll Pizza or tacos? | Pizza | Tacos` or `/poll 1h Game night on Friday?`.'
  const list = answers.filter(Boolean)
  if (list.length === 1) return 'Give at least two answers, separated by `|`, or none for a yes/no poll.'
  if (list.length > 10) return 'A poll can have at most 10 answers.'
  if (list.some((a) => a.length > 55)) return 'Keep each answer to 55 characters.'
  if (question.length > 300) return 'Keep the question to 300 characters.'
  if (duration !== null && (duration < 60_000 || duration > 14 * 86_400_000)) return 'A poll can run from 1 minute to 14 days.'
  return { question, answers: list.length ? list : ['Yes', 'No'], durationMs: duration ?? DEFAULT_POLL_MS }
}

/** "10m stretch your legs" → in 10 minutes, say "stretch your legs". */
export function parseReminder(args: string): { inMs: number; text: string } | string {
  const [when, text] = firstWord(args)
  const inMs = parseDuration(when)
  if (!inMs || !text) return 'Try `/remind 10m stretch your legs` or `/remind 2h30m pizza is ready`.'
  if (inMs > 30 * 86_400_000) return 'I can remind you up to 30 days ahead.'
  return { inMs, text: text.slice(0, 500) }
}

/** "2h Game night @ Lounge" → starts in 2 hours, at the place after "@" (a voice channel's name, or any text). */
export function parseEvent(args: string): { inMs: number; title: string; place: string | null } | string {
  const [when, rest] = firstWord(args)
  const inMs = parseDuration(when)
  const [title, place] = rest.split(/\s@\s/).map((s) => s.trim())
  if (!inMs || !title) return 'Try `/event 2h Game night` or `/event 1d Movie night @ Lounge`.'
  if (inMs > 365 * 86_400_000) return 'Events can be up to a year ahead.'
  if (title.length > 100) return 'Keep the title to 100 characters.'
  return { inMs, title, place: place ? place.slice(0, 100) : null }
}

/** One line per answer, most votes first. */
export function pollSummary(poll: Poll): string {
  const total = poll.options.reduce((n, o) => n + o.votes.length, 0)
  const lines = [...poll.options]
    .sort((a, b) => b.votes.length - a.votes.length)
    .map((o) => `${o.text}: **${o.votes.length}**${total ? ` (${Math.round((100 * o.votes.length) / total)} %)` : ''}`)
  return `📊 **${poll.question}**\n${lines.join('\n')}`
}

/** Who voted for what, as CSV (RFC 4180 quoting; a cell a spreadsheet would run as a formula gets a leading '). */
export function pollCsv(poll: Poll, nameOf: (accountKey: string) => string): string {
  const cell = (raw: string) => {
    const s = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const rows = [['answer', 'voter']]
  for (const o of poll.options) for (const key of o.votes) rows.push([o.text, nameOf(key)])
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n'
}
