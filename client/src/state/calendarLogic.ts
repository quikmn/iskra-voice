// The calendar view's arithmetic: where a repeating event falls next, which day each event is on for the viewer, the
// month grid and the agenda. Pure functions on eventTime.ts; no React, no store.
import type { EventRepeat, ServerEvent } from '../core/protocol'
import { utcToZoned, zonedToUtc } from './eventTime'

/** A day as the date inputs write it: "2026-10-24". */
export type DayKey = string

const pad = (n: number) => String(n).padStart(2, '0')
const key = (y: number, m: number, d: number): DayKey => {
  const date = new Date(Date.UTC(y, m, d))
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}
const parts = (day: DayKey) => day.split('-').map(Number) as [number, number, number]

/** `day` moved by a number of days. */
export function addDays(day: DayKey, days: number): DayKey {
  const [y, m, d] = parts(day)
  return key(y, m - 1, d + days)
}

/** 0 (Sunday) to 6 (Saturday). */
export function weekdayOf(day: DayKey): number {
  const [y, m, d] = parts(day)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

const daysInMonth = (y: number, month: number) => new Date(Date.UTC(y, month + 1, 0)).getUTCDate()

/** The day `utcMs` falls on in `zone`. */
export const dayOf = (utcMs: number, zone: string): DayKey => utcToZoned(utcMs, zone).date

/** The instant a day begins in `zone` (a day that starts in a clock change begins when the clocks land). */
export function dayStart(day: DayKey, zone: string): number {
  return zonedToUtc(day, '00:00', zone) ?? Date.UTC(...(parts(day).map((n, i) => (i === 1 ? n - 1 : n)) as [number, number, number]))
}

/**
 * The start of the occurrence after one at `startUtc`: the same wall-clock time in the event's zone a day, a week, two
 * weeks or a month later (the 31st becomes the last day of a shorter month). What the server does when it makes the
 * next occurrence (EventFeature.NextStart), so the calendar shows the days the server will pick.
 */
export function nextStart(startUtc: number, repeat: EventRepeat, zone: string): number | null {
  if (repeat === 'none') return null
  const local = utcToZoned(startUtc, zone)
  const [y, m, d] = parts(local.date)
  let next: DayKey
  if (repeat === 'monthly') {
    const month = m // the month after m - 1, zero-based
    const year = y + Math.floor(month / 12)
    next = key(year, month % 12, Math.min(d, daysInMonth(year, month % 12)))
  } else {
    next = addDays(local.date, repeat === 'daily' ? 1 : repeat === 'weekly' ? 7 : 14)
  }
  return zonedToUtc(next, local.time, zone)
}

export interface Occurrence {
  event: ServerEvent
  startAt: number
  endAt: number
  /** A later occurrence of a series: the server hasn't made it yet (it makes one at a time). */
  projected: boolean
}

/** The most occurrences one series is expanded to (two years of a daily event). */
const MAX_OCCURRENCES = 800

/**
 * The event's occurrences that start in [from, to): the event itself, and for a series the ones after it, until
 * `until`. Each keeps the event's length.
 */
export function occurrences(event: ServerEvent, from: number, to: number): Occurrence[] {
  const length = event.endAt - event.startAt
  const found: Occurrence[] = []
  let start: number | null = event.startAt
  for (let i = 0; start !== null && start < to && i < MAX_OCCURRENCES; i++) {
    if (i > 0 && event.until !== null && start > event.until) break
    if (start >= from) found.push({ event, startAt: start, endAt: start + length, projected: i > 0 })
    const next = nextStart(start, event.repeat, event.timeZone)
    start = next !== null && next > start ? next : null
  }
  return found
}

export interface Birthday {
  accountKey: string
  month: number
  day: number
}

/** The day a birthday is celebrated in `year` (29 February: the 28th in other years, as the Birthdays bot does). */
export function birthdayIn(birthday: Pick<Birthday, 'month' | 'day'>, year: number): DayKey {
  const day = birthday.month === 2 && birthday.day === 29 && daysInMonth(year, 1) < 29 ? 28 : birthday.day
  return key(year, birthday.month - 1, day)
}

export type CalendarItem =
  | ({ kind: 'event' } & Occurrence)
  | { kind: 'birthday'; accountKey: string }

export interface CalendarDay {
  day: DayKey
  items: CalendarItem[]
}

/**
 * What's on each day from `first` to `last` (both included) for someone in `zone`: birthdays first, then events by
 * start time. An event is on the day it starts, in the viewer's zone. Days with nothing are left out.
 */
export function itemsByDay(events: ServerEvent[], birthdays: Birthday[], first: DayKey, last: DayKey, zone: string): Map<DayKey, CalendarItem[]> {
  const days = new Map<DayKey, CalendarItem[]>()
  const add = (day: DayKey, item: CalendarItem) => {
    if (day < first || day > last) return
    const list = days.get(day)
    if (list) list.push(item)
    else days.set(day, [item])
  }
  const years = [...new Set([parts(first)[0], parts(last)[0]])]
  for (const birthday of [...birthdays].sort((a, b) => a.accountKey.localeCompare(b.accountKey))) {
    for (const year of years) add(birthdayIn(birthday, year), { kind: 'birthday', accountKey: birthday.accountKey })
  }
  const from = dayStart(first, zone)
  const to = dayStart(addDays(last, 1), zone)
  const found: Occurrence[] = []
  for (const event of events) found.push(...occurrences(event, from, to))
  found.sort((a, b) => a.startAt - b.startAt || a.event.id - b.event.id)
  for (const occurrence of found) add(dayOf(occurrence.startAt, zone), { kind: 'event', ...occurrence })
  return days
}

/** The days that have something, in order, from `first` on: the agenda. */
export function agenda(events: ServerEvent[], birthdays: Birthday[], first: DayKey, days: number, zone: string): CalendarDay[] {
  const last = addDays(first, days - 1)
  return [...itemsByDay(events, birthdays, first, last, zone)]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, items]) => ({ day, items }))
}

