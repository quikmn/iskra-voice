import { beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Member, Thread } from '../core/protocol'
import type { PendingMessage, ServerState } from './store'
import { useApp } from './store'
import { useThreads } from './threads'
import {
  arrive, channelConv, dividerOf, dividerTarget, dmConv, leave, markConversationRead, markConversationUnread, moveConversation,
  noteMessage, NOTHING_UNREAD, readOf, see, setShown, unreadFrom, useReads, type ConversationRead,
} from './readState'
import { badgeTotal, channelCounts, markChannelRead, markServerRead, markUnread, nextUnread, serverBadges, unreadOrder } from './unread'

const ref = (id: number) => ({ id, at: id * 1000 })
const msg = (id: number, author = 'bob', text = 't'): PendingMessage =>
  ({ id, channelId: 1, author, text, createdAt: id * 1000, editedAt: null, attachments: [], replyTo: null, reactions: [] })
/** What the sidebar badge shows and what the divider shows, side by side. */
const both = (r: ConversationRead) => ({ badge: r.unread, divider: dividerOf(r) })

describe('read state transitions', () => {
  it('counts messages that arrive off screen, and opening turns the count into the divider', () => {
    let r = arrive(NOTHING_UNREAD, ref(5), false, false)
    r = arrive(r, ref(6), true, false)
    expect(r).toMatchObject({ unread: 2, mentions: 1, from: ref(5) })
    expect(arrive(r, ref(7), false, true)).toBe(r) // on screen: read as it arrives
    r = see(r)
    expect(both(r)).toEqual({ badge: 0, divider: { from: ref(5), count: 2 } })
    expect(r.mentions).toBe(0)
    expect(see(NOTHING_UNREAD)).toBe(NOTHING_UNREAD)
  })

  it('keeps the older divider when more arrives while the window is in the background', () => {
    let r = see(arrive(NOTHING_UNREAD, ref(5), false, false))
    r = arrive(r, ref(9), false, false)
    expect(r.unread).toBe(1)
    r = see(r)
    expect(both(r)).toEqual({ badge: 0, divider: { from: ref(5), count: 2 } })
    expect(leave(r)).toEqual(NOTHING_UNREAD)
  })

  it('Mark unread on screen moves the badge and the divider together, and they stay in step', () => {
    let r = see(arrive(NOTHING_UNREAD, ref(9), false, false)) // a divider from opening
    r = unreadFrom(ref(4), { unread: 3, mentions: 1 }, true)
    expect(both(r)).toEqual({ badge: 3, divider: { from: ref(4), count: 3 } })
    // Still on screen: new messages count, in both.
    r = arrive(r, ref(10), false, true)
    expect(both(r)).toEqual({ badge: 4, divider: { from: ref(4), count: 4 } })
    expect(see(r)).toBe(r) // focusing the window again doesn't read it
    // Leaving keeps it unread; coming back puts the divider at the same message.
    r = leave(r)
    expect(both(r)).toEqual({ badge: 4, divider: null })
    r = see(r)
    expect(both(r)).toEqual({ badge: 0, divider: { from: ref(4), count: 4 } })
  })

  it('Mark unread off screen only shows the divider once you open it', () => {
    const r = unreadFrom(ref(4), { unread: 0, mentions: 0 }, false)
    expect(both(r)).toEqual({ badge: 1, divider: null }) // at least the marked message
    expect(both(see(r))).toEqual({ badge: 0, divider: { from: ref(4), count: 1 } })
  })

  it('places the divider above the marked message, or the next one if it was deleted', () => {
    const list = [msg(1), msg(3), msg(5)]
    const at = (m: PendingMessage) => ({ id: m.id, at: m.createdAt })
    expect(dividerTarget(list, ref(3), at)?.id).toBe(3)
    expect(dividerTarget(list, ref(4), at)?.id).toBe(5)
    expect(dividerTarget(list, ref(6), at)).toBeNull()
    // DMs and groups have string ids: by time after the marked one.
    const dms = [{ id: 'a', at: 1 }, { id: 'b', at: 2 }, { id: 'c', at: 3 }]
    expect(dividerTarget(dms, { id: 'b', at: 2 }, (m) => m)?.id).toBe('b')
    expect(dividerTarget(dms, { id: 'gone', at: 2 }, (m) => m)?.id).toBe('c')
  })
})

