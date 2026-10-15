import { describe, expect, it } from 'vitest'
import {
  MAX_WORDS, addWord, alertPattern, alertRanges, cleanWord, emptyAlerts, matchesAlert, parseAlerts, parseClock, quietActive,
  sameCopy, serverCopy, wordsFor, type AlertSettings,
} from './alertsLogic'
import type { QuietHours } from '../core/protocol'

const A = 'A'.repeat(43)
const B = 'B'.repeat(43)

describe('alert words', () => {
  const p = alertPattern(['pizza', 'raid night', 'ölkväll', 'C++'])
  it.each([
    ['Anyone for pizza tonight?', true],
    ['PIZZA!', true],
    ['"Pizza", she said.', true],
    ['pizzas are great', false],
    ['pepperonipizza', false],
    ['pizza_time', false],
    ['the raid   night is on', true],
    ['raid nightly', false],
    ['Ölkväll på fredag', true],
    ['ölkvällen', false],
    ['I write C++ code', true],
    ['', false],
  ])('%s → %s', (text, expected) => expect(matchesAlert(p, text)).toBe(expected))

  it('treats words as literal text', () => {
    expect(matchesAlert(alertPattern(['a.c', '(x+)+$']), 'abc xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx!')).toBe(false)
    expect(matchesAlert(alertPattern(['a.c']), 'is a.c here')).toBe(true)
  })

  it('finds every place for marking', () => {
    expect(alertRanges(alertPattern(['pizza']), 'pizza and Pizza, pizzas')).toEqual([[0, 5], [10, 15]])
    expect(alertRanges(null, 'pizza')).toEqual([])
    // The same shared pattern right after a test() still finds them all.
    const shared = alertPattern(['pizza'])
    expect(matchesAlert(shared, 'a pizza')).toBe(true)
    expect(alertRanges(shared, 'a pizza')).toEqual([[2, 7]])
  })

  it('cleans and limits the list', () => {
    expect(cleanWord('  raid   night ')).toBe('raid night')
    expect(cleanWord('a\u0007b')).toBeNull()
    expect(cleanWord('x'.repeat(51))).toBeNull()
    expect(cleanWord('   ')).toBeNull()
    let words = addWord([], 'Pizza')!
    expect(addWord(words, 'pizza')).toBeNull() // already there
    words = addWord(words, 'pizza', A)! // the same word for one server is its own entry
    expect(words).toHaveLength(2)
    for (let i = words.length; i < MAX_WORDS; i++) words = addWord(words, `w${i}`)!
    expect(addWord(words, 'one more')).toBeNull()
  })

  it('knows which words count where', () => {
    const words = [{ text: 'pizza' }, { text: 'raid', server: A }, { text: 'PIZZA', server: B }]
    expect(wordsFor(words, A)).toEqual(['pizza', 'raid'])
    expect(wordsFor(words, B)).toEqual(['pizza'])
    expect(wordsFor(words, null)).toEqual(['pizza'])
  })
})

describe('what servers keep', () => {
  const quiet: QuietHours = { days: 62, from: 1320, to: 420, timeZone: 'Europe/Stockholm', mentions: true }
  const base: AlertSettings = { ...emptyAlerts(), words: [{ text: 'pizza' }, { text: 'raid', server: B }], quiet, updatedAt: 1 }

  it('keeps words only when asked to, and quiet hours only where push needs them', () => {
    expect(serverCopy(base, A, true, null)).toEqual({ words: [], quiet: null })
    expect(serverCopy({ ...base, closed: true }, A, false, null)).toEqual({ words: ['pizza'], quiet: null })
    expect(serverCopy({ ...base, quietOn: true }, A, false, null).quiet).toBeNull()
    expect(serverCopy({ ...base, quietOn: true }, A, true, null).quiet).toEqual(quiet)
    // Another device with push on put them there: keep them up to date.
    expect(serverCopy({ ...base, quietOn: true }, A, false, { words: [], quiet: { ...quiet, from: 0 } }).quiet).toEqual(quiet)
    expect(serverCopy({ ...base, quietOn: false }, A, false, { words: [], quiet }).quiet).toBeNull()
  })

  it('compares copies', () => {
    expect(sameCopy({ words: ['a'], quiet }, { words: ['a'], quiet: { ...quiet } })).toBe(true)
    expect(sameCopy({ words: ['a'], quiet }, { words: ['a'], quiet: null })).toBe(false)
    expect(sameCopy(null, { words: [], quiet: null })).toBe(false)
  })

  it('checks settings from storage or another device', () => {
    expect(parseAlerts(null)).toBeNull()
    expect(parseAlerts({ words: 'x', updatedAt: 1 })).toBeNull()
    const parsed = parseAlerts({ words: [{ text: ' pizza ' }, { text: 'x', server: 'nope' }, { bad: 1 }], updatedAt: 5, closed: true, quietOn: true,
      quiet: { days: 200, from: 0, to: 60, timeZone: 'UTC' } })!
    expect(parsed.words).toEqual([{ text: 'pizza' }, { text: 'x' }])
    expect(parsed.closed).toBe(true)
    expect(parsed.quiet.days).toBe(62) // bad schedule: the default
    expect(parseAlerts({ words: [], updatedAt: 1, quiet: { days: 1, from: 0, to: 60, timeZone: 'Mars/Olympus' } })!.quiet.timeZone).not.toBe('Mars/Olympus')
  })
})

