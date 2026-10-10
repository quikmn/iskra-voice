import { describe, expect, it } from 'vitest'
import { MAX_CLOCK_SKEW, mergeDm, orderTime } from './dmMerge'

interface T { id: string; from: string; sentAt: number; text: string; pending?: string; error?: string }
const dm = (from: string, id: string, text: string, sentAt = 1, extra: Partial<T> = {}): T => ({ id, from, sentAt, text, ...extra })
const merge = (...items: T[]) => items.reduce<T[]>(mergeDm, [])

describe('DM history merge', () => {
  it('keys messages by sender and id: a peer cannot overwrite my message by reusing its id', () => {
    const list = merge(dm('me', 'a', 'my words'), dm('peer', 'a', 'forged words'))
    expect(list.map((m) => `${m.from}:${m.text}`)).toEqual(['me:my words', 'peer:forged words'])
  })

  it('keeps the first readable copy and ignores later copies with different content', () => {
    const list = merge(dm('peer', 'a', 'original'), dm('peer', 'a', 'edited later', 2))
    expect(list).toEqual([dm('peer', 'a', 'original')])
  })

  it('lets a readable copy replace an unreadable one, never the other way round', () => {
    const unreadable = dm('peer', 'a', '', 5, { error: 'gone' })
    expect(merge(unreadable, dm('peer', 'a', 'hi'))).toEqual([dm('peer', 'a', 'hi')])
    expect(merge(dm('peer', 'a', 'hi'), unreadable)).toEqual([dm('peer', 'a', 'hi')])
    expect(merge(unreadable, dm('peer', 'a', '', 6, { error: 'other' }))).toEqual([unreadable])
  })

  it('orders by time, then id', () => {
    const list = merge(dm('p', 'c', 'three', 3), dm('p', 'b', 'one', 1), dm('me', 'a', 'two', 2), dm('me', 'z', 'one too', 1))
    expect(list.map((m) => m.text)).toEqual(['one', 'one too', 'two', 'three'])
  })

  it('orders by the server time when the sender clock is far off', () => {
    expect(orderTime(1_000_000, 1_000_000 + 5_000)).toBe(1_000_000)
    expect(orderTime(1_000_000, 1_000_000 + MAX_CLOCK_SKEW + 1)).toBe(1_000_000 + MAX_CLOCK_SKEW + 1)
    expect(orderTime(0, 1_000_000_000)).toBe(1_000_000_000)
    expect(orderTime(9e15, 1_000_000_000)).toBe(1_000_000_000)
  })
})
