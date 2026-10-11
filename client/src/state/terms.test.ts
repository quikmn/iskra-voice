import { describe, expect, it } from 'vitest'
import { needsAcceptance, parseAcceptance, safetyMailto, TERMS_VERSION } from './terms'

describe('terms acceptance', () => {
  it('asks when nothing was accepted on this device', () => {
    expect(needsAcceptance(null)).toBe(true)
    expect(needsAcceptance(parseAcceptance(null))).toBe(true)
  })

  it("doesn't ask again for the same version", () => {
    expect(needsAcceptance({ version: TERMS_VERSION, at: 1 })).toBe(false)
  })

  it('asks again when the version changes, either way', () => {
    expect(needsAcceptance({ version: '2026-10-11', at: 1 }, '2027-01-01')).toBe(true)
    expect(needsAcceptance({ version: '2027-01-01', at: 1 }, '2026-10-11')).toBe(true)
  })

  it('ignores malformed stored values', () => {
    expect(parseAcceptance('not json')).toBeNull()
    expect(parseAcceptance('{"version":3,"at":1}')).toBeNull()
    expect(parseAcceptance('{"version":"x"}')).toBeNull()
    expect(parseAcceptance(JSON.stringify({ version: TERMS_VERSION, at: 5 }))).toEqual({ version: TERMS_VERSION, at: 5 })
  })

  it('makes a safe mailto link', () => {
    expect(safetyMailto('Safety & stuff')).toBe('mailto:spark@iskra.foo?subject=Safety%20%26%20stuff')
  })
})
