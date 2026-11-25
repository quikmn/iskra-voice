import { describe, expect, it } from 'vitest'
import type { ServerEvent } from '../core/protocol'
import {
  addDays, agenda, birthdayIn, dayOf, dayStart, feedBase, feedLinks, isPublicHttps, itemsByDay, monthGrid, newEventStart, nextStart, occurrences,
  shiftMonth, weekdayOf, weekStartOf,
} from './calendarLogic'
import { utcToZoned, zonedToUtc } from './eventTime'

const HOUR = 3_600_000
const STOCKHOLM = 'Europe/Stockholm'
const QUITO = 'America/Guayaquil'
const at = (date: string, time: string, zone: string) => zonedToUtc(date, time, zone)!

function event(over: Partial<ServerEvent> = {}): ServerEvent {
  const startAt = over.startAt ?? at('2026-10-22', '20:00', STOCKHOLM)
  return {
    id: 1, title: 'Raid night', description: null, startAt, endAt: startAt + 2 * HOUR, timeZone: STOCKHOLM,
    location: { kind: 'place', text: 'Discord' }, image: null, createdBy: 'k', createdAt: 0, status: 'scheduled', interested: [],
    repeat: 'none', until: null, seriesId: null, ...over,
  }
}

describe('days', () => {
  it('moves across months and years', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29')
    expect(weekdayOf('2026-10-24')).toBe(6) // a Saturday
  })

  it('puts an instant on the viewer\'s day, which differs between Sweden and Ecuador', () => {
    // 01:00 on the 25th in Stockholm is still the evening of the 24th in Ecuador.
    const instant = at('2026-07-25', '01:00', STOCKHOLM)
    expect(dayOf(instant, STOCKHOLM)).toBe('2026-07-25')
    expect(dayOf(instant, QUITO)).toBe('2026-07-24')
    expect(utcToZoned(instant, QUITO).time).toBe('18:00')
  })

  it('starts a day at local midnight, also on the days the clocks change', () => {
    expect(dayStart('2026-03-29', STOCKHOLM)).toBe(Date.UTC(2026, 2, 28, 23))
    expect(dayStart('2026-03-30', STOCKHOLM) - dayStart('2026-03-29', STOCKHOLM)).toBe(23 * HOUR)
    expect(dayStart('2026-10-26', STOCKHOLM) - dayStart('2026-10-25', STOCKHOLM)).toBe(25 * HOUR)
    expect(dayStart('2026-03-29', QUITO)).toBe(Date.UTC(2026, 2, 29, 5))
  })
})

describe('nextStart', () => {
  it('keeps the wall-clock time in the event\'s zone across a clock change', () => {
    // Thursdays 20:00 in Stockholm. Summer time ends on 25 October 2026.
    const before = at('2026-10-22', '20:00', STOCKHOLM)
    const after = nextStart(before, 'weekly', STOCKHOLM)!
    expect(utcToZoned(after, STOCKHOLM)).toEqual({ date: '2026-10-29', time: '20:00' })
    expect(after - before).toBe(7 * 24 * HOUR + HOUR)
    // In Ecuador (no clock changes) the same raid moves from 13:00 to 14:00.
    expect(utcToZoned(before, QUITO).time).toBe('13:00')
    expect(utcToZoned(after, QUITO).time).toBe('14:00')
  })

  it('and in spring, when the clocks go forward', () => {
    const before = at('2026-03-26', '20:00', STOCKHOLM)
    const after = nextStart(before, 'weekly', STOCKHOLM)!
    expect(after - before).toBe(7 * 24 * HOUR - HOUR)
    expect(utcToZoned(before, QUITO).time).toBe('14:00')
    expect(utcToZoned(after, QUITO).time).toBe('13:00')
  })

  it('an event made in Ecuador stays at its time there and moves for Sweden', () => {
    const before = at('2026-10-22', '19:00', QUITO)
    const after = nextStart(before, 'weekly', QUITO)!
    expect(after - before).toBe(7 * 24 * HOUR)
    expect(utcToZoned(before, STOCKHOLM)).toEqual({ date: '2026-10-23', time: '02:00' })
    expect(utcToZoned(after, STOCKHOLM)).toEqual({ date: '2026-10-30', time: '01:00' })
  })

  it('steps a day, two weeks and a month', () => {
    const start = at('2026-01-15', '18:30', STOCKHOLM)
    expect(utcToZoned(nextStart(start, 'daily', STOCKHOLM)!, STOCKHOLM)).toEqual({ date: '2026-01-16', time: '18:30' })
    expect(utcToZoned(nextStart(start, 'biweekly', STOCKHOLM)!, STOCKHOLM)).toEqual({ date: '2026-01-29', time: '18:30' })
    expect(utcToZoned(nextStart(start, 'monthly', STOCKHOLM)!, STOCKHOLM)).toEqual({ date: '2026-02-15', time: '18:30' })
    expect(nextStart(start, 'none', STOCKHOLM)).toBeNull()
  })

  it('a month after the 31st is the last day of a shorter month, and December leads to January', () => {
    expect(utcToZoned(nextStart(at('2026-01-31', '18:00', STOCKHOLM), 'monthly', STOCKHOLM)!, STOCKHOLM).date).toBe('2026-02-28')
    expect(utcToZoned(nextStart(at('2028-01-31', '18:00', STOCKHOLM), 'monthly', STOCKHOLM)!, STOCKHOLM).date).toBe('2028-02-29')
    expect(utcToZoned(nextStart(at('2026-12-15', '18:00', STOCKHOLM), 'monthly', STOCKHOLM)!, STOCKHOLM).date).toBe('2027-01-15')
  })

  it('a time the clocks skip moves forward, as the server does', () => {
    // 02:30 doesn't exist in Stockholm on 29 March 2026.
    const next = nextStart(at('2026-03-28', '02:30', STOCKHOLM), 'daily', STOCKHOLM)!
    expect(utcToZoned(next, STOCKHOLM)).toEqual({ date: '2026-03-29', time: '03:30' })
  })
})

