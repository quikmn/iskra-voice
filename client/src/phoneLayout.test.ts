import { describe, expect, it } from 'vitest'
import { expandLayoutMedia, PHONE_LAYOUT_QUERIES, PHONE_SIDEWAYS, WIDE_LAYOUT_QUERIES } from './phoneLayout'

/** Evaluates one of the simple queries used here for a screen. */
function matches(query: string, screen: { width: number; height: number; pointer: 'coarse' | 'fine' | 'none' }): boolean {
  return query.split(' and ').every((condition) => {
    const [, feature, value] = /^\(([a-z-]+): ([^)]+)\)$/.exec(condition.trim())!
    const px = parseFloat(value)
    if (feature === 'max-width') return screen.width <= px
    if (feature === 'min-width') return screen.width >= px
    if (feature === 'max-height') return screen.height <= px
    if (feature === 'min-height') return screen.height >= px
    if (feature === 'pointer') return screen.pointer === value
    throw new Error(`unknown feature ${feature}`)
  })
}
const phone = (screen: Parameters<typeof matches>[1]) => PHONE_LAYOUT_QUERIES.some((q) => matches(q, screen))
const wide = (screen: Parameters<typeof matches>[1]) => WIDE_LAYOUT_QUERIES.some((q) => matches(q, screen))

describe('the phone layout', () => {
  it('is for narrow windows and for phones held sideways', () => {
    expect(phone({ width: 390, height: 844, pointer: 'coarse' })).toBe(true)
    expect(phone({ width: 600, height: 800, pointer: 'fine' })).toBe(true)
    expect(phone({ width: 844, height: 390, pointer: 'coarse' })).toBe(true)
    expect(phone({ width: 932, height: 430, pointer: 'coarse' })).toBe(true)
  })

  it('is not for tablets on their side, desktops, or short desktop windows', () => {
    expect(phone({ width: 1180, height: 820, pointer: 'coarse' })).toBe(false)
    expect(phone({ width: 1024, height: 768, pointer: 'coarse' })).toBe(false)
    expect(phone({ width: 1280, height: 800, pointer: 'fine' })).toBe(false)
    expect(phone({ width: 900, height: 400, pointer: 'fine' })).toBe(false)
    expect(phone({ width: 1180, height: 420, pointer: 'coarse' })).toBe(false) // a tablet with its keyboard open
  })

  it('and the wide layout are never both on or both off', () => {
    for (const pointer of ['coarse', 'fine', 'none'] as const) {
      for (const width of [320, 760, 760.5, 761, 844, 1000, 1000.5, 1001, 1400]) {
        for (const height of [300, 500, 500.5, 501, 900]) {
          const screen = { width, height, pointer }
          expect(wide(screen), JSON.stringify(screen)).toBe(!phone(screen))
        }
      }
    }
  })
})

describe('layout names in stylesheets', () => {
  it('are replaced by every alternative', () => {
    expect(expandLayoutMedia('(--phone)')).toBe(PHONE_LAYOUT_QUERIES.join(', '))
    expect(expandLayoutMedia('(--wide)')).toBe(WIDE_LAYOUT_QUERIES.join(', '))
  })

  it('keep the conditions joined to them, and leave other queries alone', () => {
    expect(expandLayoutMedia('(--phone) and (orientation: landscape)')).toBe(PHONE_LAYOUT_QUERIES.map((q) => `${q} and (orientation: landscape)`).join(', '))
    expect(expandLayoutMedia('(hover: none), (--phone)')).toBe(['(hover: none)', ...PHONE_LAYOUT_QUERIES].join(', '))
    expect(expandLayoutMedia('(max-width: 480px)')).toBe('(max-width: 480px)')
    expect(expandLayoutMedia('(--phone-sideways)')).toBe(PHONE_SIDEWAYS)
  })

  it('a sideways phone is a phone, and an upright phone with its keyboard open is not sideways', () => {
    for (const screen of [{ width: 844, height: 390 }, { width: 568, height: 320 }, { width: 932, height: 430 }]) {
      expect(matches(PHONE_SIDEWAYS, { ...screen, pointer: 'coarse' })).toBe(true)
      expect(phone({ ...screen, pointer: 'coarse' })).toBe(true)
    }
    expect(matches(PHONE_SIDEWAYS, { width: 360, height: 330, pointer: 'coarse' })).toBe(false)
    expect(matches(PHONE_SIDEWAYS, { width: 700, height: 450, pointer: 'fine' })).toBe(false)
  })
})
