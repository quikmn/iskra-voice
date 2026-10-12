import { describe, expect, it } from 'vitest'
import { serverColor, serverHue } from './serverColor'

const KEY = 'u0kXyQd1oWbNw3r6c2Pp8lmT9a5FzHjE4sVgKiYxR7A'

describe('server colour', () => {
  it('is stable for a key (every device and every run agree)', () => {
    expect(serverHue(KEY)).toBe(serverHue(KEY))
    expect(serverColor(KEY)).toEqual(serverColor(KEY))
    // FNV-1a pinned, so a refactor can't quietly recolour everyone's servers.
    expect(serverHue('')).toBe(0x811c9dc5 % 360)
    expect(serverHue('a')).toBe(0xe40c292c % 360)
  })

  it('is a whole hue from 0 to 359', () => {
    for (let i = 0; i < 500; i++) {
      const hue = serverHue(`${KEY}${i}`)
      expect(Number.isInteger(hue)).toBe(true)
      expect(hue).toBeGreaterThanOrEqual(0)
      expect(hue).toBeLessThan(360)
    }
  })

  it('spreads keys over the wheel', () => {
    const slices = new Set(Array.from({ length: 200 }, (_, i) => Math.floor(serverHue(`server-${i}`) / 30)))
    expect(slices.size).toBe(12) // every 30° slice is used
    expect(serverHue('server-a')).not.toBe(serverHue('server-b'))
  })

  it('draws the band, marker and tile from the same hue', () => {
    const c = serverColor(KEY)
    for (const value of [c.band, c.marker, c.tile]) expect(value.startsWith(`hsl(${c.hue} `)).toBe(true)
  })
})
