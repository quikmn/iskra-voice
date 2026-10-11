import { describe, expect, it } from 'vitest'
import { actionFor, addEvent, cleanFriendState, MAX_EVENTS, relationOf, sinceOf, type FriendEvent } from './friendMachine'
import type { FriendKind } from '../core/friend'

let n = 0
const e = (kind: FriendKind, mine: boolean, at: number): FriendEvent => ({ id: `e${n++}`, kind, mine, at })
const fold = (...events: FriendEvent[]) => relationOf(events.reduce(addEvent, [] as FriendEvent[]))

describe('friend relation', () => {
  it('request then accept makes friends on both sides', () => {
    // Alice's view and Bob's view of the same two actions.
    expect(fold(e('request', true, 1))).toBe('outgoing')
    expect(fold(e('request', true, 1), e('accept', false, 2))).toBe('friends')
    expect(fold(e('request', false, 1))).toBe('incoming')
    expect(fold(e('request', false, 1), e('accept', true, 2))).toBe('friends')
  })

  it('comes out the same whatever order copies arrive in', () => {
    const events = [e('request', true, 1), e('accept', false, 2), e('remove', false, 3), e('request', false, 4)]
    expect(fold(...events)).toBe('incoming')
    expect(fold(...[...events].reverse())).toBe('incoming')
    expect(fold(events[2], events[0], events[3], events[1])).toBe('incoming')
  })

  it('two requests that meet make friends', () => {
    expect(fold(e('request', true, 1), e('request', false, 1))).toBe('friends')
  })

  it('an accept nobody asked for means nothing', () => {
    expect(fold(e('accept', false, 1))).toBe('none')
    expect(fold(e('accept', true, 1))).toBe('none')
    expect(fold(e('request', false, 1), e('accept', false, 2))).toBe('incoming') // they can't accept their own request
  })

  it('cancel, ignore and remove', () => {
    expect(fold(e('request', true, 1), e('cancel', true, 2))).toBe('none')
    expect(fold(e('request', false, 1), e('cancel', false, 2))).toBe('none')
    // Ignoring is quiet: the sender still sees their request as pending.
    expect(fold(e('request', false, 1), e('decline', true, 2))).toBe('none')
    expect(fold(e('request', true, 1), e('decline', false, 2))).toBe('outgoing')
    // Either side removing ends it for both.
    expect(fold(e('request', true, 1), e('accept', false, 2), e('remove', false, 3))).toBe('none')
    expect(fold(e('request', true, 1), e('accept', false, 2), e('remove', true, 3))).toBe('none')
    // An old accept replayed after a removal changes nothing.
    const accept = e('accept', false, 2)
    expect(relationOf([e('request', true, 1), accept, e('remove', false, 3), accept].reduce(addEvent, [] as FriendEvent[]))).toBe('none')
  })

  it('copies count once and the log stays bounded', () => {
    const one = e('request', true, 1)
    const list = addEvent([], one)
    expect(addEvent(list, { ...one })).toBe(list)
    // The same id from the other side is a different action.
    expect(addEvent(list, { ...one, mine: false })).toHaveLength(2)
    let long: FriendEvent[] = []
    for (let i = 0; i < MAX_EVENTS + 10; i++) long = addEvent(long, e(i % 2 ? 'cancel' : 'request', true, i))
    expect(long).toHaveLength(MAX_EVENTS)
    expect(long[0].at).toBe(10)
  })

  it('knows since when', () => {
    expect(sinceOf([e('request', true, 5), e('accept', false, 9)])).toBe(9)
  })

  it('maps what you want to what to send', () => {
    expect(actionFor('none', 'add')).toBe('request')
    expect(actionFor('incoming', 'add')).toBe('accept')
    expect(actionFor('outgoing', 'add')).toBeNull()
    expect(actionFor('friends', 'remove')).toBe('remove')
    expect(actionFor('none', 'remove')).toBeNull()
    expect(actionFor('incoming', 'ignore')).toBe('decline')
    expect(actionFor('outgoing', 'cancel')).toBe('cancel')
    expect(actionFor('friends', 'accept')).toBeNull()
  })

  it('cleans friend state from a linked device', () => {
    expect(cleanFriendState(null)).toBeNull()
    expect(cleanFriendState({ v: 2, peers: {} })).toBeNull()
    const clean = cleanFriendState({
      v: 1,
      peers: {
        good: { name: 'Sam', events: [{ id: 'a', kind: 'request', mine: true, at: 1 }, { id: 'b', kind: 'hack', mine: true, at: 2 }, 'x'] },
        bad: { name: 1, events: 'nope' },
      },
      unsent: ['good', 'nobody', 5],
    })
    expect(clean).toEqual({ v: 1, peers: { good: { name: 'Sam', events: [{ id: 'a', kind: 'request', mine: true, at: 1 }] } }, unsent: ['good'] })
  })
})
