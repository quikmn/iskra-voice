import { beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Message, Thread } from '../core/protocol'
import { goneChannels, rememberStamps, resetStampsForTests, stampsOf, withoutChannels } from './channelGone'
import { draftKey, setDraft, useDrafts } from './drafts'
import { useDocs } from './docs'
import { useE2ee } from './e2eeChannels'
import { useForums } from './forums'
import { channelConv, noteMessage, useReads } from './readState'
import { applyChannels, useApp, type ServerState } from './store'
import { useThreads } from './threads'

const channel = (id: number, createdAt?: number): Channel =>
  ({ id, name: `c${id}`, kind: 'text', position: id, readRole: 'member', writeRole: 'member', ...(createdAt === undefined ? {} : { createdAt }) })
const msg = (id: number, channelId: number, text = 't'): Message =>
  ({ id, channelId, author: 'bob', text, createdAt: id, editedAt: null, attachments: [], replyTo: null, reactions: [] } as unknown as Message)
const thread = (id: number, channelId: number): Thread =>
  ({ id, channelId, rootId: 1, name: `t${id}`, createdBy: 'bob', createdAt: 1, messageCount: 1, lastMessageAt: 1 })

describe('which channels a device forgets', () => {
  it('forgets channels no longer listed, and ones listed again under a different createdAt', () => {
    const known = stampsOf([channel(1, 10), channel(7, 70), channel(8, 80)])
    expect(goneChannels(known, [channel(1, 10), channel(8, 80)])).toEqual([7]) // deleted (or no longer readable)
    expect(goneChannels(known, [channel(1, 10), channel(7, 99), channel(8, 80)])).toEqual([7]) // another channel, same id
    expect(goneChannels(known, [channel(1, 10), channel(7, 70), channel(8, 80), channel(9, 90)])).toEqual([])
  })

  it('without createdAt (an older server) only a missing channel counts', () => {
    expect(goneChannels(stampsOf([channel(7)]), [channel(7, 70)])).toEqual([])
    expect(goneChannels(stampsOf([channel(7, 70)]), [channel(7)])).toEqual([])
  })

  it('drops keyed records only for the right server', () => {
    const record = { 'a:7': 1, 'a:8': 2, 'b:7': 3 }
    expect(withoutChannels(record, 'a', [7])).toEqual({ 'a:8': 2, 'b:7': 3 })
    expect(withoutChannels(record, 'a', [9])).toBe(record)
  })
})

describe('a deleted channel leaves nothing on the device', () => {
  beforeEach(() => {
    resetStampsForTests()
    useReads.setState({ convs: {} })
    useDrafts.setState({ drafts: {} })
    useThreads.setState({ threads: { srv: { 20: thread(20, 7), 21: thread(21, 1) } }, open: null })
    const server = {
      key: 'srv', name: 'Server', status: { state: 'online' }, me: null, members: {},
      channels: [channel(1, 10), channel(7, 70)],
      messages: { 1: [msg(1, 1)], 7: [msg(2, 7, 'old ci build log')], 20: [msg(3, 20)], 21: [msg(4, 21)] },
      hasMore: { 7: true }, typing: { 7: { bob: Date.now() + 1000 } }, voice: {},
    } as unknown as ServerState
    useApp.setState({ servers: { srv: server }, activeServer: 'srv' })
    rememberStamps('srv', server.channels)
    setDraft(draftKey.channel('srv', 7), 'half-written')
    setDraft(draftKey.channel('srv', 20), 'thread draft')
    setDraft(draftKey.channel('srv', 1), 'stays')
    noteMessage(channelConv('srv', 7), { id: 2, at: 2 }, true)
    useForums.setState({ lists: {}, tags: { 'srv:7': [] }, posts: {}, seen: {} })
    useDocs.setState({ lists: {}, texts: {}, open: { 'srv:7': 5 }, drafts: {}, home: {} })
    useE2ee.setState({ channels: { 'srv:7': { members: [], version: 1, hasKey: true, restarts: [] } } })
  })

  const server = () => useApp.getState().servers.srv

  it('when it leaves the channel list: messages, threads, drafts, read state and the rest go', () => {
    applyChannels('srv', [channel(1, 10)])
    expect(Object.keys(server().messages).map(Number).sort((a, b) => a - b)).toEqual([1, 21])
    expect(server().hasMore[7]).toBeUndefined()
    expect(server().typing[7]).toBeUndefined()
    expect(useThreads.getState().threads.srv).toEqual({ 21: thread(21, 1) })
    expect(Object.keys(useDrafts.getState().drafts)).toEqual([draftKey.channel('srv', 1)])
    expect(useReads.getState().convs[channelConv('srv', 7)]).toBeUndefined()
    expect(useForums.getState().tags['srv:7']).toBeUndefined()
    expect(useDocs.getState().open['srv:7']).toBeUndefined()
    expect(useE2ee.getState().channels['srv:7']).toBeUndefined() // and its keys and decrypted messages in storage
  })

  it('a new channel under the old id starts empty', () => {
    applyChannels('srv', [channel(1, 10), channel(7, 700)]) // deleted, and a new one got its id (older servers)
    expect(server().channels.map((c) => c.id)).toEqual([1, 7])
    expect(server().messages[7]).toBeUndefined()
    expect(server().messages[20]).toBeUndefined()
    expect(useDrafts.getState().drafts[draftKey.channel('srv', 7)]).toBeUndefined()
  })

  it('also across a restart: what the device saw last is remembered', () => {
    resetStampsForTests()
    applyChannels('srv', [channel(1, 10), channel(7, 70)]) // nothing known yet: nothing to compare
    expect(server().messages[7]).toHaveLength(1)
    applyChannels('srv', [channel(1, 10)])
    expect(server().messages[7]).toBeUndefined()
  })

  it('keeps everything when the list only changes otherwise', () => {
    applyChannels('srv', [channel(1, 10), { ...channel(7, 70), name: 'renamed' }, channel(9, 90)])
    expect(server().messages[7]).toHaveLength(1)
    expect(useDrafts.getState().drafts[draftKey.channel('srv', 7)]?.text).toBe('half-written')
  })
})
