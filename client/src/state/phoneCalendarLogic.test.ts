import { describe, expect, it } from 'vitest'
import type { ServerEvent } from '../core/protocol'
import { zonedToUtc } from './eventTime'
import { fieldsHash, parseCalendars, parseChoices, phoneFields, planSync, syncKey, syncRef, type PhoneMap } from './phoneCalendarLogic'

const HOUR = 3_600_000
const STOCKHOLM = 'Europe/Stockholm'
const start = zonedToUtc('2026-10-22', '20:00', STOCKHOLM)!
const NOW = start - 24 * HOUR
const CAL = '7'

function event(over: Partial<ServerEvent> = {}): ServerEvent {
  const startAt = over.startAt ?? start
  return {
    id: 1, title: 'Raid night', description: 'Bring potions', startAt, endAt: startAt + 2 * HOUR, timeZone: STOCKHOLM,
    location: { kind: 'place', text: 'Viktor\'s place' }, image: null, createdBy: 'k', createdAt: 0, status: 'scheduled', interested: [],
    repeat: 'none', until: null, seriesId: null, ...over,
  }
}
const seen = (e: ServerEvent, place = 'Viktor\'s place') => ({ event: e, place })

/** Applies a plan the way state/phoneCalendar.ts does, with a fake phone calendar that numbers its events. */
function apply(map: PhoneMap, plan: ReturnType<typeof planSync>, ids: { next: number }): PhoneMap {
  const out = { ...map }
  for (const key of [...plan.remove.map((r) => r.key), ...plan.forget]) delete out[key]
  for (const item of plan.save) out[item.key] = { nativeId: item.nativeId ?? `n${ids.next++}`, ...item.entry }
  return out
}

describe('what goes to the phone', () => {
  it('a one-off: its fields, and no rule', () => {
    expect(phoneFields(event(), 'lounge · Raiders')).toEqual({
      title: 'Raid night', description: 'Bring potions', location: 'lounge · Raiders', startMs: start, endMs: start + 2 * HOUR, timeZone: STOCKHOLM,
    })
    expect(phoneFields(event({ description: null }), 'x').description).toBe('')
  })

  it('a series carries its rule and end', () => {
    const until = zonedToUtc('2026-12-31', '23:59', STOCKHOLM)!
    expect(phoneFields(event({ repeat: 'biweekly', seriesId: 1, until }), 'x').rrule).toBe('FREQ=WEEKLY;INTERVAL=2;UNTIL=20261231T225900Z')
    expect(phoneFields(event({ repeat: 'daily', seriesId: 1 }), 'x').rrule).toBe('FREQ=DAILY')
  })

  it('keys a series by its series, whichever occurrence is open', () => {
    expect(syncKey(event({ id: 5 }))).toBe('e5')
    expect(syncKey(event({ id: 9, repeat: 'weekly', seriesId: 5 }))).toBe('s5')
    expect(syncRef('SERVERKEY', 's5')).toBe('iskra://event/SERVERKEY/s5')
  })
})

