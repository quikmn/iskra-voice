import { describe, expect, it } from 'vitest'
import { dbToGain, duckFactor, parseLists, priorityTalking, startBody } from './whisperLogic'
import { parseHotkeys } from './hotkeys'

const key = (c: string) => c.repeat(43)

describe('whisper lists', () => {
  it('keeps three well-formed lists, whatever storage holds', () => {
    expect(parseLists(null).map((l) => l.slot)).toEqual([1, 2, 3])
    const lists = parseLists([
      { slot: 2, name: 'Team', target: { kind: 'people', people: [key('a'), key('a'), 7, '', key('b')] } },
      { slot: 3, name: 5, target: { kind: 'channel', channelId: 9 } },
      { slot: 4, name: 'nope', target: { kind: 'channel', channelId: 1 } },
      { slot: 1, name: 'x'.repeat(50), target: { kind: 'channel', channelId: -1 } },
    ])
    expect(lists[0]).toEqual({ slot: 1, name: 'x'.repeat(32), target: null })
    expect(lists[1]).toEqual({ slot: 2, name: 'Team', target: { kind: 'people', people: [key('a'), key('b')] } })
    expect(lists[2]).toEqual({ slot: 3, name: '', target: { kind: 'channel', channelId: 9 } })
    expect(parseLists([{ slot: 1, target: { kind: 'people', people: Array.from({ length: 40 }, (_, i) => `k${i}`) } }])[0].target)
      .toMatchObject({ people: expect.any(Array) })
    expect((parseLists([{ slot: 1, target: { kind: 'people', people: Array.from({ length: 40 }, (_, i) => `k${i}`) } }])[0].target as { people: string[] }).people)
      .toHaveLength(25)
  })

  it('turns a list into a whisper.start body', () => {
    expect(startBody({ slot: 1, name: '', target: null })).toBeNull()
    expect(startBody({ slot: 2, name: '', target: { kind: 'people', people: ['a'] } })).toEqual({ slot: 2, targets: ['a'] })
    expect(startBody({ slot: 3, name: '', target: { kind: 'channel', channelId: 4 } })).toEqual({ slot: 3, channelId: 4 })
  })
})

describe('priority ducking', () => {
  const people = [
    { accountKey: 'boss', muted: false, deafened: false, priority: true },
    { accountKey: 'ann', muted: false, deafened: false },
    { accountKey: 'me', muted: false, deafened: false },
  ]

  it('turns others down only while someone with priority is speaking', () => {
    expect(dbToGain(12)).toBeCloseTo(0.251, 3)
    expect(duckFactor('ann', people, {}, 'me', 12)).toBe(1)
    expect(duckFactor('ann', people, { boss: true }, 'me', 12)).toBeCloseTo(0.251, 3)
    expect(duckFactor('boss', people, { boss: true }, 'me', 12)).toBe(1) // never the priority speaker
    expect(duckFactor('ann', people, { boss: true }, 'me', 0)).toBe(1) // the listener turned it off
    expect(duckFactor('ann', people, { boss: true }, 'boss', 12)).toBe(1) // your own priority doesn't duck for you
    expect(priorityTalking(people, { boss: true }, 'me')).toBe('boss')
    expect(priorityTalking(people, { ann: true }, 'me')).toBeNull()
  })
})

describe('held hotkeys', () => {
  it('are stored next to the others', () => {
    const raw = JSON.stringify({
      web: { whisper1: { code: 'KeyV', ctrl: false, shift: false, alt: true, meta: false, label: 'Alt + V' }, whisper9: { code: 'KeyX' } },
      desktop: { priority: { code: 0x10004, mods: 0, label: 'Mouse 4' } },
    })
    const parsed = parseHotkeys(raw)
    expect(parsed.web.whisper1?.label).toBe('Alt + V')
    expect(parsed.desktop.priority?.code).toBe(0x10004)
    expect(Object.keys(parsed.web)).toEqual(['whisper1'])
  })
})