describe('the read state store', () => {
  beforeEach(() => useReads.setState({ convs: {} }))

  it('opening a conversation reads it; leaving drops the divider; Esc clears everything', () => {
    const conv = dmConv('peer')
    noteMessage(conv, { id: 'x', at: 1 }, false)
    noteMessage(conv, { id: 'y', at: 2 }, false)
    expect(readOf(conv).unread).toBe(2)
    setShown('home', conv)
    expect(both(readOf(conv))).toEqual({ badge: 0, divider: { from: { id: 'x', at: 1 }, count: 2 } })
    markConversationRead(conv)
    expect(readOf(conv)).toEqual(NOTHING_UNREAD)
    markConversationUnread(conv, { id: 'y', at: 2 }, { unread: 1, mentions: 0 })
    expect(both(readOf(conv))).toEqual({ badge: 1, divider: { from: { id: 'y', at: 2 }, count: 1 } })
    setShown('home', null)
    expect(both(readOf(conv))).toEqual({ badge: 1, divider: null })
    expect(useReads.getState().shown).toEqual([])
  })

  it('moves a DM conversation\'s unread to a new account key', () => {
    noteMessage(dmConv('old'), { id: 'a', at: 1 }, false)
    noteMessage(dmConv('new'), { id: 'b', at: 2 }, false)
    moveConversation(dmConv('old'), dmConv('new'))
    expect(readOf(dmConv('old'))).toEqual(NOTHING_UNREAD)
    expect(readOf(dmConv('new'))).toMatchObject({ unread: 2, from: { id: 'b', at: 2 } })
  })
})

// ── Servers: rows, the server icon, Alt+↓ and the title all agree ──

const ME = 'me'.padEnd(43, 'm')
const member = (accountKey: string): Member => ({ accountKey, name: accountKey, role: 'member', online: true })
const channel = (id: number, kind: Channel['kind'] = 'text'): Channel =>
  ({ id, name: `c${id}`, kind, position: id, readRole: 'guest', writeRole: 'member' })
const thread = (id: number, channelId: number): Thread =>
  ({ id, channelId, rootId: 1, name: `t${id}`, createdBy: 'bob', createdAt: 1, messageCount: 1, lastMessageAt: 1 })
const server = {
  key: 'srv', name: 'Server', status: { state: 'online' }, channels: [channel(1), channel(2), channel(3, 'forum'), channel(4, 'voice')],
  me: member(ME), members: { [ME]: member(ME), bob: member('bob') },
  messages: { 1: [msg(10), msg(11, ME), msg(12, 'bob', `hi <@${ME}>`), msg(13)] }, hasMore: {},
} as unknown as ServerState

describe('server badges', () => {
  beforeEach(() => {
    useReads.setState({ convs: {} })
    setShown('channel', null)
    useApp.setState({ servers: { srv: server }, activeServer: null })
    useThreads.setState({ threads: { srv: { 20: thread(20, 2), 30: thread(30, 3) } } })
  })

  it('counts thread mentions on their channel and forum replies as the forum\'s unread', () => {
    noteMessage(channelConv('srv', 20), ref(1), false) // a plain reply in a text channel's thread
    noteMessage(channelConv('srv', 20), ref(2), true)
    noteMessage(channelConv('srv', 30), ref(3), false) // a reply in a forum post
    expect(channelCounts('srv', channel(2))).toEqual({ unread: 0, mentions: 1 })
    expect(channelCounts('srv', channel(3, 'forum'))).toEqual({ unread: 1, mentions: 0 })
  })

  it('lights the server icon only for what a channel row shows, so Alt+↓ always has somewhere to go', () => {
    // A plain thread reply used to light the server dot with no channel showing unread.
    noteMessage(channelConv('srv', 20), ref(1), false)
    expect(serverBadges(server)).toEqual({ pings: 0, unread: 0 })
    expect(unreadOrder(server).some((c) => c.unread)).toBe(false)
    // A forum reply shows on the forum row, the server icon, and Alt+↓ goes there.
    noteMessage(channelConv('srv', 30), ref(3), false)
    expect(serverBadges(server)).toEqual({ pings: 0, unread: 1 })
    expect(nextUnread(unreadOrder(server), 1, 1)).toBe(3)
    // A voice channel's chat shows on its row (the chat button) and counts too.
    noteMessage(channelConv('srv', 4), ref(2), false)
    expect(serverBadges(server).unread).toBe(2)
    expect(unreadOrder(server).find((c) => c.id === 4)?.unread).toBe(true)
  })

  it('the title count follows the same mention badges and DMs', () => {
    noteMessage(channelConv('srv', 1), ref(1), true)
    noteMessage(channelConv('srv', 20), ref(2), true)
    noteMessage(dmConv('peer'), { id: 'a', at: 1 }, false)
    expect(badgeTotal()).toBe(3)
    markChannelRead('srv', 2) // the channel and its threads
    expect(badgeTotal()).toBe(2)
    markServerRead('srv')
    expect(badgeTotal()).toBe(1)
  })

  it('Mark unread counts like arriving messages: not your own, mentions included', () => {
    markUnread('srv', 1, 10)
    expect(readOf(channelConv('srv', 1))).toMatchObject({ unread: 3, mentions: 1, from: ref(10), held: false })
    expect(serverBadges(server)).toEqual({ pings: 1, unread: 3 })
    // On screen, the divider sits on the same message with the same count as the badge.
    setShown('channel', channelConv('srv', 1))
    markUnread('srv', 1, 12)
    expect(both(readOf(channelConv('srv', 1)))).toEqual({ badge: 2, divider: { from: ref(12), count: 2 } })
    markChannelRead('srv', 1)
    expect(both(readOf(channelConv('srv', 1)))).toEqual({ badge: 0, divider: null })
  })
})

describe('moving between unread channels', () => {
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
