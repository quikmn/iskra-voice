import { describe, expect, it } from 'vitest'
import { MAX_SOUND_MS, stopAfterMs } from './expressions'

describe('soundboard playback', () => {
  it('stops at the measured length, never past the limit', () => {
    expect(stopAfterMs(1200)).toBe(1450)
    expect(stopAfterMs(60_000)).toBe(MAX_SOUND_MS + 250)
    expect(stopAfterMs(undefined)).toBe(MAX_SOUND_MS + 250)
    expect(stopAfterMs(Number.NaN)).toBe(MAX_SOUND_MS + 250)
    expect(stopAfterMs(-5)).toBe(MAX_SOUND_MS + 250)
  })
})
