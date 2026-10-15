import { beforeAll, describe, expect, it } from 'vitest'
import { b64u, ready } from './crypto'
import { decryptChannelMessage, encryptChannelMessage, type ChannelEnvelope, type ChannelView } from './channelChain'
import { effectiveTimer, isExpiry, localExpiry } from './disappear'
import { decryptDm, encryptDm } from './dm'
import { decryptGroup, encryptGroup, newGroupId, signChange, verifyChain } from './group'
import { createIdentity, type Identity } from './identity'

beforeAll(ready)

const key = (id: Identity) => b64u(id.account.publicKey)
const T = 1_760_000_000_000

describe('when a message disappears on this device', () => {
  it('takes the sooner of the server and the signed header', () => {
    expect(localExpiry(T + 60_000, { sentAt: T, expires: 300 })).toBe(T + 60_000)
    // A server that stretches the time is held to what the sender signed.
    expect(localExpiry(T + 10 * 86_400_000, { sentAt: T, expires: 300 })).toBe(T + 300_000)
    expect(localExpiry(null, { sentAt: T, expires: 3600 })).toBe(T + 3_600_000)
    expect(localExpiry(T + 5, undefined)).toBe(T + 5)
    expect(localExpiry(null, { sentAt: T })).toBeUndefined()
  })

  it("can't be stretched by a sender's clock running ahead either", () => {
    expect(localExpiry(null, { sentAt: T + 86_400_000, expires: 300 }, T)).toBe(T + 300_000)
  })

  it('ignores expiries that are not one of the timers', () => {
    expect(isExpiry(300)).toBe(true)
    expect(isExpiry(0)).toBe(false)
    expect(isExpiry(42)).toBe(false)
    expect(localExpiry(null, { sentAt: T, expires: 42 })).toBeUndefined()
  })

  it('sends with the stricter of the servers and the signed change line', () => {
    expect(effectiveTimer([0, undefined], undefined)).toBe(0)
    expect(effectiveTimer([3600], undefined)).toBe(3600)
    // A server that turned it off quietly doesn't win over the line someone signed.
    expect(effectiveTimer([0], 86400)).toBe(86400)
    expect(effectiveTimer([300, 86400], 3600)).toBe(300)
    expect(effectiveTimer([0], 0)).toBe(0)
  })
})

describe('the expiry is bound to the message', () => {
  it('DMs: v3 carries it in the authenticated header; changing it breaks the message', () => {
    const alice = createIdentity()
    const bob = createIdentity()
    const env = encryptDm(alice, key(bob), [bob.cert], [], { text: 'gone soon' }, T, { prekeys: [], expires: 300 })
    expect(env.v).toBe(3)
    expect(env.header.expires).toBe(300)
    const opened = decryptDm(bob, env, key(alice), key(bob))
    expect(opened.text).toBe('gone soon')
    expect(opened.header.expires).toBe(300)

    // A server that stretches it, drops it, or passes it off as an older format: unreadable, never shown.
    expect(() => decryptDm(bob, { ...env, header: { ...env.header, expires: 2419200 } }, key(alice), key(bob))).toThrow()
    const { expires: _dropped, ...without } = env.header
    expect(() => decryptDm(bob, { ...env, header: without }, key(alice), key(bob))).toThrow('Unsupported message format.')
    expect(() => decryptDm(bob, { ...env, v: 2 }, key(alice), key(bob))).toThrow('Unsupported message format.')
    expect(() => encryptDm(alice, key(bob), [bob.cert], [], { text: 'x' }, T, { prekeys: [], expires: 42 })).toThrow()
    // Without a timer it stays the format older apps read.
    expect(encryptDm(alice, key(bob), [bob.cert], [], { text: 'kept' }, T, { prekeys: [] }).v).toBe(2)
  })

  it('a timer change line travels inside the encryption, with a fallback text', () => {
    const alice = createIdentity()
    const bob = createIdentity()
    const env = encryptDm(alice, key(bob), [bob.cert], [], { text: 'I set new messages to disappear', disappear: { seconds: 3600 } }, T, { prekeys: [] })
    expect(env.v).toBe(2) // older apps read the fallback
    expect(decryptDm(bob, env, key(alice), key(bob)).disappear).toEqual({ seconds: 3600 })
    const odd = encryptDm(alice, key(bob), [bob.cert], [], { text: 'x', disappear: { seconds: 7 } }, T, { prekeys: [] })
    expect(decryptDm(bob, odd, key(alice), key(bob)).disappear).toBeUndefined()
  })

  it('groups: v3 binds it the same way', () => {
    const alice = createIdentity()
    const bob = createIdentity()
    const carol = createIdentity()
    const id = newGroupId()
    const change = signChange(alice, null, id, 'create', [key(bob), key(carol)], T)
    const view = verifyChain(id, [change])
    const bundles = [bob, carol].map((p) => ({ accountKey: key(p), devices: [p.cert] }))
    const env = encryptGroup(alice, view, bundles, { text: 'brb' }, T, { prekeys: [], expires: 28800 })
    expect(env.v).toBe(3)
    const routed = { group: id, from: key(alice), version: 1 }
    expect(decryptGroup(bob, env, routed, view).header.expires).toBe(28800)
    expect(() => decryptGroup(bob, { ...env, header: { ...env.header, expires: 604800 } }, routed, view)).toThrow()
    expect(() => decryptGroup(bob, { ...env, v: 2 }, routed, view)).toThrow()
  })

  it('encrypted channels: v3 signs it with its own context', () => {
    const alice = createIdentity()
    const chain = b64u(new Uint8Array(16).fill(1))
    const view: ChannelView = {
      chain, version: 1, head: 'h', members: [key(alice)],
      changes: [{ v: 1, group: chain, version: 1, prev: '', by: key(alice), action: 'create', targets: [], members: [key(alice)], at: T, head: 'h' }],
    }
    const epoch = new Uint8Array(32).fill(9)
    const env = encryptChannelMessage(alice, view, epoch, { text: 'psst' }, { channel: 5 }, T, undefined, 300)
    expect(env.v).toBe(3)
    const routed = { from: key(alice), version: 1, channel: 5 }
    const opened = decryptChannelMessage(env, routed, view, () => epoch)
    expect(opened.text).toBe('psst')
    expect(opened.header.expires).toBe(300)
    const stretched: ChannelEnvelope = { ...env, header: { ...env.header, expires: 2419200 } }
    expect(() => decryptChannelMessage(stretched, routed, view, () => epoch)).toThrow('This message was tampered with.')
    const downgraded: ChannelEnvelope = { ...env, v: 2 }
    expect(() => decryptChannelMessage(downgraded, routed, view, () => epoch)).toThrow('Unsupported message format.')
    expect(encryptChannelMessage(alice, view, epoch, { text: 'x' }, { channel: 5 }, T).v).toBe(2)
  })
})
