import { beforeAll, describe, expect, it } from 'vitest'
import { b64u, ready } from '../core/crypto'
import {
  encryptChannelMessage, newChainId, newEpochKey, signChannelChange, verifyChannelChain, type ChannelView,
} from '../core/channelChain'
import { createIdentity, type Identity } from '../core/identity'
import {
  acceptStartOver, CHAIN_REPLACED, checkStartOver, decryptInChain, mayReplaceChain, receiveChain, type ChainState, type TrustContext,
} from './e2eeStartOver'

beforeAll(ready)

const key = (id: Identity) => b64u(id.account.publicKey)
const HERE = { channel: 7 }
const empty = (): ChainState => ({ chain: null, changes: [], view: null, keys: new Map(), past: [], offer: null, restarts: [] })

/**
 * Alice, Bob and Carol were in the channel (Bob's device verified it and holds key 1 and a message). Then everyone lost
 * access; Dave, who can read it now, started a new chain and added Bob once Bob could read it again.
 */
function world() {
  const [alice, bob, carol, dave, mallory] = [createIdentity(), createIdentity(), createIdentity(), createIdentity(), createIdentity()]
  const old = newChainId()
  const oldChanges = [signChannelChange(alice, null, old, 'create', [key(bob), key(carol)])]
  const oldKey = newEpochKey()
  const bobs = empty()
  receiveChain(bobs, old, oldChanges, key(bob), 1000)
  bobs.keys.set(1, oldKey)
  const oldMessage = encryptChannelMessage(alice, bobs.view!, oldKey, { text: 'from before' }, HERE)

  const fresh = newChainId()
  const create = signChannelChange(dave, null, fresh, 'create', [])
  const add = signChannelChange(dave, verifyChannelChain(fresh, [create]), fresh, 'add', [key(bob)])
  // What a malicious server would make: its own account starts a chain "for" the real readers.
  const forged = newChainId()
  const forgedChanges = [signChannelChange(mallory, null, forged, 'create', [key(alice), key(bob), key(carol)])]
  return { alice, bob, carol, dave, mallory, old, oldKey, oldMessage, bobs, fresh, freshChanges: [create, add], forged, forgedChanges }
}

const ctx = (names: Record<string, string>, extra: Partial<TrustContext> = {}): TrustContext => ({
  same: (a, b) => a === b, isContact: () => false, warned: () => false, nameOf: (k) => names[k], ...extra,
})

describe('starting an encrypted channel over', () => {
  it('a legitimate restart becomes an offer, and only an explicit start-over takes it', () => {
    const w = world()
    receiveChain(w.bobs, w.fresh, w.freshChanges, key(w.bob), 2000)
    // Still on the chain Bob verified, with its key; sending is off and the new chain is only offered.
    expect(w.bobs.chain).toBe(w.old)
    expect(w.bobs.keys.get(1)).toEqual(w.oldKey)
    expect(w.bobs.problem).toBe(CHAIN_REPLACED)
    expect(w.bobs.offer?.chain).toBe(w.fresh)
    expect(w.bobs.offer?.view.members).toEqual([key(w.dave), key(w.bob)])
    // Seeing it again changes nothing.
    receiveChain(w.bobs, w.fresh, w.freshChanges, key(w.bob), 3000)
    expect(w.bobs.chain).toBe(w.old)
    expect(w.bobs.offer?.seenAt).toBe(2000)

    const record = acceptStartOver(w.bobs, 4000)
    expect(record).toEqual({ at: 4000, from: w.old, to: w.fresh })
    expect(w.bobs.chain).toBe(w.fresh)
    expect(w.bobs.view?.members).toEqual([key(w.dave), key(w.bob)])
    expect(w.bobs.problem).toBeUndefined()
    expect(w.bobs.offer).toBeNull()
    expect(w.bobs.restarts).toEqual([record])
    expect(w.bobs.past[0]).toMatchObject({ chain: w.old, startedOver: true, endedAt: 4000 })
  })

  it('there is nothing to accept without an offer', () => {
    const w = world()
    expect(() => acceptStartOver(w.bobs)).toThrow()
    expect(w.bobs.chain).toBe(w.old)
  })

  it('old messages stay readable with the kept chain and key', () => {
    const w = world()
    receiveChain(w.bobs, w.fresh, w.freshChanges, key(w.bob))
    acceptStartOver(w.bobs)
    const routed = { from: key(w.alice), version: 1, ...HERE }
    expect(decryptInChain(w.bobs, w.oldMessage, routed)?.text).toBe('from before')
    // New messages use the new chain (with its key once it arrives).
    const newKey = newEpochKey()
    w.bobs.keys.set(2, newKey)
    const fresh = encryptChannelMessage(w.dave, w.bobs.view!, newKey, { text: 'hello again' }, HERE)
    expect(decryptInChain(w.bobs, fresh, { from: key(w.dave), version: 2, ...HERE })?.text).toBe('hello again')
    // A chain this device never had: nothing to decrypt with.
    const stranger = { ...w.oldMessage, header: { ...w.oldMessage.header, chain: newChainId() } }
    expect(decryptInChain(w.bobs, stranger, routed)).toBeNull()
  })

  it('a chain you left never comes back as an offer, and a later swap is an offer again', () => {
    const w = world()
    receiveChain(w.bobs, w.fresh, w.freshChanges, key(w.bob))
    acceptStartOver(w.bobs)
    receiveChain(w.bobs, w.old, [signChannelChange(w.alice, null, w.old, 'create', [key(w.bob)])], key(w.bob))
    expect(w.bobs.offer).toBeNull()
    receiveChain(w.bobs, w.forged, w.forgedChanges, key(w.bob))
    expect(w.bobs.chain).toBe(w.fresh)
    expect(w.bobs.offer?.chain).toBe(w.forged)
  })

  it('a chain that does not verify is never offered', () => {
    const w = world()
    const broken = [{ ...w.freshChanges[0], sig: w.freshChanges[1].sig }, w.freshChanges[1]]
    receiveChain(w.bobs, w.fresh, broken, key(w.bob))
    expect(w.bobs.offer).toBeNull()
    expect(w.bobs.problem).toBe(CHAIN_REPLACED)
    expect(w.bobs.chain).toBe(w.old)
  })

  it('someone who was out of the chain follows a restart by itself, keeping the old chain for old messages', () => {
    const w = world()
    const daves = empty()
    receiveChain(daves, w.old, [signChannelChange(w.alice, null, w.old, 'create', [key(w.dave)])], key(w.carol))
    daves.keys.set(1, w.oldKey)
    expect(mayReplaceChain({ chain: daves.chain, members: daves.view?.members }, w.fresh, key(w.carol))).toBe(true)
    receiveChain(daves, w.fresh, w.freshChanges, key(w.carol))
    expect(daves.chain).toBe(w.fresh)
    expect(daves.past[0]).toMatchObject({ chain: w.old, startedOver: false })
    expect(daves.keys.size).toBe(0)
  })
})

