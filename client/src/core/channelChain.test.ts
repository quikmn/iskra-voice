import { beforeAll, describe, expect, it } from 'vitest'
import { b64u, ready, sign, signedPayload } from './crypto'
import {
  CHANNEL_CHANGE_CONTEXT, decryptChannelMessage, encryptChannelMessage, MissingKeyError, newChainId, newEpochKey, openEpochKey,
  sealEpochKey, signChannelChange, slotDevices, verifyChannelChain, voiceKey, voiceKeyIndex,
  type ChannelEnvelope, type ChannelView, type MemberDevices,
} from './channelChain'
import { GroupBehindError, type GroupChange } from './group'
import { createIdentity, type Identity } from './identity'

beforeAll(ready)

const key = (id: Identity) => b64u(id.account.publicKey)
const devices = (...ids: Identity[]): MemberDevices[] => ids.map((id) => ({ accountKey: key(id), devices: [id.cert] }))

function forge(by: Identity, body: Record<string, unknown>): GroupChange {
  const bytes = new TextEncoder().encode(JSON.stringify(body))
  return { payload: b64u(bytes), sig: b64u(sign(signedPayload(CHANNEL_CHANGE_CONTEXT, bytes), by.account.secretKey)) }
}

/** Alice made the channel for Alice, Bob and Carol; everyone got the first key. */
function setup() {
  const [alice, bob, carol, dave] = [createIdentity(), createIdentity(), createIdentity(), createIdentity()]
  const chain = newChainId()
  const create = signChannelChange(alice, null, chain, 'create', [key(bob), key(carol)])
  const view = verifyChannelChain(chain, [create])
  const k1 = newEpochKey()
  const keys1 = sealEpochKey(alice, view, k1, devices(alice, bob, carol))
  return { alice, bob, carol, dave, chain, create, view, k1, keys1 }
}

/** What one device holds: the epoch keys it could open. */
function keyring(me: Identity, view: ChannelView, envelopes: ReturnType<typeof sealEpochKey>) {
  const ring = new Map<number, Uint8Array>()
  for (const e of envelopes) {
    try {
      const { version, key: k } = openEpochKey(me, e, view)
      ring.set(version, k)
    } catch {
      /* not for this device */
    }
  }
  return ring
}

const route = (e: ChannelEnvelope) => ({ from: e.header.from, version: e.header.version })

describe('encrypted channel chain', () => {
  it('lets any member add, remove and rekey, and keeps the member list exact', () => {
    const { alice, bob, carol, dave, chain, create, view } = setup()
    const add = signChannelChange(bob, view, chain, 'add', [key(dave)])
    const v2 = verifyChannelChain(chain, [add], view)
    expect(v2.members).toEqual([key(alice), key(bob), key(carol), key(dave)])
    const remove = signChannelChange(dave, v2, chain, 'remove', [key(alice), key(carol)])
    const v3 = verifyChannelChain(chain, [remove], v2)
    expect(v3.members).toEqual([key(bob), key(dave)])
    const rekey = signChannelChange(bob, v3, chain, 'rekey', [])
    expect(verifyChannelChain(chain, [create, add, remove, rekey]).version).toBe(4)
    // Nobody removes themselves (they'd be added straight back while they can read it).
    expect(() => signChannelChange(bob, v3, chain, 'remove', [key(bob)])).toThrow()
  })

  it('refuses changes made by outsiders, for another chain or that skip ahead', () => {
    const { bob, dave, chain, view } = setup()
    const selfAdd = forge(dave, { v: 1, group: chain, version: 2, prev: view.head, by: key(dave), action: 'add', targets: [key(dave)], members: [...view.members, key(dave)], at: Date.now() })
    expect(() => verifyChannelChain(chain, [selfAdd], view)).toThrow(/outside/)
    const other = signChannelChange(bob, view, newChainId(), 'rekey', [])
    expect(() => verifyChannelChain(chain, [other], view)).toThrow()
    const skip = forge(bob, { v: 1, group: chain, version: 3, prev: view.head, by: key(bob), action: 'rekey', targets: [], members: view.members, at: Date.now() })
    expect(() => verifyChannelChain(chain, [skip], view)).toThrow(/fit/)
    // A group DM change (other context) doesn't count here.
    expect(() => verifyChannelChain(chain, [{ ...signChannelChange(bob, view, chain, 'rekey', []), sig: b64u(new Uint8Array(64)) }], view)).toThrow(/signed/)
  })

  it('caps a channel at 50 people', () => {
    const { bob, chain, view } = setup()
    const many = Array.from({ length: 48 }, () => key(createIdentity()))
    expect(() => signChannelChange(bob, view, chain, 'add', many)).toThrow(/50/)
    expect(() => signChannelChange(bob, view, chain, 'add', many.slice(0, 47))).not.toThrow()
  })
})