describe('occurrences', () => {
  it('a one-off is itself, when it starts in the range', () => {
    const e = event()
    expect(occurrences(e, e.startAt - HOUR, e.startAt + HOUR)).toEqual([{ event: e, startAt: e.startAt, endAt: e.endAt, projected: false }])
    expect(occurrences(e, e.startAt + 1, e.startAt + HOUR)).toEqual([])
    expect(occurrences(e, e.startAt - HOUR, e.startAt)).toEqual([])
  })

  it('a weekly series fills the range and stops at until', () => {
    const e = event({ repeat: 'weekly', seriesId: 1, until: at('2026-11-12', '23:59', STOCKHOLM) })
    const found = occurrences(e, dayStart('2026-10-01', STOCKHOLM), dayStart('2027-01-01', STOCKHOLM))
    expect(found.map((o) => utcToZoned(o.startAt, STOCKHOLM).date)).toEqual(['2026-10-22', '2026-10-29', '2026-11-05', '2026-11-12'])
    expect(found.map((o) => utcToZoned(o.startAt, STOCKHOLM).time)).toEqual(['20:00', '20:00', '20:00', '20:00'])
    expect(found.map((o) => o.projected)).toEqual([false, true, true, true])
    expect(found.every((o) => o.endAt - o.startAt === 2 * HOUR)).toBe(true)
  })

  it('only returns the part of a series inside the range', () => {
    const e = event({ repeat: 'daily', seriesId: 1 })
    const found = occurrences(e, dayStart('2026-11-01', STOCKHOLM), dayStart('2026-11-04', STOCKHOLM))
    expect(found.map((o) => utcToZoned(o.startAt, STOCKHOLM).date)).toEqual(['2026-11-01', '2026-11-02', '2026-11-03'])
  })

  it('a daily series with no end is cut off, not endless', () => {
    const e = event({ repeat: 'daily', seriesId: 1 })
    expect(occurrences(e, 0, Number.MAX_SAFE_INTEGER).length).toBe(800)
  })
})

describe('itemsByDay', () => {
  it('puts each occurrence on the viewer\'s day', () => {
    // Fridays 01:00 in Stockholm: Thursday evening in Ecuador.
    const e = event({ startAt: at('2026-10-23', '01:00', STOCKHOLM), repeat: 'weekly', seriesId: 1 })
    const sweden = itemsByDay([e], [], '2026-10-19', '2026-11-01', STOCKHOLM)
    const ecuador = itemsByDay([e], [], '2026-10-19', '2026-11-01', QUITO)
    expect([...sweden.keys()]).toEqual(['2026-10-23', '2026-10-30'])
    expect([...ecuador.keys()]).toEqual(['2026-10-22', '2026-10-29'])
  })

  it('sorts a day by time with birthdays first, and leaves out other days', () => {
    const late = event({ id: 2, title: 'Late', startAt: at('2026-10-24', '22:00', STOCKHOLM) })
    const early = event({ id: 3, title: 'Early', startAt: at('2026-10-24', '09:00', STOCKHOLM) })
    const other = event({ id: 4, startAt: at('2026-11-20', '09:00', STOCKHOLM) })
    const days = itemsByDay([late, early, other], [{ accountKey: 'anna', month: 10, day: 24 }, { accountKey: 'bo', month: 3, day: 1 }], '2026-10-01', '2026-10-31', STOCKHOLM)
    expect([...days.keys()]).toEqual(['2026-10-24'])
    expect(days.get('2026-10-24')!.map((i) => (i.kind === 'birthday' ? i.accountKey : i.event.title))).toEqual(['anna', 'Early', 'Late'])
  })

  it('shows a birthday in both years of a range over New Year', () => {
    const days = itemsByDay([], [{ accountKey: 'anna', month: 1, day: 2 }, { accountKey: 'bo', month: 12, day: 30 }], '2026-12-28', '2027-01-10', STOCKHOLM)
    expect([...days.keys()].sort()).toEqual(['2026-12-30', '2027-01-02'])
  })

  it('29 February is celebrated on the 28th in other years', () => {
    expect(birthdayIn({ month: 2, day: 29 }, 2028)).toBe('2028-02-29')
    expect(birthdayIn({ month: 2, day: 29 }, 2027)).toBe('2027-02-28')
  })
})

