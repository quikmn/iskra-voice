import { describe, expect, it } from 'vitest'
import type { Category, Channel, NotifySetting } from '../core/protocol'
import {
  channelBadges, defaultLevel, dropOnCategory, dropOnChannel, effectiveNotify, layoutChannels, muteLabel, nextMuteEnd, shouldNotify, stepCategory, stepChannel,
  type NotifyMap,
} from './organizeLogic'

const ch = (id: number, position: number, categoryId: number | null = null, kind: 'text' | 'voice' = 'text'): Channel =>
  ({ id, name: `c${id}`, kind, position, readRole: 'member', writeRole: 'member', categoryId })
const cat = (id: number, position: number): Category => ({ id, name: `k${id}`, position })

describe('layoutChannels', () => {
  it('puts uncategorized channels first and orders by position', () => {
    const layout = layoutChannels([ch(3, 2, 10), ch(1, 0), ch(2, 1, 10), ch(4, 3, 99)], [cat(20, 1), cat(10, 0)])
    expect(layout.uncategorized.map((c) => c.id)).toEqual([1, 4]) // 99 is unknown: shown as uncategorized
    expect(layout.groups.map((g) => g.category.id)).toEqual([10, 20])
    expect(layout.groups[0].channels.map((c) => c.id)).toEqual([2, 3])
    expect(layout.groups[1].channels).toEqual([])
  })

  it('works for servers without categories', () => {
    const layout = layoutChannels([ch(1, 0), ch(2, 1, null, 'voice')], [])
    expect(layout.uncategorized.map((c) => c.id)).toEqual([1, 2])
    expect(layout.groups).toEqual([])
  })
})

describe('dropping and stepping channels', () => {
  const channels = [ch(1, 0), ch(2, 1, 10), ch(3, 2, 10), ch(4, 3, 10)]
  const layout = layoutChannels(channels, [cat(10, 0)])

  it('drops before or after the row under the pointer', () => {
    expect(dropOnChannel(layout, 4, channels[1], false)).toEqual({ categoryId: 10, before: 2 })
    expect(dropOnChannel(layout, 2, channels[2], true)).toEqual({ categoryId: 10, before: 4 })
    expect(dropOnChannel(layout, 2, channels[3], true)).toEqual({ categoryId: 10, before: null })
    expect(dropOnChannel(layout, 2, channels[0], true)).toEqual({ categoryId: null, before: null })
  })

  it('ignores drops that change nothing', () => {
    expect(dropOnChannel(layout, 2, channels[1], false)).toBeNull()
    expect(dropOnChannel(layout, 2, channels[2], false)).toBeNull() // already right before 3
    expect(dropOnChannel(layout, 3, channels[1], true)).toBeNull()
  })

  it('steps up and down within a category', () => {
    expect(stepChannel(layout, channels[2], -1)).toEqual({ categoryId: 10, before: 2 })
    expect(stepChannel(layout, channels[2], 1)).toEqual({ categoryId: 10, before: null })
    expect(stepChannel(layout, channels[1], 1)).toEqual({ categoryId: 10, before: 4 })
    expect(stepChannel(layout, channels[1], -1)).toBeNull()
    expect(stepChannel(layout, channels[3], 1)).toBeNull()
  })

  it('steps uncategorized channels among their own kind', () => {
    const top = [ch(1, 0), ch(2, 1, null, 'voice'), ch(3, 2), ch(4, 3, null, 'voice')]
    const l = layoutChannels(top, [])
    expect(stepChannel(l, top[0], 1)).toEqual({ categoryId: null, before: 4 }) // past #3, which comes before voice 4
    expect(stepChannel(l, top[2], -1)).toEqual({ categoryId: null, before: 1 })
    expect(stepChannel(l, top[1], 1)).toEqual({ categoryId: null, before: null })
    expect(stepChannel(l, top[3], 1)).toBeNull()
  })
})

describe('categories', () => {
  const categories = [cat(1, 0), cat(2, 1), cat(3, 2)]
  it('steps and drops', () => {
    expect(stepCategory(categories, 2, -1)).toEqual({ before: 1 })
    expect(stepCategory(categories, 2, 1)).toEqual({ before: null })
    expect(stepCategory(categories, 1, 1)).toEqual({ before: 3 })
    expect(stepCategory(categories, 1, -1)).toBeNull()
    expect(dropOnCategory(categories, 3, 1)).toEqual({ before: 1 })
    expect(dropOnCategory(categories, 1, 2)).toEqual({ before: 3 }) // onto the next one: lands after it
    expect(dropOnCategory(categories, 2, 2)).toBeNull()
  })
})

