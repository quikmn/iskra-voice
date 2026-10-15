import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { b64u, ready } from '../core/crypto'
import { newChainId, signChannelChange, verifyChannelChain } from '../core/channelChain'
import { createIdentity, type Identity } from '../core/identity'
import type { Channel } from '../core/protocol'
import { rememberStamps, resetStampsForTests } from './channelGone'
import { e2eeWritesSettled, localMessages, sweepTombstones, useE2ee } from './e2eeChannels'
import { CHAIN_REPLACED, receiveChain, type ChainState } from './e2eeStartOver'
import { hideStored, loadVerdict, TOMBSTONE_MS, tombstonesToWipe } from './e2eeTombstone'
import { applyChannels, useApp, type ServerState } from './store'

// This device's storage, in memory; saves can be made slow to catch a save landing after a delete.
const disk = vi.hoisted(() => ({ data: new Map<string, unknown>(), saveDelay: 0 }))
vi.mock('../core/storage', async (original) => ({
  ...(await original<typeof import('../core/storage')>()),
  loadE2ee: async (slot: string) => structuredClone(disk.data.get(`e2ee:${slot}`)),
  saveE2ee: async (slot: string, value: unknown) => {
    const copy = structuredClone(value)
    if (disk.saveDelay) await new Promise((r) => setTimeout(r, disk.saveDelay))
    disk.data.set(`e2ee:${slot}`, copy)
  },
  deleteE2ee: async (slot: string) => void disk.data.delete(`e2ee:${slot}`),
  loadPrekeys: async () => [],
  savePrekeys: async () => undefined,
}))

const DAY = 24 * 60 * 60 * 1000
const SLOT = 'srv:7'

describe('tombstone rules', () => {
  const now = 100 * DAY
  it('a channel that is listed again with the same createdAt gets its keys back', () => {
    expect(loadVerdict({ hidden: { at: now - DAY, createdAt: 70 } }, { createdAt: 70 }, now)).toBe('lift')
    expect(loadVerdict({ hidden: { at: now - DAY, createdAt: 0 } }, { createdAt: 70 }, now)).toBe('lift') // older server: can't tell
  })
  it('a different createdAt is another channel: wiped', () => {
    expect(loadVerdict({ hidden: { at: now - DAY, createdAt: 70 } }, { createdAt: 700 }, now)).toBe('wipe')
    expect(loadVerdict({ createdAt: 70 }, { createdAt: 700 }, now)).toBe('wipe')
  })
  it('still not listed: nothing is used; after 30 days: wiped', () => {
    expect(loadVerdict({ hidden: { at: now - DAY, createdAt: 70 } }, null, now)).toBe('wait')
    expect(loadVerdict({ hidden: { at: now - TOMBSTONE_MS - 1, createdAt: 70 } }, { createdAt: 70 }, now)).toBe('wipe')
    expect(tombstonesToWipe({ a: now - TOMBSTONE_MS - 1, b: now - DAY }, now)).toEqual(['a'])
  })
  it('a tombstone keeps no text, and keeps the time it was first made', () => {
    const t = hideStored({ createdAt: 70, messages: [{ text: 'secret', hids: ['h'] }] }, now, 0)
    expect(t.messages).toEqual([{ text: '', hids: ['h'] }])
    expect(t.hidden).toEqual({ at: now, createdAt: 70 })
    expect(hideStored(t, now + DAY, 70).hidden.at).toBe(now)
  })
})

