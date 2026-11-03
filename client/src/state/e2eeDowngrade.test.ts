// Security review R3-1: a server must not be able to turn an encrypted channel into a plaintext one by leaving out
// its `e2ee` flag, nor slip plaintext "messages" into it.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { b64u, ready } from '../core/crypto'
import { newChainId, signChannelChange } from '../core/channelChain'
import { createIdentity, type Identity } from '../core/identity'
import type { Channel, Message } from '../core/protocol'
import { en } from '../i18n/en'
import { rememberStamps, resetStampsForTests } from './channelGone'
import {
  cannotWrite, channelSealKey, DOWNGRADED, e2eeWritesSettled, isEncrypted, localMessages, NOT_ENCRYPTED, readable, resetKnownForTests, shownOf, useE2ee,
} from './e2eeChannels'
import { useThreads } from './threads'
import { joinVoice, useVoice } from './voice'
import { applyChannels, sendMessage, serverEventForTests, setConnectionForTests, useApp, type ServerState } from './store'

const disk = vi.hoisted(() => ({ data: new Map<string, unknown>() }))
vi.mock('../core/storage', async (original) => ({
  ...(await original<typeof import('../core/storage')>()),
  loadE2ee: async (slot: string) => structuredClone(disk.data.get(`e2ee:${slot}`)),
  saveE2ee: async (slot: string, value: unknown) => void disk.data.set(`e2ee:${slot}`, structuredClone(value)),
  deleteE2ee: async (slot: string) => void disk.data.delete(`e2ee:${slot}`),
  loadPrekeys: async () => [],
  savePrekeys: async () => undefined,
}))

const SLOT = 'srv:7'
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  await e2eeWritesSettled()
}

