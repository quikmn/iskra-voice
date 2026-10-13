import { describe, expect, it } from 'vitest'
import type { InteractionResponse } from '../core/protocol'
import { addAnswer, MAX_ANSWERS, pendingIn, settle } from './interactionsLogic'

const answer = (responseId: string, text: string, extra: Partial<InteractionResponse> = {}): InteractionResponse => ({
  responseId, interaction: `i-${responseId}`, bot: 'bot', channelId: 1, text, cards: [], components: [], createdAt: 1, ...extra,
})

describe('private answers', () => {
  it('adds new ones last and replaces updated ones in place', () => {
    let list = addAnswer([], answer('a', 'one'))
    list = addAnswer(list, answer('b', 'two'))
    list = addAnswer(list, answer('a', 'one, updated', { updated: true, createdAt: 99 }))
    expect(list.map((a) => a.text)).toEqual(['one, updated', 'two'])
    expect(list[0].createdAt).toBe(1)
  })

  it("doesn't bring back a dismissed answer on an update, and keeps the newest few", () => {
    expect(addAnswer([], answer('gone', 'x', { updated: true }))).toEqual([])
    let list: InteractionResponse[] = []
    for (let i = 0; i < MAX_ANSWERS + 5; i++) list = addAnswer(list, answer(String(i), String(i)))
    expect(list).toHaveLength(MAX_ANSWERS)
    expect(list.at(-1)?.text).toBe(String(MAX_ANSWERS + 4))
  })
})

describe('pending interactions', () => {
  const pending = {
    x: { serverKey: 's', channelId: 1, startedAt: 2 },
    y: { serverKey: 's', channelId: 1, startedAt: 1 },
    z: { serverKey: 's', channelId: 2, startedAt: 0 },
  }
  it('lists one channel oldest first, and settles by id', () => {
    expect(pendingIn(pending, 's', 1).map(([id]) => id)).toEqual(['y', 'x'])
    expect(Object.keys(settle(pending, 'x'))).toEqual(['y', 'z'])
    expect(settle(pending, 'nope')).toBe(pending)
  })
})