describe('notification settings', () => {
  const set = (channelId: number | null, level: NotifySetting['level'], mutedUntil: number | null = null): NotifySetting => ({ channelId, level, mutedUntil })
  const map = (...list: NotifySetting[]): NotifyMap => Object.fromEntries(list.map((s) => [s.channelId === null ? 'server' : String(s.channelId), s]))
  const now = 10_000

  it('matches the server: channel, else server, else only mentions; muting caps "all"', () => {
    expect(effectiveNotify(undefined, 1, now)).toEqual({ level: 'mentions', chosen: 'mentions', muted: false })
    expect(effectiveNotify(map(set(null, 'all')), 1, now).level).toBe('all')
    expect(effectiveNotify(map(set(null, 'all'), set(1, 'none')), 1, now).level).toBe('none')
    expect(effectiveNotify(map(set(1, 'all', 20_000)), 1, now)).toEqual({ level: 'mentions', chosen: 'all', muted: true })
    expect(effectiveNotify(map(set(null, null, -1), set(1, 'all')), 1, now).muted).toBe(true)
    expect(effectiveNotify(map(set(1, 'all', 5_000)), 1, now).muted).toBe(false) // over
    expect(effectiveNotify(map(set(1, 'all', -1)), null, now).muted).toBe(false) // the server itself isn't muted
  })

  it('defaults to all messages below 15 people and only @mentions from 15 on; a choice always wins', () => {
    expect(defaultLevel(1)).toBe('all')
    expect(defaultLevel(14)).toBe('all')
    expect(defaultLevel(15)).toBe('mentions')
    expect(defaultLevel(400)).toBe('mentions')
    expect(effectiveNotify(undefined, 1, now, defaultLevel(5))).toEqual({ level: 'all', chosen: 'all', muted: false })
    expect(effectiveNotify(undefined, 1, now, defaultLevel(50)).chosen).toBe('mentions')
    expect(effectiveNotify(map(set(null, 'mentions')), 1, now, defaultLevel(5)).chosen).toBe('mentions')
    expect(effectiveNotify(map(set(1, 'none')), 1, now, defaultLevel(5)).chosen).toBe('none')
    expect(effectiveNotify(map(set(null, 'all')), 1, now, defaultLevel(50)).chosen).toBe('all')
    // A muted small server is still quiet.
    expect(effectiveNotify(map(set(null, null, -1)), 1, now, defaultLevel(5)).level).toBe('mentions')
  })

  it('dims muted channels, hides their unread marker, and drops mention badges at Nothing', () => {
    const muted = effectiveNotify(map(set(1, null, -1)), 1, now)
    expect(channelBadges(3, 1, muted)).toEqual({ unread: false, pings: 1, dimmed: true })
    const nothing = effectiveNotify(map(set(1, 'none')), 1, now)
    expect(channelBadges(3, 2, nothing)).toEqual({ unread: true, pings: 0, dimmed: false })
    expect(channelBadges(3, 2, effectiveNotify(undefined, 1, now))).toEqual({ unread: true, pings: 2, dimmed: false })
  })

  it('decides desktop notifications', () => {
    expect(shouldNotify(effectiveNotify(undefined, 1, now), true)).toBe(true)
    expect(shouldNotify(effectiveNotify(undefined, 1, now), false)).toBe(false)
    expect(shouldNotify(effectiveNotify(map(set(1, 'all')), 1, now), false)).toBe(true)
    expect(shouldNotify(effectiveNotify(map(set(1, 'all', -1)), 1, now), false)).toBe(false)
    expect(shouldNotify(effectiveNotify(map(set(1, 'all', -1)), 1, now), true)).toBe(true)
    expect(shouldNotify(effectiveNotify(map(set(null, 'none')), 1, now), true)).toBe(false)
  })

  it('finds the next mute to end and labels mutes', () => {
    expect(nextMuteEnd([map(set(1, null, 50_000), set(2, null, -1)), map(set(null, null, 30_000), set(3, null, 5_000))], now)).toBe(30_000)
    expect(nextMuteEnd([map(set(1, null, -1))], now)).toBeNull()
    expect(muteLabel(-1, now)).toBe('Muted')
    expect(muteLabel(null, now)).toBe('')
    expect(muteLabel(5_000, now)).toBe('')
    expect(muteLabel(now + 60_000, now)).toMatch(/^Muted until /)
  })
})
