import { describe, expect, it } from 'vitest'
import type { PendingMessage } from './store'
import { nextUnread, resolveMarker } from './unread'

const msg = (id: number): PendingMessage => ({ id, channelId: 1, author: 'a', text: 't', createdAt: id * 1000, editedAt: null, attachments: [], replyTo: null, reactions: [] })

describe('unread navigation', () => {
  it('finds the first new message once enough history is loaded', () => {
    const marker = { count: 2, anchorId: null, firstId: null, since: null }
    expect(resolveMarker(marker, undefined, true)).toBe(marker)
    const list = [msg(1), msg(2), msg(3), msg(4)]
    expect(resolveMarker(marker, list, true)).toMatchObject({ anchorId: 4, firstId: 3, since: 3000 })
    // Newer messages after opening don't move it.
    expect(resolveMarker({ ...marker, anchorId: 3 }, [...list, msg(5)], true).firstId).toBe(2)
    // More unread than loaded: wait for older pages, unless there are none.
    expect(resolveMarker({ ...marker, count: 9 }, list, true).firstId).toBeNull()
    expect(resolveMarker({ ...marker, count: 9 }, list, false).firstId).toBe(1)
  })

  it('moves to the next or previous unread channel, wrapping around', () => {
    const order = [{ id: 1, unread: false }, { id: 2, unread: true }, { id: 3, unread: false }, { id: 4, unread: true }]
    expect(nextUnread(order, 1, 1)).toBe(2)
    expect(nextUnread(order, 2, 1)).toBe(4)
    expect(nextUnread(order, 4, 1)).toBe(2)
    expect(nextUnread(order, 1, -1)).toBe(4)
    expect(nextUnread(order, 3, -1)).toBe(2)
    expect(nextUnread(order, null, 1)).toBe(2)
    expect(nextUnread([{ id: 1, unread: true }], 1, 1)).toBeNull()
    expect(nextUnread([], 1, 1)).toBeNull()
  })
})
