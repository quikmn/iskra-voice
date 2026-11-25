// The calendar per server: members' birthdays for the calendar view, and the person's calendar feed (the link their
// calendar app subscribes to). See "Calendar" in PROTOCOL.md.
import { create } from 'zustand'
import type { CalendarBirthday, CalendarFeedState, Events } from '../core/protocol'
import { t } from '../i18n'
import { connectionFor, onServerEvent } from './store'

interface CalendarState {
  /** serverKey → the feed's state, once asked. `null`: the server is too old to have feeds. */
  feeds: Record<string, CalendarFeedState | null | undefined>
  /**
   * serverKey → the path of the link made in this session ("/calendar/<token>.ics"). Servers keep only a hash, so the
   * link can be shown until the app restarts; after that the person makes a new one.
   */
  paths: Record<string, string | undefined>
  birthdays: Record<string, CalendarBirthday[] | undefined>
}

export const useCalendar = create<CalendarState>(() => ({ feeds: {}, paths: {}, birthdays: {} }))

function connection(serverKey: string) {
  const c = connectionFor(serverKey)
  if (!c) throw new Error(t('errors.codes.disconnected'))
  return c
}

const putFeed = (serverKey: string, feed: CalendarFeedState | null, path?: string | null) =>
  useCalendar.setState((s) => ({
    feeds: { ...s.feeds, [serverKey]: feed },
    paths: path === undefined ? s.paths : { ...s.paths, [serverKey]: path ?? undefined },
  }))

export async function loadFeed(serverKey: string): Promise<void> {
  try {
    const { feed } = await connection(serverKey).request('calendar.feed.get', {})
    // A link made on another device (or ended there) isn't the one this app remembers.
    putFeed(serverKey, feed, feed.on ? undefined : null)
  } catch (e) {
    if ((e as { code?: string }).code === 'unknown_type') putFeed(serverKey, null)
    else throw e
  }
}

/** Makes the link (a new one ends the old one). */
export async function createFeed(serverKey: string): Promise<void> {
  const { feed, path } = await connection(serverKey).request('calendar.feed.create', {})
  putFeed(serverKey, feed, path)
}

export async function removeFeed(serverKey: string): Promise<void> {
  const { feed } = await connection(serverKey).request('calendar.feed.remove', {})
  putFeed(serverKey, feed, null)
}

/** The owner's switch: whether members may make calendar links at all. */
export async function setFeedsAllowed(serverKey: string, feeds: boolean): Promise<void> {
  const { feed } = await connection(serverKey).request('calendar.settings.update', { feeds })
  putFeed(serverKey, feed, feed.on ? undefined : null)
}

/** Birthdays members shared with the Birthdays bot; none on servers without it. */
export async function loadBirthdays(serverKey: string): Promise<void> {
  try {
    const { birthdays } = await connection(serverKey).request('calendar.birthdays', {})
    useCalendar.setState((s) => ({ birthdays: { ...s.birthdays, [serverKey]: birthdays } }))
  } catch {
    /* an older server, or offline: the calendar shows events only */
  }
}

onServerEvent((serverKey, type, body) => {
  if (type !== 'calendar.settings') return
  const { feeds } = body as Events['calendar.settings']
  const known = useCalendar.getState().feeds[serverKey]
  if (!known) return
  // Turning feeds off ends every link.
  putFeed(serverKey, feeds ? { ...known, allowed: true } : { ...known, allowed: false, on: false, createdAt: null, fetchedAt: null }, feeds ? undefined : null)
})
