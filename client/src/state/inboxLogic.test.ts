import { describe, expect, it } from 'vitest'
import type { InboxItem, Message } from '../core/protocol'
import { buildInbox, filterInbox, inboxBadge, mergeItems, missedItems, pingUnread, type InboxSources } from './inboxLogic'
import { NOTHING_UNREAD, type ConversationRead } from './readState'

const S = 'S'.repeat(43)
const P = 'p'.repeat(43)

const item = (id: number, kind: InboxItem['kind'] = 'mention'): InboxItem =>
  ({ kind, channelId: 3, at: id * 10, message: { id, channelId: 3, author: P, text: `m${id}`, createdAt: id * 10 } as Message })

const unreadFrom = (id: number, count = 1): ConversationRead => ({ ...NOTHING_UNREAD, unread: count, mentions: 1, from: { id, at: id * 10 } })

const sources = (over: Partial<InboxSources> = {}): InboxSources =>
  ({ pings: [], convs: {}, requests: [], reminders: [], includeEveryone: true, ...over })

describe('inbox', () => {
  it('takes unread from the read state: a ping is unread while its conversation is unread from it on', () => {
    expect(pingUnread(item(5), undefined)).toBe(false)
    expect(pingUnread(item(5), unreadFrom(5))).toBe(true)
    expect(pingUnread(item(5), unreadFrom(4))).toBe(true)
    expect(pingUnread(item(5), unreadFrom(6))).toBe(false)
  })

  it('lists pings, unread DMs and groups, friend requests and due reminders, newest first', () => {
    const conv = `c:${S}:3`
    const entries = buildInbox(sources({
      pings: [{ server: S, conv, item: item(1) }, { server: S, conv, item: item(9, 'reply') }],
      convs: { [conv]: unreadFrom(9), [`d:${P}`]: { ...unreadFrom(0, 2), from: { id: 'x', at: 50 } }, [`g:${S}/${'g'.repeat(22)}`]: NOTHING_UNREAD },
      requests: [{ peer: P, at: 70 }],
      reminders: [{ server: S, id: 4, firedAt: 200 }],
    }))
    expect(entries.map((e) => e.type)).toEqual(['reminder', 'ping', 'request', 'dm', 'ping'])
    expect(entries.filter((e) => e.type === 'ping').map((e) => e.type === 'ping' && e.unread)).toEqual([true, false])
    expect(inboxBadge(entries)).toBe(3) // the unread ping, the reminder and the request (DMs badge Home)
    expect(filterInbox(entries, 'replies')).toHaveLength(1)
    expect(filterInbox(entries, 'mentions')).toHaveLength(1)
    expect(filterInbox(entries, 'reminders').map((e) => e.key)).toEqual([`r:${S}:4`])
    expect(filterInbox(entries, 'requests')).toHaveLength(1)
  })

  it('can leave @everyone and @here out', () => {
    const pings = [{ server: S, conv: 'c', item: item(1, 'everyone') }, { server: S, conv: 'c', item: item(2, 'role') }]
    expect(buildInbox(sources({ pings })).length).toBe(2)
    expect(buildInbox(sources({ pings, includeEveryone: false })).map((e) => e.type === 'ping' && e.item.kind)).toEqual(['role'])
  })

  it('merges pages without duplicates and counts only what this device missed', () => {
    const merged = mergeItems([item(3), item(1)], [item(2), item(3)])
    expect(merged.map((i) => i.message.id)).toEqual([3, 2, 1])
    expect(mergeItems(merged, [item(4)], 2).map((i) => i.message.id)).toEqual([4, 3])
    expect(missedItems(merged, undefined)).toEqual([]) // first time here: old pings don't all turn unread
    expect(missedItems(merged, 1).map((i) => i.message.id)).toEqual([3, 2])
  })
})
