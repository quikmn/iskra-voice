// "Put this server's events in my phone's calendar" (the phone apps): the app writes each event the person can see
// into a calendar they pick on the phone, and keeps it in step: changed when the event changes, deleted when it's
// cancelled or the option is turned off. The phone syncs that calendar to the person's own account (Google, Outlook,
// iCloud) itself; nothing goes anywhere else. Which phone-calendar event belongs to which Iskra event is remembered
// on this device only (phoneCalendarLogic.ts has the rules).
import { create } from 'zustand'
import type { ServerEvent } from '../core/protocol'
import { logError } from '../core/log'
import { native } from '../platform/native'
import { useEvents } from './events'
import { parseCalendars, parseChoices, planSync, syncRef, type PhoneCalendar, type PhoneCalendarChoice, type PhoneMap } from './phoneCalendarLogic'
import { useApp, type ServerState } from './store'

const KEY = 'iskra.phoneCalendar.v1'
/** Events arrive in bursts (a series' occurrence ends and the next one is made): wait for the burst to finish. */
const SETTLE_MS = 1500

interface PhoneCalendarState {
  /** `<serverKey>/<accountKey>` → the calendar chosen for that server and what was written to it. */
  choices: Record<string, PhoneCalendarChoice>
}

function read(): Record<string, PhoneCalendarChoice> {
  try {
    return parseChoices(JSON.parse(localStorage.getItem(KEY) ?? '{}'))
  } catch {
    return {}
  }
}

export const usePhoneCalendar = create<PhoneCalendarState>(() => ({ choices: native?.calendar ? read() : {} }))

function write(choices: Record<string, PhoneCalendarChoice>): void {
  usePhoneCalendar.setState({ choices })
  try {
    localStorage.setItem(KEY, JSON.stringify(choices))
  } catch {
    /* storage full or blocked: the choice lasts until the app closes */
  }
}

/** Whether this app can write to the phone's calendar at all. */
export const phoneCalendarAvailable = (): boolean => !!native?.calendar

const idOf = (server: ServerState): string | null => (server.me ? `${server.key}/${server.me.accountKey}` : null)

export const usePhoneCalendarChoice = (server: ServerState): PhoneCalendarChoice | undefined =>
  usePhoneCalendar((s) => (server.me ? s.choices[`${server.key}/${server.me.accountKey}`] : undefined))

/** The calendars the phone offers, asking for access first. Null: the person said no. */
export async function phoneCalendars(): Promise<PhoneCalendar[] | null> {
  const calendar = native?.calendar
  if (!calendar) return null
  if (!(await calendar.access(true))) return null
  return parseCalendars(await calendar.list())
}

/** Turns it on for a server (or moves it to another calendar) and writes the events. */
export async function choosePhoneCalendar(server: ServerState, calendar: PhoneCalendar): Promise<void> {
  const id = idOf(server)
  if (!id) return
  const choices = usePhoneCalendar.getState().choices
  write({ ...choices, [id]: { calendarId: calendar.id, calendarName: calendar.name, map: choices[id]?.map ?? {} } })
  await syncNow(server.key)
}

/** Turns it off and removes every event this app put in the phone's calendar for that server. */
export async function stopPhoneCalendar(server: ServerState): Promise<void> {
  const id = idOf(server)
  const choice = id ? usePhoneCalendar.getState().choices[id] : undefined
  if (!id || !choice) return
  await enqueue(async () => {
    await native?.calendar?.remove(Object.values(choice.map).map((entry) => entry.nativeId))
    const rest = { ...usePhoneCalendar.getState().choices }
    delete rest[id]
    write(rest)
  })
}

/** Where an event is, for the phone's calendar: the place, or the voice channel and the server. */
function placeOf(server: ServerState, event: ServerEvent): string {
  if (event.location.kind === 'place') return event.location.text
  const channelId = event.location.channelId
  const channel = server.channels.find((c) => c.id === channelId)
  return channel ? `${channel.name} · ${server.name}` : server.name
}

/** Events in an encrypted channel never leave the app. */
function inEncryptedChannel(server: ServerState, event: ServerEvent): boolean {
  if (event.location.kind !== 'voice') return false
  const channelId = event.location.channelId
  return !!server.channels.find((c) => c.id === channelId)?.e2ee
}

// One native call at a time, in order.
let queue: Promise<void> = Promise.resolve()
function enqueue(work: () => Promise<void>): Promise<void> {
  const run = queue.then(work)
  queue = run.catch(() => undefined)
  return run
}

function syncNow(serverKey: string): Promise<void> {
  return enqueue(async () => {
    const calendar = native?.calendar
    const server = useApp.getState().servers[serverKey]
    const id = server ? idOf(server) : null
    const events = useEvents.getState().events[serverKey]
    const choice = id ? usePhoneCalendar.getState().choices[id] : undefined
    // Not before this server's events have loaded: an empty list would look like everything was cancelled.
    if (!calendar || !server || !id || !choice || !events) return
    if (!(await calendar.access(false))) return
    const visible = Object.values(events).filter((event) => !inEncryptedChannel(server, event)).map((event) => ({ event, place: placeOf(server, event) }))
    const plan = planSync(visible, choice.map, choice.calendarId, Date.now())
    if (plan.save.length + plan.remove.length + plan.forget.length === 0) return
    const map: PhoneMap = { ...choice.map }
    const save = () => write({ ...usePhoneCalendar.getState().choices, [id]: { ...choice, map: { ...map } } })
    try {
      await calendar.remove(plan.remove.map((r) => r.nativeId))
      for (const key of [...plan.remove.map((r) => r.key), ...plan.forget]) delete map[key]
      for (const item of plan.save) {
        const nativeId = await calendar.save({ calendarId: choice.calendarId, ...(item.nativeId ? { eventId: item.nativeId } : {}), ref: syncRef(serverKey, item.key), ...item.fields })
        map[item.key] = { nativeId, ...item.entry }
        save() // after each one, so a failure further on never loses track of what was written
      }
      save()
    } catch (e) {
      save()
      logError('ui', 'phone-calendar', e)
    }
  })
}

const timers = new Map<string, ReturnType<typeof setTimeout>>()

function schedule(serverKey: string): void {
  clearTimeout(timers.get(serverKey))
  timers.set(serverKey, setTimeout(() => {
    timers.delete(serverKey)
    void syncNow(serverKey).catch(() => undefined)
  }, SETTLE_MS))
}

if (native?.calendar) {
  // Whenever a server's events change (loaded, edited, cancelled, a new occurrence), if it's turned on for that server.
  useEvents.subscribe((state, before) => {
    const on = new Set(Object.keys(usePhoneCalendar.getState().choices).map((id) => id.split('/')[0]))
    for (const serverKey of on) if (state.events[serverKey] !== before.events[serverKey]) schedule(serverKey)
  })
  // …and when channels change: a voice channel renamed, or made encrypted.
  useApp.subscribe((state, before) => {
    for (const id of Object.keys(usePhoneCalendar.getState().choices)) {
      const serverKey = id.split('/')[0]
      if (state.servers[serverKey]?.channels !== before.servers[serverKey]?.channels) schedule(serverKey)
    }
  })
}
