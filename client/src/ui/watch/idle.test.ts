import { describe, expect, it } from 'vitest'
import { controlsVisible, hideIn, IDLE_MS, type ControlsState } from './idle'

const base: ControlsState = { playing: true, lastActive: 10_000, now: 10_000, pinned: false, keyboard: false, touch: false }

describe('watch party controls over the video', () => {
  it('show right after the pointer moved and hide once it has rested', () => {
    expect(controlsVisible(base)).toBe(true)
    expect(controlsVisible({ ...base, now: base.lastActive + IDLE_MS - 1 })).toBe(true)
    expect(controlsVisible({ ...base, now: base.lastActive + IDLE_MS })).toBe(false)
  })

  it('always show while paused', () => {
    expect(controlsVisible({ ...base, playing: false, now: base.lastActive + 60_000 })).toBe(true)
  })

  it('always show for keyboard focus, on touch screens and while a menu is open', () => {
    const later = base.lastActive + 60_000
    expect(controlsVisible({ ...base, now: later, keyboard: true })).toBe(true)
    expect(controlsVisible({ ...base, now: later, touch: true })).toBe(true)
    expect(controlsVisible({ ...base, now: later, pinned: true })).toBe(true)
    expect(controlsVisible({ ...base, now: later })).toBe(false)
  })

  it('says when to look again', () => {
    expect(hideIn(base)).toBe(IDLE_MS)
    expect(hideIn({ ...base, now: base.lastActive + 1000 })).toBe(IDLE_MS - 1000)
    expect(hideIn({ ...base, now: base.lastActive + IDLE_MS + 5 })).toBe(0)
    expect(hideIn({ ...base, playing: false })).toBeNull()
    expect(hideIn({ ...base, keyboard: true })).toBeNull()
    expect(hideIn({ ...base, touch: true })).toBeNull()
    expect(hideIn({ ...base, pinned: true })).toBeNull()
  })
})
