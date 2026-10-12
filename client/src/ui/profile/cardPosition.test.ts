import { describe, expect, it } from 'vitest'
import { cardPosition } from './ProfileLayer'

describe('profile card position', () => {
  const rect = (top: number, left: number, right: number) => ({ top, left, right })

  it('sits right of what was clicked, top-aligned', () => {
    expect(cardPosition(rect(100, 300, 500), 320, 300, 1280, 800)).toEqual({ left: 508, top: 100 })
  })

  it('goes left when there is no room on the right', () => {
    expect(cardPosition(rect(100, 900, 1200), 320, 300, 1280, 800)).toEqual({ left: 572, top: 100 })
  })

  it('shifts up to fit a tile near the bottom of a short window', () => {
    expect(cardPosition(rect(480, 300, 500), 320, 400, 1300, 520)).toEqual({ left: 508, top: 112 })
  })

  it('never goes above the top, even when taller than the window (the card scrolls inside)', () => {
    expect(cardPosition(rect(400, 300, 500), 320, 700, 1300, 520).top).toBe(8)
  })

  it('stays inside a narrow window', () => {
    const { left } = cardPosition(rect(100, 10, 380), 320, 300, 390, 844)
    expect(left).toBeGreaterThanOrEqual(8)
    expect(left + 320).toBeLessThanOrEqual(390 - 8)
  })
})