describe('quiet hours', () => {
  const q = (days: number, from: number, to: number, timeZone = 'Europe/Stockholm'): QuietHours => ({ days, from, to, timeZone, mentions: false })
  const at = (iso: string) => new Date(iso + 'Z')
  const weekdays = 0b0111110

  it.each([
    ['2026-07-01T19:59', false], // Wed 21:59 in Stockholm (UTC+2)
    ['2026-07-01T20:00', true], // Wed 22:00
    ['2026-07-02T04:59', true], // Thu 06:59: Wednesday's night
    ['2026-07-02T05:00', false], // Thu 07:00
    ['2026-07-04T21:00', false], // Sat 23:00: Saturday isn't picked
    ['2026-07-04T03:00', true], // Sat 05:00: Friday's night runs on
    ['2026-07-05T23:30', false], // Mon 01:30: Sunday's night, not picked
    ['2026-07-06T20:30', true], // Mon 22:30
  ])('weeknights 22–07 in Stockholm at %s UTC → %s', (iso, expected) => expect(quietActive(q(weekdays, 1320, 420), at(iso))).toBe(expected))

  it('follows the schedule’s time zone, not UTC or this device', () => {
    const friday = q(1 << 5, 23 * 60, 2 * 60, 'America/New_York')
    expect(quietActive(friday, at('2026-01-10T04:30'))).toBe(true) // Fri 23:30 in New York
    expect(quietActive(friday, at('2026-01-10T06:59'))).toBe(true) // Sat 01:59
    expect(quietActive(friday, at('2026-01-10T07:00'))).toBe(false)
    expect(quietActive(friday, at('2026-01-09T23:30'))).toBe(false) // only 18:30 there
    // Winter time in Stockholm is UTC+1.
    expect(quietActive(q(weekdays, 1320, 420), at('2026-01-07T21:00'))).toBe(true) // Wed 22:00
    expect(quietActive(q(weekdays, 1320, 420), at('2026-01-07T20:59'))).toBe(false)
  })

  it('handles same-day stretches, whole days and unknown zones', () => {
    const saturday = 1 << 6
    expect(quietActive(q(saturday, 540, 720, 'UTC'), at('2026-01-10T11:59'))).toBe(true)
    expect(quietActive(q(saturday, 540, 720, 'UTC'), at('2026-01-10T12:00'))).toBe(false)
    expect(quietActive(q(saturday, 0, 0, 'UTC'), at('2026-01-10T23:59'))).toBe(true)
    expect(quietActive(q(saturday, 0, 0, 'UTC'), at('2026-01-11T00:00'))).toBe(false)
    expect(quietActive(q(saturday, 0, 0, 'Nowhere/Else'), at('2026-01-10T12:00'))).toBe(false)
  })

  it('reads times', () => {
    expect(parseClock('22:30')).toBe(1350)
    expect(parseClock('7:05')).toBe(425)
    expect(parseClock('24:00')).toBeNull()
    expect(parseClock('nope')).toBeNull()
  })
})
