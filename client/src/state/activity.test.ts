import { describe, expect, it } from 'vitest'
import { elapsed } from './activity'

describe('activity status', () => {
  it('says how long a game has been going', () => {
    const start = 1_760_000_000_000
    expect(elapsed(start, start + 20_000)).toBe('just started')
    expect(elapsed(start, start + 12 * 60_000)).toBe('12 min')
    expect(elapsed(start, start + 60 * 60_000)).toBe('1 h')
    expect(elapsed(start, start + 65 * 60_000)).toBe('1 h 5 min')
    expect(elapsed(start, start - 5000)).toBe('just started') // clocks a little apart
  })
})