describe('epoch keys and messages', () => {
  it('lets every member read, and binds the sender, version and chain', () => {
    const { alice, bob, carol, view, keys1 } = setup()
    const env = encryptChannelMessage(bob, view, keyring(bob, view, keys1).get(1)!, { text: 'hej allihop' })
    for (const reader of [alice, carol, bob]) {
      const ring = keyring(reader, view, keys1)
      expect(decryptChannelMessage(env, route(env), view, (v) => ring.get(v)).text).toBe('hej allihop')
    }
    const ring = keyring(alice, view, keys1)
    // The server can't reattribute it, move it to another version, or change a byte.
    expect(() => decryptChannelMessage(env, { from: key(carol), version: 1 }, view, (v) => ring.get(v))).toThrow(/sender/)
    expect(() => decryptChannelMessage(env, { from: key(bob), version: 2 }, view, (v) => ring.get(v))).toThrow()
    const flipped = { ...env, ct: env.ct.slice(0, -2) + (env.ct.endsWith('A') ? 'BA' : 'AA') }
    expect(() => decryptChannelMessage(flipped, route(flipped), view, (v) => ring.get(v))).toThrow(/tampered/)
  })

  it('stops a member writing as someone else, even with the shared key', () => {
    const { bob, carol, view, keys1 } = setup()
    const ring = keyring(carol, view, keys1)
    // Carol has the epoch key and builds a message claiming to be Bob, signed by her own device.
    const forged = encryptChannelMessage(carol, view, ring.get(1)!, { text: 'I am Bob' })
    const asBob = { ...forged, header: { ...forged.header, from: key(bob) } }
    expect(() => decryptChannelMessage(asBob, route(asBob), view, (v) => ring.get(v))).toThrow()
  })

  it('only takes an epoch key from whoever made that change', () => {
    const { alice, bob, view, keys1 } = setup()
    // Bob didn't make version 1, so a key he sends for it is refused.
    expect(() => sealEpochKey(bob, view, newEpochKey(), devices(alice, bob))).toThrow(/whoever changed/)
    const fake = { ...keys1[0], header: { ...keys1[0].header, from: key(bob) }, sender: bob.cert }
    expect(() => openEpochKey(alice, fake, view)).toThrow()
  })

  it('rekeys on removal: the removed member keeps old messages but cannot read new ones (forward secrecy across epochs)', () => {
    const { alice, bob, carol, chain, view, keys1 } = setup()
    const old = encryptChannelMessage(alice, view, keyring(alice, view, keys1).get(1)!, { text: 'before' })

    const remove = signChannelChange(bob, view, chain, 'remove', [key(carol)])
    const v2 = verifyChannelChain(chain, [remove], view)
    const k2 = newEpochKey()
    const keys2 = sealEpochKey(bob, v2, k2, devices(alice, bob, carol)) // even handed Carol's devices, only members get slots
    expect(slotDevices(keys2).has(carol.cert.deviceKey)).toBe(false)
    const fresh = encryptChannelMessage(alice, v2, keyring(alice, v2, [...keys1, ...keys2]).get(2)!, { text: 'after' })

    // Carol (who may still have fetched the new chain) has only epoch 1.
    const carolRing = keyring(carol, v2, [...keys1, ...keys2])
    expect([...carolRing.keys()]).toEqual([1])
    expect(decryptChannelMessage(old, route(old), v2, (v) => carolRing.get(v)).text).toBe('before')
    expect(() => decryptChannelMessage(fresh, route(fresh), v2, (v) => carolRing.get(v))).toThrow(MissingKeyError)
    // Even trying the old key on the new epoch fails: keys are independent.
    expect(() => decryptChannelMessage(fresh, route(fresh), v2, () => carolRing.get(1))).toThrow(/tampered/)
    // Bob still reads both.
    const bobRing = keyring(bob, v2, [...keys1, ...keys2])
    expect(decryptChannelMessage(fresh, route(fresh), v2, (v) => bobRing.get(v)).text).toBe('after')
    // And Carol can't send to the new epoch.
    expect(() => encryptChannelMessage(carol, v2, k2, { text: 'x' })).toThrow(/not in/)
  })

  it('gives a new member access from when they joined, not before', () => {
    const { alice, bob, dave, chain, view, keys1 } = setup()
    const before = encryptChannelMessage(alice, view, keyring(alice, view, keys1).get(1)!, { text: 'old news' })
    const add = signChannelChange(bob, view, chain, 'add', [key(dave)])
    const v2 = verifyChannelChain(chain, [add], view)
    const keys2 = sealEpochKey(bob, v2, newEpochKey(), devices(alice, bob, dave))
    const daveRing = keyring(dave, v2, [...keys1, ...keys2])
    expect([...daveRing.keys()]).toEqual([2])
    expect(() => decryptChannelMessage(before, route(before), v2, (v) => daveRing.get(v))).toThrow(MissingKeyError)
    const after = encryptChannelMessage(alice, v2, keyring(alice, v2, keys2).get(2)!, { text: 'welcome' })
    expect(decryptChannelMessage(after, route(after), v2, (v) => daveRing.get(v)).text).toBe('welcome')
  })

  it('asks to catch up on a version this device has not verified yet', () => {
    const { alice, bob, chain, view, keys1 } = setup()
    const v2 = verifyChannelChain(chain, [signChannelChange(bob, view, chain, 'rekey', [])], view)
    const keys2 = sealEpochKey(bob, v2, newEpochKey(), devices(alice, bob))
    const env = encryptChannelMessage(alice, v2, keyring(alice, v2, keys2).get(2)!, { text: 'new' })
    expect(() => decryptChannelMessage(env, route(env), view, () => undefined)).toThrow(GroupBehindError)
    expect(() => openEpochKey(alice, keys2[0], view)).toThrow(GroupBehindError)
    expect(keys1.length).toBe(1)
  })

  it('splits big member lists over several key envelopes', () => {
    const { alice, chain } = setup()
    const people = Array.from({ length: 49 }, () => createIdentity())
    const create = signChannelChange(alice, null, chain, 'create', people.map(key))
    const view = verifyChannelChain(chain, [create])
    // Four devices each: 200 slots over two envelopes.
    const bundles: MemberDevices[] = [alice, ...people].map((p) => ({ accountKey: key(p), devices: [p.cert, ...Array.from({ length: 3 }, () => extraDevice(p).cert)] }))
    const envelopes = sealEpochKey(alice, view, newEpochKey(), bundles)
    expect(envelopes.length).toBe(2)
    expect(slotDevices(envelopes).size).toBe(200)
    expect(JSON.stringify(envelopes[0]).length).toBeLessThan(52 * 1024)
  })

  it('derives a separate voice key per epoch', () => {
    const k = newEpochKey()
    expect(b64u(voiceKey(k))).not.toBe(b64u(k))
    expect(b64u(voiceKey(k))).toBe(b64u(voiceKey(k)))
    expect(voiceKeyIndex(17)).toBe(1)
  })
})

/** Another device certified by the same account. */
function extraDevice(owner: Identity): Identity {
  const other = createIdentity()
  const created = Date.now()
  const cert = { ...other.cert, accountKey: key(owner), created, sig: '' }
  const payload = signedPayload('iskra/device-cert/v1', other.device.publicKey, u64(created))
  cert.sig = b64u(sign(payload, owner.account.secretKey))
  return { ...other, account: owner.account, cert }
}

function u64(n: number): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(n), false)
  return out
}
