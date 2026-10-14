import { describe, expect, it } from 'vitest'
import { idleFor, MAX_IDLE_MS, nextReport, REPORT_AFTER_MS } from './voiceIdleLogic'

const T = 10_000_000

describe('idle for the AFK channel', () => {
  it('counts from the last input or speech, whichever is later', () => {
    expect(idleFor({ now: T, lastInput: T - 5 * 60_000, lastSpeaking: T - 2 * 60_000, systemIdleMs: null })).toBe(2 * 60_000)
    expect(idleFor({ now: T, lastInput: T - 1000, lastSpeaking: 0, systemIdleMs: null })).toBe(1000)
  })

  it('never counts someone who is speaking right now as idle', () => {
    const report = nextReport(false, idleFor({ now: T, lastInput: T - 30 * 60_000, lastSpeaking: T, systemIdleMs: null }))
    expect(report).toBeNull()
    expect(nextReport(true, idleFor({ now: T, lastInput: 0, lastSpeaking: T, systemIdleMs: 30 * 60_000 }))).toEqual({ idle: false })
  })

  it('on the desktop, input anywhere on the computer counts', () => {
    // No input in the app for 20 minutes, but someone is typing in a game: not idle.
    expect(idleFor({ now: T, lastInput: T - 20 * 60_000, lastSpeaking: 0, systemIdleMs: 3000 })).toBe(3000)
    // The computer has been untouched for longer than the app knows: the app's own input still wins when it's later.
    expect(idleFor({ now: T, lastInput: T - 60_000, lastSpeaking: 0, systemIdleMs: 10 * 60_000 })).toBe(60_000)
  })

  it('says idle once after a minute, with how long, and active again at once', () => {
    expect(nextReport(false, REPORT_AFTER_MS - 1)).toBeNull()
    expect(nextReport(false, REPORT_AFTER_MS)).toEqual({ idle: true, idleMs: REPORT_AFTER_MS })
    expect(nextReport(true, 10 * 60_000)).toBeNull()
    expect(nextReport(true, 0)).toEqual({ idle: false })
    expect(nextReport(false, 0)).toBeNull()
    expect(nextReport(false, 5 * MAX_IDLE_MS)).toEqual({ idle: true, idleMs: MAX_IDLE_MS })
  })
})
