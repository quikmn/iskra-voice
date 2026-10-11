import { describe, expect, it } from 'vitest'
import type { GroupView, VerifiedChange } from '../core/group'
import { callColumns, changeText, checkGroupKey, groupTitle, isNewerKey, keyholder, ringNotice, timeline } from './groupLogic'

const names: Record<string, string> = { a: 'Alice', b: 'Bob', c: 'Carol', d: 'Dave', e: 'Erin' }
const nameOf = (k: string) => names[k] ?? 'Someone'
const change = (version: number, action: VerifiedChange['action'], by: string, targets: string[], at: number): VerifiedChange =>
  ({ v: 1, group: 'g', version, prev: '', by, action, targets, members: [], at, head: `h${version}` })

describe('group helpers', () => {
  it('describes membership changes, with "you" for yourself', () => {
    expect(changeText(change(1, 'create', 'a', ['b', 'c'], 0), 'b', nameOf)).toBe('Alice created the group with you and Carol')
    expect(changeText(change(2, 'add', 'b', ['d'], 0), 'b', nameOf)).toBe('You added Dave')
    expect(changeText(change(3, 'remove', 'a', ['c'], 0), 'b', nameOf)).toBe('Alice removed Carol')
    expect(changeText(change(4, 'leave', 'a', ['a'], 0), 'b', nameOf)).toBe('Alice left the group')
  })

  it('names a group after its members until someone names it', () => {
    expect(groupTitle(null, ['a', 'b', 'c'], 'a', nameOf)).toBe('Bob and Carol')
    expect(groupTitle(null, ['a', 'b', 'c', 'd', 'e'], 'a', nameOf)).toBe('Bob, Carol, Dave and Erin')
    expect(groupTitle(null, ['a', 'b', 'c', 'd', 'e', 'x'], 'a', nameOf)).toBe('Bob, Carol, Dave and 2 more')
    expect(groupTitle('Trip', ['a', 'b', 'c'], 'a', nameOf)).toBe('Trip')
  })

  it('interleaves membership changes with messages by time', () => {
    const view = { changes: [change(1, 'create', 'a', ['b', 'c'], 10), change(2, 'add', 'a', ['d'], 30)] } as GroupView
    const items = timeline([{ id: 'm1', from: 'b', text: 'hi', sentAt: 20 }, { id: 'm2', from: 'd', text: 'yo', sentAt: 30 }], view)
    expect(items.map((i) => (i.kind === 'change' ? `c${i.change.version}` : i.message.id))).toEqual(['c1', 'm1', 'c2', 'm2'])
  })

  it('lays out 1–10 call tiles', () => {
    expect([1, 2, 3, 4, 5, 9, 10].map((n) => callColumns(n, false))).toEqual([1, 2, 2, 2, 3, 3, 4])
    expect([1, 2, 3, 10].map((n) => callColumns(n, true))).toEqual([1, 1, 2, 2])
  })

  it('accepts only well-formed call keys for the right call, and never an older one', () => {
    const key = 'k'.repeat(43)
    expect(checkGroupKey({ kind: 'group-key', id: 'c1', key, index: 3, video: false }, 'c1')).toEqual({ kind: 'group-key', id: 'c1', key, index: 3, video: false })
    expect(checkGroupKey({ kind: 'group-key', id: 'c2', key, index: 3, video: false }, 'c1')).toBeNull()
    expect(checkGroupKey({ kind: 'group-key', id: 'c1', key, index: 16, video: false }, 'c1')).toBeNull()
    expect(checkGroupKey({ kind: 'group-key', id: 'c1', key: 'short', index: 0, video: false }, 'c1')).toBeNull()
    expect(isNewerKey({ version: 2, sentAt: 1 }, { version: 1, sentAt: 5 })).toBe(true)
    expect(isNewerKey({ version: 2, sentAt: 5 }, { version: 2, sentAt: 5 })).toBe(false)
    expect(isNewerKey({ version: 1, sentAt: 9 }, { version: 2, sentAt: 5 })).toBe(false)
  })

  it('picks the longest-present member still in the group to send new keys', () => {
    expect(keyholder(['c', 'a', 'b'], ['a', 'b'])).toBe('a')
    expect(keyholder(['c'], ['a', 'b'])).toBeUndefined()
  })

  it('notifies about a ringing group call only when the window is in the background and notifications are allowed', () => {
    const env = { focused: false, enabled: true, permission: 'granted' }
    expect(ringNotice('Alice', 'Trip', true, env)).toEqual({ title: 'Alice started a group call', body: 'Trip · Video call · end-to-end encrypted' })
    expect(ringNotice('Alice', 'Trip', false, { ...env, focused: true })).toBeNull()
    expect(ringNotice('Alice', 'Trip', false, { ...env, enabled: false })).toBeNull()
    expect(ringNotice('Alice', 'Trip', false, { ...env, permission: 'default' })).toBeNull()
  })
})
