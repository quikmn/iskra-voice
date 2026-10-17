import { describe, expect, it } from 'vitest'
import { emptyStreamerPref, maskEmails, maskSecret, parseStreamerPref, streamerActive } from './streamerLogic'

describe('streamer mode', () => {
  it('is on by the switch or by a streaming program the desktop app sees', () => {
    expect(streamerActive(false, false)).toBe(false)
    expect(streamerActive(true, false)).toBe(true)
    expect(streamerActive(false, true)).toBe(true)
  })

  it('reads only well-formed saved copies', () => {
    expect(parseStreamerPref({ on: true, updatedAt: 5 })).toEqual({ on: true, updatedAt: 5 })
    expect(parseStreamerPref({ on: 'yes', updatedAt: 5 })).toBeNull()
    expect(parseStreamerPref({ on: true, updatedAt: -1 })).toBeNull()
    expect(parseStreamerPref(null)).toBeNull()
    expect(parseStreamerPref('on')).toBeNull()
    expect(emptyStreamerPref()).toEqual({ on: false, updatedAt: 0 })
  })

  it('masks email addresses in text and keeps the rest', () => {
    expect(maskEmails('Mail me at anna.b@example.org or ANNA@EXAMPLE.CO.UK!')).toBe('Mail me at •••@••• or •••@•••!')
    expect(maskEmails('no address here @everyone')).toBe('no address here @everyone')
  })

  it('masks secrets with a fixed-looking run of dots', () => {
    expect(maskSecret('abc')).toBe('••••••••')
    expect(maskSecret('x'.repeat(100))).toHaveLength(24)
    expect(maskSecret('https://app.iskra.foo/#/join?x=1')).toHaveLength(24)
  })
})