describe('agenda', () => {
  it('lists the days that have something, in order', () => {
    const weekly = event({ repeat: 'weekly', seriesId: 1 })
    const days = agenda([weekly], [{ accountKey: 'anna', month: 10, day: 25 }], '2026-10-22', 10, STOCKHOLM)
    expect(days.map((d) => d.day)).toEqual(['2026-10-22', '2026-10-25', '2026-10-29'])
    expect(days[2].items[0]).toMatchObject({ kind: 'event', projected: true })
  })
})

describe('monthGrid', () => {
  it('October 2026 starting on Monday: five weeks from 28 September', () => {
    const weeks = monthGrid(2026, 9, 1)
    expect(weeks.length).toBe(5)
    expect(weeks[0][0]).toEqual({ day: '2026-09-28', inMonth: false })
    expect(weeks[0][3]).toEqual({ day: '2026-10-01', inMonth: true })
    expect(weeks[4][6]).toEqual({ day: '2026-11-01', inMonth: false })
    expect(weeks.every((w) => w.length === 7)).toBe(true)
  })

  it('the same month starting on Sunday', () => {
    const weeks = monthGrid(2026, 9, 0)
    expect(weeks[0][0].day).toBe('2026-09-27')
    expect(weeks[weeks.length - 1][6].day).toBe('2026-10-31')
  })

  it('a February that fits four weeks exactly, and months that need six', () => {
    expect(monthGrid(2027, 1, 1).length).toBe(4) // 1 February 2027 is a Monday
    expect(monthGrid(2026, 7, 1).length).toBe(6) // August 2026 starts on a Saturday
  })

  it('moves between months over the year\'s end', () => {
    expect(shiftMonth({ year: 2026, month: 11 }, 1)).toEqual({ year: 2027, month: 0 })
    expect(shiftMonth({ year: 2026, month: 0 }, -1)).toEqual({ year: 2025, month: 11 })
  })

  it('weeks start on Monday in Sweden and Ecuador and on Sunday in the US', () => {
    expect(weekStartOf('sv-SE')).toBe(1)
    expect(weekStartOf('de-DE')).toBe(1)
    expect(weekStartOf('en-US')).toBe(0)
    expect(weekStartOf('es-EC')).toBe(1)
    expect(weekStartOf('not a locale')).toBe(1)
  })
})

describe('new events from a day', () => {
  it('start at 19:00 on that day in the viewer\'s zone', () => {
    expect(utcToZoned(newEventStart('2026-10-24', QUITO), QUITO)).toEqual({ date: '2026-10-24', time: '19:00' })
    expect(newEventStart('2026-10-24', STOCKHOLM)).toBe(Date.UTC(2026, 9, 24, 17))
  })
})

describe('the calendar link', () => {
  it('needs a public https address', () => {
    for (const url of ['https://chat.example.org', 'https://chat.example.org:8443/', 'https://203-0-113-7.sslip.io', 'https://203.0.113.7']) expect(isPublicHttps(url), url).toBe(true)
    for (const url of [
      'http://chat.example.org', 'https://localhost:47070', 'https://192.168.1.20', 'https://10.0.0.5', 'https://100.101.102.103', 'https://[::1]',
      'https://nas', 'https://nas.local', 'https://box.tailnet.ts.net', 'app://iskra', 'nonsense',
    ]) expect(isPublicHttps(url), url).toBe(false)
  })

  it('starts at the address the server reports, else the one the app uses when that is public', () => {
    expect(feedBase('https://chat.example.org', { publicUrl: null, directUrl: 'http://192.168.1.5:47070' })).toBe('https://chat.example.org')
    expect(feedBase(null, { publicUrl: 'https://1-2-3-4.sslip.io/', directUrl: 'http://192.168.1.5:47070' })).toBe('https://1-2-3-4.sslip.io')
    expect(feedBase(null, { publicUrl: null, directUrl: 'https://chat.example.org' })).toBe('https://chat.example.org')
    expect(feedBase(null, { publicUrl: null, directUrl: 'http://localhost:47070' })).toBeNull()
    expect(feedBase(null, { publicUrl: 'http://203.0.113.7:47070', directUrl: 'http://203.0.113.7:47070' })).toBeNull()
  })

  it('makes the links calendar apps take', () => {
    const links = feedLinks('https://chat.example.org', '/calendar/abc.ics', 'Raid & friends')
    expect(links.https).toBe('https://chat.example.org/calendar/abc.ics')
    expect(links.webcal).toBe('webcals://chat.example.org/calendar/abc.ics')
    expect(links.google).toBe('https://calendar.google.com/calendar/r?cid=webcal%3A%2F%2Fchat.example.org%2Fcalendar%2Fabc.ics')
    expect(links.outlook).toBe('https://outlook.live.com/calendar/0/addfromweb?url=https%3A%2F%2Fchat.example.org%2Fcalendar%2Fabc.ics&name=Raid%20%26%20friends')
  })
})