describe('planSync', () => {
  it('adds events that aren\'t in the phone\'s calendar yet, once', () => {
    const ids = { next: 1 }
    const events = [seen(event({ id: 1 })), seen(event({ id: 2, title: 'Movie night' }))]
    const first = planSync(events, {}, CAL, NOW)
    expect(first.save.map((s) => [s.key, s.nativeId, s.fields.title])).toEqual([['e1', undefined, 'Raid night'], ['e2', undefined, 'Movie night']])
    expect(first.remove).toEqual([])
    const map = apply({}, first, ids)
    expect(planSync(events, map, CAL, NOW)).toEqual({ save: [], remove: [], forget: [] })
  })

  it('changes the phone\'s event in place when the event changes', () => {
    const ids = { next: 1 }
    const map = apply({}, planSync([seen(event())], {}, CAL, NOW), ids)
    for (const changed of [
      seen(event({ title: 'Raid night (moved)' })), seen(event({ startAt: start + HOUR })), seen(event({ description: null })),
      seen(event({ timeZone: 'America/Guayaquil' })), seen(event(), 'Somewhere else'), seen(event({ repeat: 'weekly', seriesId: 1 })),
    ]) {
      const plan = planSync([changed], changed.event.repeat === 'none' ? map : { s1: map.e1 }, CAL, NOW)
      expect(plan.save.map((s) => s.nativeId)).toEqual(['n1'])
      expect(plan.remove).toEqual([])
    }
    // Interest and status changes write nothing.
    expect(planSync([seen(event({ interested: ['a', 'b'], status: 'live' }))], map, CAL, NOW).save).toEqual([])
  })

  it('moves everything when another calendar is picked', () => {
    const ids = { next: 1 }
    const map = apply({}, planSync([seen(event())], {}, CAL, NOW), ids)
    const plan = planSync([seen(event())], map, '8', NOW)
    expect(plan.save.map((s) => s.nativeId)).toEqual(['n1'])
    expect(plan.save[0].entry.hash).toBe(fieldsHash(plan.save[0].fields, '8'))
  })

  it('deletes a cancelled event and one the person can no longer see', () => {
    const ids = { next: 1 }
    const map = apply({}, planSync([seen(event({ id: 1 })), seen(event({ id: 2 }))], {}, CAL, NOW), ids)
    // Event 2 is gone before it has ended: cancelled, or moved to a channel this person can't read.
    const plan = planSync([seen(event({ id: 1 }))], map, CAL, NOW)
    expect(plan.remove).toEqual([{ key: 'e2', nativeId: 'n2' }])
    expect(plan.forget).toEqual([])
    expect(Object.keys(apply(map, plan, ids))).toEqual(['e1'])
    // An event the server sent as cancelled is not listed as wanted either.
    expect(planSync([seen(event({ id: 1, status: 'cancelled' }))], map, CAL, NOW).remove.map((r) => r.key)).toEqual(['e1', 'e2'])
  })

  it('leaves an event that is simply over in the phone\'s calendar', () => {
    const ids = { next: 1 }
    const map = apply({}, planSync([seen(event())], {}, CAL, NOW), ids)
    const plan = planSync([], map, CAL, start + 3 * HOUR)
    expect(plan).toEqual({ save: [], remove: [], forget: ['e1'] })
    expect(apply(map, plan, ids)).toEqual({})
  })

  it('a series stays one phone event as the server moves to the next occurrence', () => {
    const ids = { next: 1 }
    const first = event({ id: 1, repeat: 'weekly', seriesId: 1 })
    const map = apply({}, planSync([seen(first)], {}, CAL, NOW), ids)
    expect(map.s1).toMatchObject({ nativeId: 'n1', more: true })
    // The first occurrence ended and the server made the next one (a new id, the same series).
    const second = event({ id: 2, repeat: 'weekly', seriesId: 1, startAt: start + 7 * 24 * HOUR })
    const plan = planSync([seen(second)], map, CAL, start + 3 * HOUR)
    expect(plan.remove).toEqual([])
    expect(plan.save.map((s) => [s.key, s.nativeId, s.fields.startMs])).toEqual([['s1', 'n1', second.startAt]])
  })

  it('a cancelled series is deleted even after its occurrence ended; a series that ran out stays', () => {
    const ids = { next: 1 }
    const open = apply({}, planSync([seen(event({ repeat: 'weekly', seriesId: 1 }))], {}, CAL, NOW), ids)
    expect(planSync([], open, CAL, start + 3 * HOUR)).toEqual({ save: [], remove: [{ key: 's1', nativeId: 'n1' }], forget: [] })
    // Its last occurrence: nothing more before `until`.
    const last = apply({}, planSync([seen(event({ repeat: 'weekly', seriesId: 2, until: start + 24 * HOUR }))], {}, CAL, NOW), ids)
    expect(last.s2.more).toBe(false)
    expect(planSync([], last, CAL, start + 3 * HOUR)).toEqual({ save: [], remove: [], forget: ['s2'] })
    // Cancelled before it started: deleted.
    expect(planSync([], last, CAL, NOW).remove).toEqual([{ key: 's2', nativeId: 'n2' }])
  })

  it('an occurrence taken out of its series becomes its own phone event next to the series', () => {
    const ids = { next: 1 }
    const map = apply({}, planSync([seen(event({ id: 1, repeat: 'weekly', seriesId: 1 }))], {}, CAL, NOW), ids)
    // "This event only": event 1 is now a one-off, and the series goes on with event 2.
    const plan = planSync([seen(event({ id: 1, title: 'Special raid' })), seen(event({ id: 2, repeat: 'weekly', seriesId: 1, startAt: start + 7 * 24 * HOUR }))], map, CAL, NOW)
    expect(plan.save.map((s) => [s.key, s.nativeId])).toEqual([['e1', undefined], ['s1', 'n1']])
    expect(plan.remove).toEqual([])
  })
})

describe('what comes from storage and from the phone', () => {
  it('keeps well-formed choices and drops the rest', () => {
    const good = { calendarId: '7', calendarName: 'Viktor', map: { e1: { nativeId: '41', hash: 'h', endAt: 5, more: false }, s2: { nativeId: '42', hash: 'h', endAt: 6, more: true } } }
    const parsed = parseChoices({
      'server/me': good,
      broken: { calendarId: 7, calendarName: 'x', map: {} },
      partly: { calendarId: '1', calendarName: 'x', map: { e1: { nativeId: 5 }, 'x1': { nativeId: '1', hash: 'h', endAt: 1 }, e3: { nativeId: '3', hash: 'h', endAt: 1 } } },
    })
    expect(parsed['server/me']).toEqual(good)
    expect(parsed.broken).toBeUndefined()
    expect(parsed.partly.map).toEqual({ e3: { nativeId: '3', hash: 'h', endAt: 1, more: false } })
    expect(parseChoices(null)).toEqual({})
    expect(parseChoices('x')).toEqual({})
  })

  it('reads the phone\'s list of calendars', () => {
    expect(parseCalendars({ calendars: [{ id: '7', name: 'Viktor', account: 'viktor@example.org', primary: true }, { id: '', name: 'x' }, { id: '8', name: 'Work' }, null, 5] }))
      .toEqual([{ id: '7', name: 'Viktor', account: 'viktor@example.org', primary: true }, { id: '8', name: 'Work', account: '', primary: false }])
    expect(parseCalendars(null)).toEqual([])
    expect(parseCalendars({ calendars: 'no' })).toEqual([])
  })
})