export interface GridDay {
  day: DayKey
  /** False for the days of the months before and after that fill the first and last week. */
  inMonth: boolean
}

/** The weeks of a month (`month` 0–11) as rows of seven days, starting on `weekStart` (0 Sunday … 6 Saturday). */
export function monthGrid(year: number, month: number, weekStart: number): GridDay[][] {
  const first = key(year, month, 1)
  const lead = (weekdayOf(first) - weekStart + 7) % 7
  const total = Math.ceil((lead + daysInMonth(year, month)) / 7) * 7
  const weeks: GridDay[][] = []
  for (let i = 0; i < total; i++) {
    const day = addDays(first, i - lead)
    if (i % 7 === 0) weeks.push([])
    weeks[weeks.length - 1].push({ day, inMonth: parts(day)[1] === month + 1 })
  }
  return weeks
}

/** The month after (or before) one: `{ year, month }` with month 0–11. */
export function shiftMonth(at: { year: number; month: number }, by: number): { year: number; month: number } {
  const index = at.year * 12 + at.month + by
  return { year: Math.floor(index / 12), month: ((index % 12) + 12) % 12 }
}

/** Regions whose week starts on Sunday, for browsers that can't say (Intl.Locale week info is recent). */
const SUNDAY_REGIONS = new Set(['US', 'CA', 'MX', 'BR', 'JP', 'KR', 'IL', 'AU', 'PH', 'CO', 'PE', 'VE', 'AR', 'ZA', 'IN', 'TW', 'HK'])
/** …and on Saturday. */
const SATURDAY_REGIONS = new Set(['EG', 'AE', 'AF', 'IR', 'DZ', 'BH', 'IQ', 'JO', 'KW', 'LY', 'OM', 'QA', 'SY'])

/** The first day of the week for a locale ("sv-SE" → 1, "en-US" → 0): the browser's answer, else by region, else Monday. */
export function weekStartOf(locale: string): number {
  try {
    const info = new Intl.Locale(locale) as Intl.Locale & { getWeekInfo?: () => { firstDay?: number }; weekInfo?: { firstDay?: number } }
    const first = (info.getWeekInfo?.() ?? info.weekInfo)?.firstDay
    if (typeof first === 'number' && first >= 1 && first <= 7) return first % 7
    const region = info.maximize().region
    if (region && SUNDAY_REGIONS.has(region)) return 0
    if (region && SATURDAY_REGIONS.has(region)) return 6
  } catch {
    /* an unknown tag */
  }
  return 1
}

/** The start for a new event made from a day in the calendar: that day at 19:00 local time, as a UTC instant. */
export function newEventStart(day: DayKey, zone: string): number {
  return zonedToUtc(day, '19:00', zone) ?? dayStart(day, zone) + 19 * 3_600_000
}

// ── The calendar feed's address ─────────────────────────────────────────────

/**
 * Whether calendar services on the internet (Google, Outlook, iCloud) could fetch from this address: https, and a host
 * that isn't this computer, a private network or a name only a local network knows. Mirrors CalendarFeeds.IsPublicHttps.
 */
export function isPublicHttps(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  if (!host || host === 'localhost') return false
  if (host.startsWith('[')) {
    const v6 = host.slice(1, -1)
    return !(v6 === '::1' || v6 === '::' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6))
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const [a, b, c] = v4.slice(1).map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0))
  }
  if (!host.includes('.')) return false
  return !['.localhost', '.local', '.lan', '.internal', '.home.arpa', '.ts.net'].some((suffix) => host.endsWith(suffix))
}

/**
 * Where a calendar feed's link starts: the public address the server reports, else the address this app reaches the
 * server at when that is one a calendar service could use too. Null: there's no link that could work.
 */
export function feedBase(serverAddress: string | null, server: { publicUrl?: string | null; directUrl: string }): string | null {
  for (const candidate of [serverAddress, server.publicUrl, server.directUrl]) {
    if (candidate && isPublicHttps(candidate)) return candidate.replace(/\/+$/, '')
  }
  return null
}

export interface FeedLinks {
  /** The link to copy into a calendar app. */
  https: string
  /** The same over the calendar scheme (webcals: https), which opens the device's calendar app. */
  webcal: string
  /** Opens Google Calendar's "add by URL" with the link filled in. */
  google: string
  /** The same for Outlook on the web. */
  outlook: string
}

export function feedLinks(base: string, path: string, name: string): FeedLinks {
  const https = `${base}${path}`
  const webcal = https.replace(/^https:/, 'webcals:')
  return {
    https,
    webcal,
    google: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal.replace(/^webcals:/, 'webcal:'))}`,
    outlook: `https://outlook.live.com/calendar/0/addfromweb?url=${encodeURIComponent(https)}&name=${encodeURIComponent(name)}`,
  }
}
