// Keeping the phone's own calendar in step with a server's events (the phone apps only; state/phoneCalendar.ts runs
// it). The app writes one phone-calendar event per Iskra event (one per series for a repeating event), remembers
// which is which on this device, and works out here what to add, change and remove. Pure: no bridge, no storage.
import type { ServerEvent } from '../core/protocol'
import { nextStart } from './calendarLogic'
import { icsRule } from './eventTime'

/** What the phone's calendar is given for one event. */
export interface PhoneEventFields {
  title: string
  description: string
  location: string
  startMs: number
  endMs: number
  timeZone: string
  /** An RRULE value for a repeating event ("FREQ=WEEKLY;INTERVAL=2;UNTIL=20261231T225959Z"). */
  rrule?: string
}

/** One phone-calendar event this device made. */
export interface PhoneEntry {
  /** The phone calendar's id for it. */
  nativeId: string
  /** What was written, to tell when it needs writing again. */
  hash: string
  /** When the Iskra event (or the occurrence last seen) ends. */
  endAt: number
  /** A series' occurrence that has another one after it: when it's gone before then, the series was cancelled. */
  more: boolean
}

/** Sync key → entry. The key is `e<event id>` for a one-off and `s<series id>` for a series. */
export type PhoneMap = Record<string, PhoneEntry>

export interface PhoneSave {
  key: string
  /** The phone-calendar event to change; none to add a new one. */
  nativeId?: string
  fields: PhoneEventFields
  entry: Omit<PhoneEntry, 'nativeId'>
}

export interface PhonePlan {
  save: PhoneSave[]
  /** Events to delete from the phone's calendar: cancelled, or no longer visible to this person. */
  remove: { key: string; nativeId: string }[]
  /** Events that are over: they stay in the phone's calendar as they are, and are no longer tracked. */
  forget: string[]
}

/** A series is one phone-calendar event, whichever occurrence the server has open. */
export const syncKey = (event: Pick<ServerEvent, 'id' | 'repeat' | 'seriesId'>): string =>
  event.repeat !== 'none' && event.seriesId !== null ? `s${event.seriesId}` : `e${event.id}`

/** The marker that says a phone-calendar event is Iskra's: the native side only changes events that carry one. */
export const syncRef = (serverKey: string, key: string): string => `iskra://event/${serverKey}/${key}`

export function phoneFields(event: ServerEvent, place: string): PhoneEventFields {
  const rrule = icsRule(event)
  return {
    title: event.title,
    description: event.description ?? '',
    location: place,
    startMs: event.startAt,
    endMs: event.endAt,
    timeZone: event.timeZone,
    ...(rrule ? { rrule } : {}),
  }
}

/** Fields in a fixed order plus the calendar they go to: equal strings mean nothing to write. */
export function fieldsHash(fields: PhoneEventFields, calendarId: string): string {
  return JSON.stringify([calendarId, fields.title, fields.description, fields.location, fields.startMs, fields.endMs, fields.timeZone, fields.rrule ?? ''])
}

/**
 * What to do so the phone's calendar matches `events`: the server's scheduled and live events this person can see
 * (never ones in an encrypted channel; the caller leaves those out), each with its place in words.
 *
 * An event the server no longer lists was either cancelled (or hidden from this person) or is simply over. One whose
 * end has passed is over and stays in the calendar, unless it's an occurrence of a series that should have been
 * followed by another: then the series was cancelled. Anything else that is gone is deleted.
 */
export function planSync(events: { event: ServerEvent; place: string }[], map: PhoneMap, calendarId: string, now: number): PhonePlan {
  const plan: PhonePlan = { save: [], remove: [], forget: [] }
  const wanted = new Set<string>()
  for (const { event, place } of events) {
    if (event.status !== 'scheduled' && event.status !== 'live') continue
    const key = syncKey(event)
    if (wanted.has(key)) continue // one open occurrence per series; a second would be a server bug
    wanted.add(key)
    const fields = phoneFields(event, place)
    const hash = fieldsHash(fields, calendarId)
    const known = map[key]
    if (known?.hash === hash) continue
    plan.save.push({
      key, fields, ...(known ? { nativeId: known.nativeId } : {}),
      entry: { hash, endAt: event.endAt, more: hasMore(event) },
    })
  }
  for (const [key, entry] of Object.entries(map)) {
    if (wanted.has(key)) continue
    if (!entry.more && entry.endAt <= now) plan.forget.push(key)
    else plan.remove.push({ key, nativeId: entry.nativeId })
  }
  return plan
}

/** Whether the series has an occurrence after this one (always false for a one-off). */
function hasMore(event: ServerEvent): boolean {
  const next = nextStart(event.startAt, event.repeat, event.timeZone)
  return next !== null && (event.until === null || next <= event.until)
}

/** Stored state for one server on this device, checked on the way in (it comes from localStorage). */
export interface PhoneCalendarChoice {
  calendarId: string
  calendarName: string
  map: PhoneMap
}

export function parseChoices(raw: unknown): Record<string, PhoneCalendarChoice> {
  const out: Record<string, PhoneCalendarChoice> = {}
  if (typeof raw !== 'object' || raw === null) return out
  for (const [serverKey, value] of Object.entries(raw as Record<string, unknown>)) {
    const v = value as Partial<PhoneCalendarChoice> | null
    if (!v || typeof v.calendarId !== 'string' || typeof v.calendarName !== 'string' || typeof v.map !== 'object' || v.map === null) continue
    const map: PhoneMap = {}
    for (const [key, entry] of Object.entries(v.map as Record<string, Partial<PhoneEntry> | null>)) {
      if (!/^[es]\d+$/.test(key) || !entry || typeof entry.nativeId !== 'string' || typeof entry.hash !== 'string' || typeof entry.endAt !== 'number') continue
      map[key] = { nativeId: entry.nativeId, hash: entry.hash, endAt: entry.endAt, more: entry.more === true }
    }
    out[serverKey] = { calendarId: v.calendarId, calendarName: v.calendarName, map }
  }
  return out
}

/** A calendar the phone offers, as the native side lists it (checked: it crosses the bridge). */
export interface PhoneCalendar {
  id: string
  name: string
  account: string
  primary: boolean
}

export function parseCalendars(raw: unknown): PhoneCalendar[] {
  const list = (raw as { calendars?: unknown } | null)?.calendars
  if (!Array.isArray(list)) return []
  const out: PhoneCalendar[] = []
  for (const item of list as Partial<PhoneCalendar>[]) {
    if (!item || typeof item.id !== 'string' || !item.id || typeof item.name !== 'string') continue
    out.push({ id: item.id, name: item.name.slice(0, 200), account: typeof item.account === 'string' ? item.account.slice(0, 200) : '', primary: item.primary === true })
  }
  return out.slice(0, 200)
}
