import { describe, expect, it } from 'vitest'
import type { ServerEvent } from '../core/protocol'
import { creatorTime, eventIcs, icsFileName, icsFold, icsText, openEvents, startsIn, utcToZoned, zonedToUtc, zoneOffset } from './eventTime'

const event = (patch: Partial<ServerEvent> = {}): ServerEvent => ({
  id: 5, title: 'Game night', description: null, startAt: Date.UTC(2026, 9, 24, 17, 30), endAt: Date.UTC(2026, 9, 24, 19, 30),
  timeZone: 'Europe/Stockholm', location: { kind: 'place', text: 'Here' }, image: null, createdBy: 'k', createdAt: 0,
  status: 'scheduled', interested: [], ...patch,
})

describe('time zones', () => {
  it("converts a wall-clock time in the creator's zone to UTC, across DST", () => {
    // Stockholm: UTC+2 in summer, UTC+1 in winter (DST ends 2026-10-25).
    expect(zonedToUtc('2026-10-24', '19:30', 'Europe/Stockholm')).toBe(Date.UTC(2026, 9, 24, 17, 30))
    expect(zonedToUtc('2026-10-26', '19:30', 'Europe/Stockholm')).toBe(Date.UTC(2026, 9, 26, 18, 30))
    expect(zonedToUtc('2026-07-01', '09:00', 'America/New_York')).toBe(Date.UTC(2026, 6, 1, 13, 0))
    expect(zonedToUtc('2026-12-01', '09:00', 'America/New_York')).toBe(Date.UTC(2026, 11, 1, 14, 0))
    expect(zonedToUtc('2026-03-01', '23:15', 'Asia/Kolkata')).toBe(Date.UTC(2026, 2, 1, 17, 45))
    expect(zonedToUtc('2026-03-01', '23:15', 'UTC')).toBe(Date.UTC(2026, 2, 1, 23, 15))
  })

  it('handles times that are skipped or repeated by a DST change', () => {
    // 2026-03-29 02:30 doesn't exist in Stockholm (clocks jump 02:00 → 03:00): lands at 03:30 local.
    expect(zonedToUtc('2026-03-29', '02:30', 'Europe/Stockholm')).toBe(Date.UTC(2026, 2, 29, 1, 30))
    // 2026-10-25 02:30 happens twice: the first one (still summer time).
    expect(zonedToUtc('2026-10-25', '02:30', 'Europe/Stockholm')).toBe(Date.UTC(2026, 9, 25, 0, 30))
  })

  it('rejects garbage and round-trips', () => {
    expect(zonedToUtc('2026-1-1', '10:00', 'UTC')).toBeNull()
    expect(zonedToUtc('2026-01-01', '10', 'UTC')).toBeNull()
    const utc = zonedToUtc('2026-11-03', '07:05', 'Australia/Sydney')!
    expect(utcToZoned(utc, 'Australia/Sydney')).toEqual({ date: '2026-11-03', time: '07:05' })
    expect(zoneOffset(Date.UTC(2026, 0, 1), 'Asia/Tokyo')).toBe(9 * 3600_000)
  })

  it("shows the creator's clock only when it differs", () => {
    expect(creatorTime(event(), 'Europe/Stockholm', 'en-US')).toBeNull()
    expect(creatorTime(event(), 'Europe/Berlin', 'en-US')).toBeNull() // same offset
    expect(creatorTime(event(), 'America/New_York', 'en-US')).toMatch(/7:30.PM in Europe\/Stockholm$/)
  })

  it('says how soon', () => {
    expect(startsIn(1000, 2000)).toBeNull()
    expect(startsIn(25 * 60_000, 0)).toBe('in 25 min')
    expect(startsIn(3 * 3600_000, 0)).toBe('in 3 h')
    expect(startsIn(49 * 3600_000, 0)).toBe('in 2 days')
  })

  it('lists open events soonest first', () => {
    const list = openEvents([event({ id: 1, startAt: 50 }), event({ id: 2, status: 'cancelled' }), event({ id: 3, startAt: 10, status: 'live' })])
    expect(list.map((e) => e.id)).toEqual([3, 1])
  })
})

describe('iCalendar', () => {
  it('builds a valid event with UTC times and escaped text', () => {
    const ics = eventIcs(event({ description: 'Bring snacks; chips, dip\nand \\ more' }), {
      serverKey: 'abc', place: 'lounge (voice) on Gaming', now: Date.UTC(2026, 9, 10, 8),
    })
    expect(ics.endsWith('\r\n')).toBe(true)
    const lines = ics.split('\r\n')
    expect(lines[0]).toBe('BEGIN:VCALENDAR')
    expect(lines).toContain('DTSTART:20261024T173000Z')
    expect(lines).toContain('DTEND:20261024T193000Z')
    expect(lines).toContain('DTSTAMP:20261010T080000Z')
    expect(lines).toContain('UID:event-5-abc@iskra')
    expect(lines).toContain('SUMMARY:Game night')
    expect(lines).toContain('DESCRIPTION:Bring snacks\\; chips\\, dip\\nand \\\\ more')
    expect(lines).toContain('LOCATION:lounge (voice) on Gaming')
    expect(lines).toContain('STATUS:CONFIRMED')
    expect(eventIcs(event({ status: 'cancelled' }), { serverKey: 'a', place: '' })).toContain('STATUS:CANCELLED')
  })

  it('escapes and folds long lines without splitting characters', () => {
    expect(icsText('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne')
    const folded = icsFold('SUMMARY:' + 'å'.repeat(80))
    const parts = folded.split('\r\n ')
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75)
    expect(parts.join('')).toBe('SUMMARY:' + 'å'.repeat(80))
    expect(icsFold('short')).toBe('short')
  })

  it('makes a safe file name', () => {
    expect(icsFileName('Game night: Café edition!')).toBe('game-night-cafe-edition.ics')
    expect(icsFileName('🎉🎉')).toBe('event.ics')
  })
})
