import { describe, expect, it } from 'vitest'
import { validLogId } from './logIds'

describe('welcome.logId', () => {
  it('accepts only the promised shape', () => {
    expect(validLogId('k3f')).toBe(true)
    expect(validLogId('0')).toBe(true)
    expect(validLogId('abcdefgh')).toBe(true)
    expect(validLogId('abcdefghi')).toBe(false)
    expect(validLogId('')).toBe(false)
    expect(validLogId('K3F')).toBe(false)
    expect(validLogId('a b')).toBe(false)
    expect(validLogId(12)).toBe(false)
    expect(validLogId(undefined)).toBe(false)
  })
})
