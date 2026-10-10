import { describe, expect, it } from 'vitest'
import { activeCustom, bestStatus, cleanCustom, clearsIn, expiryFor, isNewer, statusOf } from './presenceRules'

describe('presence rules', () => {
  it('works out when a custom status clears', () => {
    const now = new Date(2026, 9, 10, 15, 20)
    expect(expiryFor('30m', now)).toBe(now.getTime() + 30 * 60_000)
    expect(expiryFor('1h', now)).toBe(now.getTime() + 3_600_000)
    expect(expiryFor('4h', now)).toBe(now.getTime() + 4 * 3_600_000)
    expect(expiryFor('today', now)).toBe(new Date(2026, 9, 11, 0, 0).getTime())
    expect(expiryFor('never', now)).toBeNull()
  })

  it('reads status from older servers too', () => {
    expect(statusOf({ online: true })).toBe('online')
    expect(statusOf({ online: false })).toBe('offline')
    expect(statusOf({ online: true, status: 'dnd' })).toBe('dnd')
    expect(statusOf(undefined)).toBe('offline')
  })

  it('hides expired and empty custom statuses', () => {
    expect(activeCustom({ emoji: null, text: 'hi', expiresAt: 1000 }, 999)?.text).toBe('hi')
    expect(activeCustom({ emoji: null, text: 'hi', expiresAt: 1000 }, 1000)).toBeNull()
    expect(activeCustom({ emoji: null, text: null, expiresAt: null })).toBeNull()
    expect(activeCustom(null)).toBeNull()
  })

  it('cleans what you type like the server does', () => {
    expect(cleanCustom(' 🎮 ', '  raid   night ', null)).toEqual({ emoji: '🎮', text: 'raid night', expiresAt: null })
    expect(cleanCustom('', '  ', 5)).toBeNull()
    expect(() => cleanCustom('', 'x'.repeat(129), null)).toThrow()
    expect(() => cleanCustom('a b', '', null)).toThrow()
  })

  it('lets the newest choice win', () => {
    const ours = { status: 'online' as const, custom: null, updatedAt: 100 }
    expect(isNewer({ ...ours, status: 'dnd', updatedAt: 101 }, ours)).toBe(true)
    expect(isNewer({ ...ours, updatedAt: 100 }, ours)).toBe(false)
    expect(isNewer(null, ours)).toBe(false)
  })

  it('picks the most present status across servers', () => {
    expect(bestStatus(['offline', 'idle', 'dnd'])).toBe('dnd')
    expect(bestStatus(['idle', 'online'])).toBe('online')
    expect(bestStatus([])).toBe('offline')
  })

  it('says when your status clears', () => {
    expect(clearsIn(null)).toBeNull()
    expect(clearsIn(25 * 60_000, 0)).toBe('Clears in 25 min')
    expect(clearsIn(4 * 3_600_000, 0)).toBe('Clears in 4 h')
  })
})
