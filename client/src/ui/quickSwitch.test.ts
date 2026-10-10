import { describe, expect, it } from 'vitest'
import { matchScore, rankItems, type SwitchItem } from './quickSwitch'

const item = (label: string, context = 'Lounge', unread = 0): SwitchItem => ({ id: label, kind: 'channel', label, context, unread })

describe('quick switcher', () => {
  it('scores prefixes, word starts, substrings and fuzzy matches in that order', () => {
    expect(matchScore('general', 'gen')).toBe(0)
    expect(matchScore('game-night', 'night')).toBe(1)
    expect(matchScore('memes', 'em')).toBe(2)
    expect(matchScore('general', 'gnl')).toBe(3)
    expect(matchScore('general', 'xyz')).toBeNull()
    expect(matchScore('general', '#gen')).toBe(0)
    expect(matchScore('a.b', '(')).toBeNull() // regex characters are literal
  })

  it('ranks the best match first and keeps the original order for ties', () => {
    const items = [item('memes'), item('general'), item('gaming'), item('off-topic')]
    expect(rankItems(items, 'g').map((i) => i.label)).toEqual(['general', 'gaming'])
    expect(rankItems(items, 'm').map((i) => i.label)).toEqual(['memes', 'gaming'])
    expect(rankItems(items, 'top').map((i) => i.label)).toEqual(['off-topic'])
  })

  it('puts unread first when nothing is typed, and matches the server name after names', () => {
    const items = [item('general'), item('memes', 'Game Night', 3), item('lobby', 'Weekend Crew')]
    expect(rankItems(items, '').map((i) => i.label)).toEqual(['memes', 'general', 'lobby'])
    expect(rankItems(items, 'weekend').map((i) => i.label)).toEqual(['lobby'])
  })
})
