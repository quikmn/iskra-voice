import { describe, expect, it } from 'vitest'
import type { Lfg } from '../core/protocol'
import { defaultStart, fromLocalInput, lfgStatus, parseLfgArgs, slotsLeft, toLocalInput, validStart } from './lfgLogic'

const post = (patch: Partial<Lfg> = {}): Lfg => ({
  game: 'Valheim', slots: 2, startAt: null, voiceChannelId: null, note: null, joined: [], expiresAt: 10_000, closedAt: null, ...patch,
})

describe('LFG posts', () => {
  it('are open, full or closed', () => {
    expect(lfgStatus(post(), 0)).toBe('open')
    expect(lfgStatus(post({ joined: ['a', 'b'] }), 0)).toBe('full')
    expect(lfgStatus(post({ joined: ['a', 'b'] }), 10_000)).toBe('closed')
    expect(lfgStatus(post({ closedAt: 5 }), 0)).toBe('closed')
    expect(slotsLeft(post({ joined: ['a'] }))).toBe(1)
  })

  it('read "/lfg 3 Valheim"', () => {
    expect(parseLfgArgs('3 Valheim')).toEqual({ slots: 3, game: 'Valheim' })
    expect(parseLfgArgs('4 for Deep Rock Galactic')).toEqual({ slots: 4, game: 'Deep Rock Galactic' })
    expect(parseLfgArgs('2 till Valheim')).toEqual({ slots: 2, game: 'Valheim' })
    expect(parseLfgArgs('Valheim')).toEqual({ slots: null, game: 'Valheim' })
    expect(parseLfgArgs('99 Valheim')).toEqual({ slots: null, game: '99 Valheim' })
    expect(parseLfgArgs('')).toEqual({ slots: null, game: '' })
  })

  it('round-trip the time field and suggest the next hour', () => {
    const at = new Date(2026, 9, 15, 20, 0).getTime()
    expect(toLocalInput(at)).toBe('2026-10-15T20:00')
    expect(fromLocalInput('2026-10-15T20:00')).toBe(at)
    expect(fromLocalInput('')).toBeNull()
    expect(fromLocalInput('nonsense')).toBeNull()
    expect(new Date(defaultStart(new Date(2026, 9, 15, 19, 10).getTime())).getHours()).toBe(20)
    expect(new Date(defaultStart(new Date(2026, 9, 15, 19, 40).getTime())).getHours()).toBe(21)
    expect(validStart(at, at - 60_000)).toBe(true)
    expect(validStart(at - 10 * 60_000, at)).toBe(false)
  })
})
