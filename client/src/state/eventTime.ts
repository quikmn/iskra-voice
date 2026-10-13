// Time zones and calendar files for scheduled events. Pure functions on Intl; no React, no store.
import type { ServerEvent } from '../core/protocol'
import { intlLocale, t } from '../i18n'

/** The browser's IANA time zone ("Europe/Stockholm"), or UTC if it can't say. */
export function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** Time zones to pick from (the browser's list when it has one), always including `current`. */
export function zoneList(current: string): string[] {
  let zones: string[] = []
  try {
    zones = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? []
  } catch {
    /* older browsers */
  }
  if (!zones.includes('UTC')) zones = ['UTC', ...zones]
  return zones.includes(current) ? zones : [current, ...zones]
}

/**
 * A sensible start for a new event, in local time: this evening at 19:00 while that's an hour or more away, else the
 * next full hour after an hour from now up to 22:00, else tomorrow at 19:00. Never the middle of the night.
 */
export function defaultEventStart(now: Date = new Date()): number {
  const at = (days: number, hour: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour).getTime()
  const soonest = now.getTime() + 3_600_000
  if (at(0, 19) >= soonest) return at(0, 19)
  const next = new Date(soonest)
  next.setMinutes(0, 0, 0)
  const hour = next.getTime() < soonest ? next.getTime() + 3_600_000 : next.getTime()
  return hour <= at(0, 22) ? hour : at(1, 19)
}

export function isValidZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** How far `zone` is ahead of UTC at instant `utcMs`, in ms. */
export function zoneOffset(utcMs: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs))
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'))
  return asUtc - Math.floor(utcMs / 1000) * 1000
}

/**
 * The UTC instant of a wall-clock time in `zone` ("2026-10-24", "19:30", "Europe/Stockholm").
 * A time skipped by a DST change moves forward by the gap; an ambiguous one (clocks going back) takes the first.
 * Null for an unparseable date or time.
 */
export function zonedToUtc(date: string, time: string, zone: string): number | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  const t = /^(\d{2}):(\d{2})$/.exec(time)
  if (!d || !t) return null
  const wall = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]))
  if (Number.isNaN(wall)) return null
  // Try the offsets in effect a day either side: one of them is right, unless the time doesn't exist.
  const candidates = [...new Set([zoneOffset(wall - 86_400_000, zone), zoneOffset(wall, zone), zoneOffset(wall + 86_400_000, zone)])]
    .map((offset) => wall - offset)
    .filter((utc) => utc + zoneOffset(utc, zone) === wall)
    .sort((a, b) => a - b)
  if (candidates.length > 0) return candidates[0]
  // In a DST gap: use the offset from before the change, which lands just after it.
  return wall - zoneOffset(wall - 86_400_000, zone)
}

/** The wall-clock date and time of `utcMs` in `zone`, as the form fields want them. */
export function utcToZoned(utcMs: number, zone: string): { date: string; time: string } {
  const shifted = new Date(utcMs + zoneOffset(utcMs, zone))
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    date: `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`,
    time: `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`,
  }
}

/** "Sat, Oct 24, 7:30 PM" in the viewer's zone (or `zone`). */
export function formatWhen(utcMs: number, zone?: string, locale = intlLocale()): string {
  return new Intl.DateTimeFormat(locale, { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    .format(new Date(utcMs))
}

export function formatClock(utcMs: number, zone?: string, locale = intlLocale()): string {
  return new Intl.DateTimeFormat(locale, { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(new Date(utcMs))
}

/** "7:30 PM – 9:30 PM", or with the end's date when it ends on another day. */
export function formatRange(start: number, end: number, zone?: string, locale = intlLocale()): string {
  const sameDay = utcToZoned(start, zone ?? localZone()).date === utcToZoned(end, zone ?? localZone()).date
  return `${formatWhen(start, zone, locale)} – ${sameDay ? formatClock(end, zone, locale) : formatWhen(end, zone, locale)}`
}

/** The creator's own clock, when it differs from the viewer's: "7:30 PM in Europe/Stockholm". Null when it's the same. */
export function creatorTime(event: ServerEvent, viewerZone: string, locale = intlLocale()): string | null {
  if (zoneOffset(event.startAt, event.timeZone) === zoneOffset(event.startAt, viewerZone)) return null
  return t('events.creatorTime', { when: formatWhen(event.startAt, event.timeZone, locale), zone: event.timeZone.replace(/_/g, ' ') })
}

/** "in 25 min", "in 3 h", "in 2 days", or null once it has started. */
export function startsIn(start: number, now: number): string | null {
  const ms = start - now
  if (ms <= 0) return null
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return t('events.startsIn.minutes', { n: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t('events.startsIn.hours', { n: hours })
  return t('events.startsIn.days', { count: Math.round(hours / 24) })
}

/** Upcoming and live events, soonest first: what the sidebar badge counts. */
export function openEvents(events: ServerEvent[]): ServerEvent[] {
  return events.filter((e) => e.status === 'scheduled' || e.status === 'live').sort((a, b) => a.startAt - b.startAt || a.id - b.id)
}

// ── iCalendar (RFC 5545) ────────────────────────────────────────────────────

const icsStamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')

/** TEXT values: backslash, semicolon, comma and newlines escaped. */
export function icsText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
}

/** Lines longer than 75 bytes are folded (CRLF + space), never splitting a character. */
export function icsFold(line: string): string {
  const encoder = new TextEncoder()
  const out: string[] = []
  let current = ''
  let bytes = 0
  for (const char of line) {
    const size = encoder.encode(char).length
    if (bytes + size > (out.length === 0 ? 75 : 74)) {
      out.push(current)
      current = ''
      bytes = 0
    }
    current += char
    bytes += size
  }
  out.push(current)
  return out.join('\r\n ')
}

/** A calendar file for one event, times in UTC. `place` is how the location reads ("Voice: lounge on Gaming"). */
export function eventIcs(event: ServerEvent, opts: { serverKey: string; place: string; now?: number }): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Iskra//Events//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:event-${event.id}-${opts.serverKey}@iskra`,
    `DTSTAMP:${icsStamp(opts.now ?? Date.now())}`,
    `DTSTART:${icsStamp(event.startAt)}`,
    `DTEND:${icsStamp(event.endAt)}`,
    `SUMMARY:${icsText(event.title)}`,
    ...(event.description ? [`DESCRIPTION:${icsText(event.description)}`] : []),
    ...(opts.place ? [`LOCATION:${icsText(opts.place)}`] : []),
    `STATUS:${event.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ]
  return lines.map(icsFold).join('\r\n') + '\r\n'
}

/** A safe file name for the download: "game-night.ics". */
export function icsFileName(title: string): string {
  const slug = title.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().toLowerCase().replace(/[\s_]+/g, '-').slice(0, 60)
  return `${slug || 'event'}.ics`
}