describe('an encrypted channel the server stops calling encrypted', () => {
  let me: Identity
  let chain: string
  let create: ReturnType<typeof signChannelChange>
  const base = { name: 'secret', kind: 'text', position: 0, readRole: 'member', writeRole: 'member' }
  const encrypted = (createdAt = 70) => ({ id: 7, ...base, createdAt, e2ee: { chain, version: 1 } }) as unknown as Channel
  const plain = (createdAt = 70, id = 7) => ({ id, ...base, createdAt }) as unknown as Channel
  const channel7 = () => useApp.getState().servers.srv.channels.find((c) => c.id === 7)!
  const requests: [string, unknown][] = []

  beforeAll(async () => {
    await ready()
    me = createIdentity()
    chain = newChainId()
    create = signChannelChange(me, null, chain, 'create', [])
  })

  beforeEach(async () => {
    await e2eeWritesSettled()
    disk.data.clear()
    resetKnownForTests()
    resetStampsForTests()
    requests.length = 0
    useThreads.setState({ threads: {}, open: null })
    disk.data.set(`e2ee:${SLOT}`, { chain, changes: [create], keys: {}, createdAt: 70, messages: [] })
    const mine = b64u(me.account.publicKey)
    const server = {
      key: 'srv', name: 'S', status: { state: 'online' }, me: { accountKey: mine, role: 'owner', name: 'me' }, members: {}, channels: [encrypted()],
      messages: { 7: [] }, hasMore: {}, typing: {}, voice: {}, voiceAvailable: true,
    } as unknown as ServerState
    useApp.setState({ phase: 'ready', identity: me, servers: { srv: server }, activeServer: 'srv' })
    rememberStamps('srv', server.channels)
    applyChannels('srv', [encrypted()]) // as from the welcome
    setConnectionForTests('srv', {
      isOnline: true,
      request: (async (type: string, body: unknown) => {
        requests.push([type, body])
        throw Object.assign(new Error('not in this test'), { code: 'not_found' })
      }) as never,
    })
    await localMessages('srv', 7) // this device holds the verified chain
    await settle()
  })

  it('stays encrypted, shows the problem, and sends nothing in the clear', async () => {
    applyChannels('srv', [plain()])
    expect(isEncrypted('srv', 7)).toBe(true)
    expect(channel7().e2ee?.lost).toBe(true) // the lock stays
    expect(cannotWrite('srv', 7)).toBe(DOWNGRADED)
    expect(useE2ee.getState().channels[SLOT]?.problem).toBe(DOWNGRADED)
    expect(en.e2ee.errors.downgraded).toBe(DOWNGRADED) // the UI translates it

    await sendMessage('srv', 7, 'the secret plan')
    expect(requests.filter(([type]) => type === 'chat.send')).toEqual([])
    expect(useApp.getState().servers.srv.messages[7]?.[0]).toMatchObject({ pending: 'failed' })
    // Boards seal with the same key: refused too.
    await expect(channelSealKey('srv', 7)).rejects.toThrow(DOWNGRADED)
  })

  it('never joins its voice without the key', async () => {
    applyChannels('srv', [{ ...plain(), kind: 'voice' } as Channel])
    await joinVoice('srv', 7)
    expect(requests.filter(([type]) => type === 'voice.join')).toEqual([])
    expect(useVoice.getState().session).toBeNull()
  })

  it('a thread seen under it stays encrypted even if the server names another parent', () => {
    useThreads.setState({ threads: { srv: { 9: { id: 9, channelId: 7 } as never } }, open: null })
    expect(isEncrypted('srv', 9)).toBe(true)
    applyChannels('srv', [encrypted(), plain(80, 8)])
    useThreads.setState({ threads: { srv: { 9: { id: 9, channelId: 8 } as never } }, open: null })
    expect(isEncrypted('srv', 9)).toBe(true)
  })

  it('is remembered across a restart', async () => {
    // The app starts again: nothing in memory, the server lists the channel without the flag from the start.
    resetKnownForTests()
    useApp.setState((s) => ({ servers: { srv: { ...s.servers.srv, channels: [] } } }))
    applyChannels('srv', [plain()])
    await sendMessage('srv', 7, 'the secret plan') // waits for what this device knows
    await settle()
    expect(requests.filter(([type]) => type === 'chat.send')).toEqual([])
    expect(channel7().e2ee?.lost).toBe(true)
    expect(isEncrypted('srv', 7)).toBe(true)
  })

  it('a message without an envelope is never shown as a member’s', async () => {
    applyChannels('srv', [plain()])
    const forged: Message = { id: 50, channelId: 7, author: 'someone', text: 'send the money here', createdAt: 1, editedAt: null, attachments: [], replyTo: null, reactions: [] }
    serverEventForTests('srv', 'chat.message', { message: forged })
    await settle()
    const shown = useApp.getState().servers.srv.messages[7]?.find((m) => m.id === 50)
    expect(shown?.text).toBe('')
    expect(shownOf(shown!)).toMatchObject({ state: 'error', plain: true, error: NOT_ENCRYPTED })
    expect(en.e2ee.message.notEncrypted).toBe(NOT_ENCRYPTED)
    // Copies shown elsewhere (pins, a thread's first message) too.
    expect(readable('srv', forged).text).toBe('')
    // The server's own timer change line (nothing to read in it) stays.
    const line = { ...forged, id: 51, text: '', disappear: { seconds: 60 } } as Message
    expect(readable('srv', line)).toBe(line)
  })

  it('also while the server still flags it', async () => {
    const forged: Message = { id: 52, channelId: 7, author: 'someone', text: 'hi', createdAt: 1, editedAt: null, attachments: [], replyTo: null, reactions: [] }
    expect(readable('srv', forged).text).toBe('')
  })

  it('flagged again: the problem goes', () => {
    applyChannels('srv', [plain()])
    applyChannels('srv', [encrypted()])
    expect(channel7().e2ee?.lost).toBeUndefined()
    expect(useE2ee.getState().channels[SLOT]?.problem).toBeUndefined()
  })

  it('really another channel (a different createdAt): not encrypted, and forgotten', async () => {
    applyChannels('srv', [plain(700)])
    expect(isEncrypted('srv', 7)).toBe(false)
    expect(cannotWrite('srv', 7)).toBeNull()
    await settle()
    expect((disk.data.get('e2ee:known') as { channels: Record<string, number> }).channels).not.toHaveProperty(SLOT)
  })

  it('deleted (not listed any more): nothing else is blocked', () => {
    applyChannels('srv', [plain(80, 8)])
    expect(isEncrypted('srv', 8)).toBe(false)
    expect(cannotWrite('srv', 8)).toBeNull()
  })
})