describe('what the person sees before starting over', () => {
  const names = (w: ReturnType<typeof world>) => ({ [key(w.alice)]: 'Alice', [key(w.bob)]: 'Bob', [key(w.carol)]: 'Carol', [key(w.dave)]: 'Dave', [key(w.mallory)]: 'Mallory' })
  const offerOf = (chain: string, changes: Parameters<typeof verifyChannelChain>[1]): ChannelView => verifyChannelChain(chain, changes)

  it('a newcomer who restarted it: listed as new, and the person must confirm safety numbers', () => {
    const w = world()
    const check = checkStartOver(offerOf(w.fresh, w.freshChanges), w.bobs.view!.members, key(w.bob), ctx(names(w)))
    expect(check.signers).toEqual([{ key: key(w.dave), created: true, trust: 'new', warning: false }])
    expect(check).toMatchObject({ listed: true, blocked: null, confirm: true, lookalikes: [] })
  })

  it('signed by someone from the old chain with the same key: no extra confirmation', () => {
    const w = world()
    const create = signChannelChange(w.alice, null, w.fresh, 'create', [key(w.bob)])
    const check = checkStartOver(offerOf(w.fresh, [create]), w.bobs.view!.members, key(w.bob), ctx(names(w)))
    expect(check.signers[0]).toMatchObject({ key: key(w.alice), trust: 'old-chain' })
    expect(check.confirm).toBe(false)
    // A friend's key counts as known too.
    const viaFriend = checkStartOver(offerOf(w.fresh, w.freshChanges), w.bobs.view!.members, key(w.bob), ctx(names(w), { isContact: (k) => k === key(w.dave) }))
    expect(viaFriend.signers[0].trust).toBe('contact')
    expect(viaFriend.confirm).toBe(false)
  })

  it('a server-forged chain: a new key wearing an old member’s name must be confirmed, a key warning blocks it', () => {
    const w = world()
    // The server's account calls itself "Alice", and lists the real Bob and Carol.
    const fake = { ...names(w), [key(w.mallory)]: 'Alice' }
    const offer = offerOf(w.forged, w.forgedChanges)
    const check = checkStartOver(offer, w.bobs.view!.members, key(w.bob), ctx(fake))
    expect(check.signers).toEqual([{ key: key(w.mallory), created: true, trust: 'new', warning: false }])
    expect(check.lookalikes).toEqual([key(w.mallory)])
    expect(check.confirm).toBe(true)
    const warned = checkStartOver(offer, w.bobs.view!.members, key(w.bob), ctx(fake, { warned: (k) => k === key(w.mallory) }))
    expect(warned.blocked).toBe('key-warning')
  })

  it('not in the new chain yet: nothing to start over with', () => {
    const w = world()
    const check = checkStartOver(offerOf(w.fresh, [w.freshChanges[0]]), w.bobs.view!.members, key(w.bob), ctx(names(w)))
    expect(check).toMatchObject({ listed: false, blocked: 'not-listed' })
  })
})
