import sodium from 'libsodium-wrappers-sumo'
import { beforeAll, describe, expect, it } from 'vitest'
import vectors from '../../../protocol/vectors.json'
import { b64u, fromB64u, randomBytes, ready, sign, signedPayload } from './crypto'
import {
  accessEnd, CHANNEL_CHANGE_CONTEXT, channelMessageAd, channelMessageSigned, CLOCK_SKEW_MS, decryptChannelMessage, MOVED, encryptChannelMessage, MissingKeyError, newChainId, newEpochKey, openEpochKey,
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

/** Where the server put a message (one channel, 7, unless a test says otherwise). */
const HERE = { channel: 7 }
const route = (e: ChannelEnvelope, place: { channel: number; thread?: number } = HERE) => ({ from: e.header.from, version: e.header.version, ...place })

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
    const env = encryptChannelMessage(bob, view, keyring(bob, view, keys1).get(1)!, { text: 'hej allihop' }, HERE)
    for (const reader of [alice, carol, bob]) {
      const ring = keyring(reader, view, keys1)
      expect(decryptChannelMessage(env, route(env), view, (v) => ring.get(v)).text).toBe('hej allihop')
    }
    const ring = keyring(alice, view, keys1)
    // The server can't reattribute it, move it to another version, or change a byte.
    expect(() => decryptChannelMessage(env, { from: key(carol), version: 1, ...HERE }, view, (v) => ring.get(v))).toThrow(/sender/)
    expect(() => decryptChannelMessage(env, { from: key(bob), version: 2, ...HERE }, view, (v) => ring.get(v))).toThrow()
    const flipped = { ...env, ct: env.ct.slice(0, -2) + (env.ct.endsWith('A') ? 'BA' : 'AA') }
    expect(() => decryptChannelMessage(flipped, route(flipped), view, (v) => ring.get(v))).toThrow(/tampered/)
  })

  it('stops a member writing as someone else, even with the shared key', () => {
    const { bob, carol, view, keys1 } = setup()
    const ring = keyring(carol, view, keys1)
    // Carol has the epoch key and builds a message claiming to be Bob, signed by her own device.
    const forged = encryptChannelMessage(carol, view, ring.get(1)!, { text: 'I am Bob' }, HERE)
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
    const old = encryptChannelMessage(alice, view, keyring(alice, view, keys1).get(1)!, { text: 'before' }, HERE)

    const remove = signChannelChange(bob, view, chain, 'remove', [key(carol)])
    const v2 = verifyChannelChain(chain, [remove], view)
    const k2 = newEpochKey()
    const keys2 = sealEpochKey(bob, v2, k2, devices(alice, bob, carol)) // even handed Carol's devices, only members get slots
    expect(slotDevices(keys2).has(carol.cert.deviceKey)).toBe(false)
    const fresh = encryptChannelMessage(alice, v2, keyring(alice, v2, [...keys1, ...keys2]).get(2)!, { text: 'after' }, HERE)

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
    expect(() => encryptChannelMessage(carol, v2, k2, { text: 'x' }, HERE)).toThrow(/not in/)
  })

  it('gives a new member access from when they joined, not before', () => {
    const { alice, bob, dave, chain, view, keys1 } = setup()
    const before = encryptChannelMessage(alice, view, keyring(alice, view, keys1).get(1)!, { text: 'old news' }, HERE)
    const add = signChannelChange(bob, view, chain, 'add', [key(dave)])
    const v2 = verifyChannelChain(chain, [add], view)
    const keys2 = sealEpochKey(bob, v2, newEpochKey(), devices(alice, bob, dave))
    const daveRing = keyring(dave, v2, [...keys1, ...keys2])
    expect([...daveRing.keys()]).toEqual([2])
    expect(() => decryptChannelMessage(before, route(before), v2, (v) => daveRing.get(v))).toThrow(MissingKeyError)
    const after = encryptChannelMessage(alice, v2, keyring(alice, v2, keys2).get(2)!, { text: 'welcome' }, HERE)
    expect(decryptChannelMessage(after, route(after), v2, (v) => daveRing.get(v)).text).toBe('welcome')
  })

  it('asks to catch up on a version this device has not verified yet', () => {
    const { alice, bob, chain, view, keys1 } = setup()
    const v2 = verifyChannelChain(chain, [signChannelChange(bob, view, chain, 'rekey', [])], view)
    const keys2 = sealEpochKey(bob, v2, newEpochKey(), devices(alice, bob))
    const env = encryptChannelMessage(alice, v2, keyring(alice, v2, keys2).get(2)!, { text: 'new' }, HERE)
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

/** A message in the older format (v1), as apps sent it before messages were bound to their channel. */
function legacyMessage(by: Identity, view: ChannelView, epochKey: Uint8Array, text: string, now = Date.now()): ChannelEnvelope {
  const header = { from: key(by), chain: view.chain, version: view.version, sentAt: now, id: b64u(randomBytes(12)) }
  const ad = channelMessageAd(1, header, view.head)
  const nonce = randomBytes(24)
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(new TextEncoder().encode(JSON.stringify({ text })), ad, null, nonce, epochKey)
  const sig = sign(channelMessageSigned(1, ad, nonce, ct), by.device.secretKey)
  return { v: 1, kind: 'channel', header, sender: by.cert, nonce: b64u(nonce), ct: b64u(ct), sig: b64u(sig) }
}

describe('messages are bound to where they were sent (v2)', () => {
  const PARENT = { channel: 7 }
  const THREAD = { channel: 7, thread: 9 }

  it('opens where it was sent, and refuses it moved to another channel or thread', () => {
    const { alice, bob, view, keys1 } = setup()
    const ring = keyring(alice, view, keys1)
    const inParent = encryptChannelMessage(bob, view, keyring(bob, view, keys1).get(1)!, { text: 'parent' }, PARENT)
    const inThread = encryptChannelMessage(bob, view, keyring(bob, view, keys1).get(1)!, { text: 'thread' }, THREAD)
    expect(inParent.v).toBe(2)
    const opened = decryptChannelMessage(inParent, route(inParent, PARENT), view, (v) => ring.get(v))
    expect(opened.text).toBe('parent')
    expect(opened.legacy).toBe(false)
    expect(decryptChannelMessage(inThread, route(inThread, THREAD), view, (v) => ring.get(v)).text).toBe('thread')
    // Parent into a thread, a thread into its parent or another thread, another channel altogether.
    expect(() => decryptChannelMessage(inParent, route(inParent, THREAD), view, (v) => ring.get(v))).toThrow(MOVED)
    expect(() => decryptChannelMessage(inThread, route(inThread, PARENT), view, (v) => ring.get(v))).toThrow(MOVED)
    expect(() => decryptChannelMessage(inThread, route(inThread, { channel: 7, thread: 10 }), view, (v) => ring.get(v))).toThrow(MOVED)
    expect(() => decryptChannelMessage(inParent, route(inParent, { channel: 8 }), view, (v) => ring.get(v))).toThrow(MOVED)
  })

  it('catches a server that rewrites the place, the edit link or the format', () => {
    const { alice, bob, view, keys1 } = setup()
    const ring = keyring(alice, view, keys1)
    const env = encryptChannelMessage(bob, view, keyring(bob, view, keys1).get(1)!, { text: 'hi' }, THREAD, Date.now(), 'AAECAwQFBgcICQoL')
    const tampered = (header: Partial<ChannelEnvelope['header']>) => ({ ...env, header: { ...env.header, ...header } }) as ChannelEnvelope
    // Rewriting the header to fit where it was moved breaks the signature.
    expect(() => decryptChannelMessage(tampered({ thread: undefined }), route(env, PARENT), view, (v) => ring.get(v))).toThrow(/tampered/)
    expect(() => decryptChannelMessage(tampered({ thread: 10 }), route(env, { channel: 7, thread: 10 }), view, (v) => ring.get(v))).toThrow(/tampered/)
    expect(() => decryptChannelMessage(tampered({ edit: 'DA0ODxAREhMUFRYX' }), route(env, THREAD), view, (v) => ring.get(v))).toThrow(/tampered/)
    expect(() => decryptChannelMessage(tampered({ edit: undefined }), route(env, THREAD), view, (v) => ring.get(v))).toThrow(/tampered/)
    // Passing a v2 message off as the older format (which isn't bound) fails too: the context differs.
    expect(() => decryptChannelMessage({ ...env, v: 1 }, route(env, PARENT), view, (v) => ring.get(v))).toThrow(/tampered/)
    expect(() => decryptChannelMessage({ ...env, v: 3 as never }, route(env, THREAD), view, (v) => ring.get(v))).toThrow(/format/)
  })

  it('still opens older (v1) messages, marked as such', () => {
    const { alice, bob, view, keys1 } = setup()
    const ring = keyring(alice, view, keys1)
    const old = legacyMessage(bob, view, keyring(bob, view, keys1).get(1)!, 'from an older app')
    const opened = decryptChannelMessage(old, route(old, THREAD), view, (v) => ring.get(v))
    expect(opened.text).toBe('from an older app')
    expect(opened.legacy).toBe(true)
    // A v1 signature never passes as v2.
    expect(() => decryptChannelMessage({ ...old, v: 2, header: { ...old.header, channel: 7 } }, route(old, PARENT), view, (v) => ring.get(v))).toThrow(/tampered/)
  })
})

describe('a removed member’s messages (security review L12)', () => {
  const T = 1_800_000_000_000
  /** Carol was removed at T (Bob's signed change); she still holds epoch 1's key and her device key. */
  function removed() {
    const w = setup()
    const v2 = verifyChannelChain(w.chain, [signChannelChange(w.bob, w.view, w.chain, 'remove', [key(w.carol)], T)], w.view)
    const carolKey = keyring(w.carol, w.view, w.keys1).get(1)!
    const aliceRing = keyring(w.alice, w.view, w.keys1)
    return { ...w, v2, carolKey, open: (e: ChannelEnvelope, at?: number) => decryptChannelMessage(e, { ...route(e), at }, v2, (v) => aliceRing.get(v)) }
  }

  it('shows what she wrote while she was in as hers', () => {
    const { view, carol, carolKey, open } = removed()
    const before = encryptChannelMessage(carol, view, carolKey, { text: 'still here' }, HERE, T - 60_000)
    const opened = open(before, T - 59_000)
    expect(opened.text).toBe('still here')
    expect(opened.afterRemoval).toBeUndefined()
    // Clocks a little apart are fine.
    expect(open(encryptChannelMessage(carol, view, carolKey, { text: 'x' }, HERE, T + CLOCK_SKEW_MS - 1), T).afterRemoval).toBeUndefined()
  })

  it('flags a message that claims a time after her removal, by her clock or the server’s', () => {
    const { view, carol, carolKey, open } = removed()
    const later = encryptChannelMessage(carol, view, carolKey, { text: 'I never left' }, HERE, T + 3_600_000)
    expect(open(later, T + 3_600_000).afterRemoval).toBe(T)
    // Backdated by her, but the server stored it after she was out.
    const backdated = encryptChannelMessage(carol, view, carolKey, { text: 'from before, honest' }, HERE, T - 60_000)
    expect(open(backdated, T + 3_600_000).afterRemoval).toBe(T)
    // Older format too.
    expect(open(legacyMessage(carol, view, carolKey, 'old app', T + 3_600_000), T + 3_600_000).afterRemoval).toBe(T)
  })

  it('keeps flagging her old epoch after she is added back (new messages go to the new epoch)', () => {
    const { alice, bob, carol, chain, v2, carolKey, keys1, view } = removed()
    const v3 = verifyChannelChain(chain, [signChannelChange(alice, v2, chain, 'add', [key(carol)], T + 7_200_000)], v2)
    const ring = keyring(alice, view, keys1)
    const forged = encryptChannelMessage(carol, view, carolKey, { text: 'old key, new time' }, HERE, T + 8_000_000)
    expect(decryptChannelMessage(forged, { ...route(forged), at: T + 8_000_000 }, v3, (v) => ring.get(v)).afterRemoval).toBe(T)
    // Bob, never removed, is fine at any time.
    const bobs = encryptChannelMessage(bob, view, keyring(bob, view, keys1).get(1)!, { text: 'hi' }, HERE, T + 1_000)
    expect(decryptChannelMessage(bobs, { ...route(bobs), at: T + 1_000 }, v3, (v) => ring.get(v)).afterRemoval).toBeUndefined()
  })

  it('reads the end of membership from the verified chain, or the end of a kept chain', () => {
    const { v2, carol, bob } = removed()
    expect(accessEnd(v2, key(carol), 1)).toBe(T)
    expect(accessEnd(v2, key(bob), 1)).toBeNull()
    expect(accessEnd(v2, key(bob), 1, T + 5)).toBe(T + 5)
    expect(accessEnd(v2, key(carol), 1, T + 5)).toBe(T)
  })
})

describe('shared test vectors: channel messages', () => {
  const c = vectors.channel
  const accountKey = vectors.v1.accountKey
  const chain = c.messages[0].envelope.header.chain
  const view: ChannelView = {
    chain, version: 3, head: c.head, members: [accountKey],
    changes: [{ v: 1, group: chain, version: 3, prev: '', by: accountKey, action: 'rekey', targets: [], members: [accountKey], at: 0, head: c.head }],
  }
  it('builds the same associated data and opens every vector where it was sent', () => {
    for (const m of c.messages) {
      const env = m.envelope as ChannelEnvelope
      expect(b64u(channelMessageAd(env.v, env.header, c.head))).toBe(m.ad)
      const opened = decryptChannelMessage(env, { from: accountKey, version: 3, ...m.place }, view, () => fromB64u(c.epochKey))
      expect(opened.text).toBe(c.text)
      expect(opened.legacy).toBe(env.v === 1)
    }
    const bound = c.messages[2].envelope as ChannelEnvelope
    expect(() => decryptChannelMessage(bound, { from: accountKey, version: 3, channel: 42 }, view, () => fromB64u(c.epochKey))).toThrow(MOVED)
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
