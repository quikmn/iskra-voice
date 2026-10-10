import { describe, expect, it } from 'vitest'
import { resultCount } from './search'

describe('search result count', () => {
  it('says 1000+ when the server stopped counting', () => {
    expect(resultCount(1, false)).toBe('1 result')
    expect(resultCount(12, false)).toBe('12 results')
    expect(resultCount(1000, true)).toBe('1000+ results')
  })
})