describe('an encrypted channel that stops being listed', () => {
  let me: Identity
  let chain: string
  let create: ReturnType<typeof signChannelChange>
  const channel = (createdAt: number) => ({ id: 7, name: 'secret', kind: 'text', position: 0, readRole: 'member', writeRole: 'member', createdAt, e2ee: {} }) as unknown as Channel
  const stored = () => disk.data.get(`e2ee:${SLOT}`) as { chain: string; changes: unknown[]; messages: { text: string; hids?: string[] }[]; hidden?: unknown } | undefined

  beforeAll(async () => {
    await ready()
    me = createIdentity()
    chain = newChainId()
    create = signChannelChange(me, null, chain, 'create', [])
  })

  beforeEach(async () => {
    await e2eeWritesSettled()
    disk.data.clear()
    disk.saveDelay = 0
    resetStampsForTests()
    disk.data.set(`e2ee:${SLOT}`, {
      chain, changes: [create], keys: {}, createdAt: 70,
      messages: [{ id: 1, channelId: 7, author: 'a', text: 'the secret plan', at: 1, hids: ['h1'], origin: 'h1' }],
    })
    const server = { key: 'srv', name: 'S', status: { state: 'online' }, me: null, members: {}, channels: [channel(70)], messages: {}, hasMore: {}, typing: {}, voice: {} } as unknown as ServerState
    useApp.setState({ identity: me, servers: { srv: server }, activeServer: 'srv' })
    rememberStamps('srv', server.channels)
    await localMessages('srv', 7) // loaded on this device
  })

  const hide = async () => {
    applyChannels('srv', [])
    await e2eeWritesSettled()
  }

  it('drops the plaintext at once and keeps the chain and keys as a tombstone', async () => {
    await hide()
    expect(useE2ee.getState().channels[SLOT]).toBeUndefined()
    expect(stored()?.chain).toBe(chain)
    expect(stored()?.messages.map((m) => m.text)).toEqual([''])
    expect(stored()?.messages[0].hids).toEqual(['h1']) // what was seen still guards against replays
    expect(stored()?.hidden).toBeTruthy()
    expect(disk.data.get('e2ee:tombstones')).toHaveProperty(SLOT)
  })

  it('listed again with the same createdAt: the pinned chain is used again, so a substitute is refused', async () => {
    await hide()
    applyChannels('srv', [channel(70)])
    expect((await localMessages('srv', 7)).map((m) => m.text)).toEqual(['']) // texts come back by decrypting again
    expect(useE2ee.getState().channels[SLOT]?.members).toEqual([b64u(me.account.publicKey)])
    await new Promise((r) => setTimeout(r, 600)) // the save that lifts the tombstone
    await e2eeWritesSettled()
    expect(stored()?.hidden).toBeUndefined()
    expect(disk.data.get('e2ee:tombstones')).not.toHaveProperty(SLOT)

    // The server now offers a different chain from scratch: the kept chain refuses it.
    const kept = stored()!
    const state: ChainState = { chain: kept.chain, changes: [], view: verifyChannelChain(kept.chain, kept.changes as never), keys: new Map(), past: [], offer: null, restarts: [] }
    const other = newChainId()
    receiveChain(state, other, [signChannelChange(createIdentity(), null, other, 'create', [b64u(me.account.publicKey)])], b64u(me.account.publicKey))
    expect(state.chain).toBe(chain)
    expect(state.problem).toBe(CHAIN_REPLACED)
  })

  it('listed again with a different createdAt: another channel, so the tombstone is wiped', async () => {
    await hide()
    applyChannels('srv', [channel(700)])
    expect(await localMessages('srv', 7)).toEqual([])
    await e2eeWritesSettled()
    expect(stored()).toBeUndefined()
  })

  it('replaced while listed (a different createdAt under the id): wiped at once', async () => {
    applyChannels('srv', [channel(700)])
    await e2eeWritesSettled()
    expect(stored()).toBeUndefined()
  })

  it('a tombstone older than 30 days is wiped', async () => {
    await hide()
    disk.data.set('e2ee:tombstones', { [SLOT]: Date.now() - TOMBSTONE_MS - 1 })
    await sweepTombstones()
    await e2eeWritesSettled()
    expect(stored()).toBeUndefined()
  })

  it('a save still on its way never lands after the channel was wiped', async () => {
    // An expired message makes the load save again (after 500 ms); that save is slow.
    disk.data.set(`e2ee:srv:8`, {
      chain, changes: [create], keys: {}, createdAt: 80,
      messages: [{ id: 2, channelId: 8, author: 'a', text: 'gone soon', at: 1, expiresAt: 1 }, { id: 3, channelId: 8, author: 'a', text: 'kept', at: 2 }],
    })
    const both = [channel(70), { ...channel(80), id: 8 }]
    applyChannels('srv', both)
    await localMessages('srv', 8)
    disk.saveDelay = 200
    await new Promise((r) => setTimeout(r, 550)) // the save has started
    applyChannels('srv', [channel(70), { ...channel(800), id: 8 }]) // another channel now has id 8
    await e2eeWritesSettled()
    await new Promise((r) => setTimeout(r, 300))
    expect(disk.data.get('e2ee:srv:8')).toBeUndefined()
  })
})
