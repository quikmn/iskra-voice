import { describe, expect, it } from 'vitest'
import { fitsJoinSound, joinSoundVolume, joinToneNeeded, JOIN_TONE_QUIET_MS, type JoinSoundListener } from './joinSoundLogic'

const listener: JoinSoundListener = { hear: true, soundboardMuted: false, soundboardVolume: 0.6, deafened: false, personal: 1, blocked: false }

describe('join sounds', () => {
  it('only short sounds fit', () => {
    expect(fitsJoinSound({ durationMs: 800 })).toBe(true)
    expect(fitsJoinSound({ durationMs: 5000 })).toBe(true)
    expect(fitsJoinSound({ durationMs: 5100 })).toBe(true) // encoder padding
    expect(fitsJoinSound({ durationMs: 6000 })).toBe(false)
    expect(fitsJoinSound({ durationMs: 2500 }, 2000)).toBe(false)
  })

  it('plays at the soundboard volume times your volume for that person', () => {
    expect(joinSoundVolume(listener)).toBeCloseTo(0.6)
    expect(joinSoundVolume({ ...listener, personal: 0.5 })).toBeCloseTo(0.3)
    // A boost (above 100%) never makes a join sound louder than the soundboard.
    expect(joinSoundVolume({ ...listener, personal: 2 })).toBeCloseTo(0.6)
  })

  it('is silent when you turned join sounds off, muted the soundboard, deafened, muted or blocked the person', () => {
    expect(joinSoundVolume({ ...listener, hear: false })).toBe(0)
    expect(joinSoundVolume({ ...listener, soundboardMuted: true })).toBe(0)
    expect(joinSoundVolume({ ...listener, soundboardVolume: 0 })).toBe(0)
    expect(joinSoundVolume({ ...listener, deafened: true })).toBe(0)
    expect(joinSoundVolume({ ...listener, personal: 0 })).toBe(0)
    expect(joinSoundVolume({ ...listener, blocked: true })).toBe(0)
  })

  it('leaves the join tone out for someone whose join sound just played', () => {
    const at = new Map([['a', 1000]])
    expect(joinToneNeeded(['a'], (k) => at.get(k), 1200)).toBe(false)
    expect(joinToneNeeded(['a', 'b'], (k) => at.get(k), 1200)).toBe(true) // b came in without one
    expect(joinToneNeeded(['a'], (k) => at.get(k), 1000 + JOIN_TONE_QUIET_MS + 1)).toBe(true)
    expect(joinToneNeeded(['b'], (k) => at.get(k), 1200)).toBe(true)
  })
})
