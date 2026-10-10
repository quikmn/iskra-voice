import { beforeAll, describe, expect, it } from 'vitest'
import { b64u, generateSigningKeyPair, ready } from './crypto'
import { decryptDm, encryptDm, safetyNumber, type DmEnvelope } from './dm'
import { certifyDevice, createIdentity, type Identity } from './identity'

beforeAll(ready)

const key = (id: Identity) => b64u(id.account.publicKey)

/** A second device of the same account. */
function secondDevice(id: Identity): Identity {
  const device = generateSigningKeyPair()
  return { account: id.account, device, cert: certifyDevice(id.account, device.publicKey, Date.now()) }
}

describe('direct message encryption', () => {
  it('carries a call payload next to the fallback text', () => {
    const alice = createIdentity()
    const bob = createIdentity()
    const call = { kind: 'invite', id: 'abc', key: 'k', video: true }
    const env = encryptDm(alice, key(bob), [bob.cert], [], { text: 'Incoming video call', call })
    const opened = decryptDm(bob, env, key(alice), key(bob))
    expect(opened.text).toBe('Incoming video call')
    expect(opened.call).toEqual(call)
    expect(decryptDm(bob, encryptDm(alice, key(bob), [bob.cert], [], { text: 'plain' }), key(alice), key(bob)).call).toBeUndefined()
  })

  it('the recipient can read it', () => {
    const alice = createIdentity()
    const bob = createIdentity()
    const env = encryptDm(alice, key(bob), [bob.cert], [], { text: 'hi bob 👋' })
    expect(decryptDm(bob, env, key(alice), key(bob)).text).toBe('hi bob 👋')
  })

  it('the sender (and their other devices) can read it too', () => {
    const alice = createIdentity()
    const alicePhone = secondDevice(alice)
    const bob = createIdentity()
    const env = encryptDm(alice, key(bob), [bob.cert], [alicePhone.cert], { text: 'synced' })
    expect(decryptDm(alice, env, key(alice), key(bob)).text).toBe('synced')
    expect(decryptDm(alicePhone, env, key(alice), key(bob)).text).toBe('synced')
  })

  it('every device of the recipient can read it', () => {
    const alice = createIdentity()
    const bob = createIdentity()
    const bobPhone = secondDevice(bob)
    const env = encryptDm(alice, key(bob), [bob.cert, bobPhone.cert], [], { text: 'both' })
    expect(decryptDm(bobPhone, env, key(alice), key(bob)).text).toBe('both')
  })

  it('nobody else can, not even with the envelope', () => {
    const alice = createIdentity()
    const bob = createIdentity()
    const eve = createIdentity()
    const env = encryptDm(alice, key(bob), [bob.cert], [], { text: 'secret' })
    expect(() => decryptDm(eve, env, key(alice), key(bob))).toThrow(/isn't for you/)
    // Even if the server routed it to Eve, there is no key slot for her device.
    const rerouted = { ...env, header: { ...env.header, to: key(eve) } }
    expect(() => decryptDm(eve, rerouted, key(alice), key(eve))).toThrow()
  })

  it('refuses devices whose certificate is fake (a server cannot add its own device)', () => {
    const alice = createIdentity()
    const bob = createIdentity()
    const mallory = createIdentity()
    const fakeBobDevice = { ...mallory.cert, accountKey: key(bob) } // claims to be Bob's, signed by Mallory
    expect(() => encryptDm(alice, key(bob), [fakeBobDevice], [], { text: 'x' })).toThrow(/devices/)
    const env = encryptDm(alice, key(bob), [bob.cert, fakeBobDevice], [], { text: 'x' })
    expect(env.keys.map((k) => k.device)).not.toContain(mallory.cert.deviceKey)
  })

  it('never falls back to plaintext', () => {
    const alice = createIdentity()
    const bob = createIdentity()
    expect(() => encryptDm(alice, key(bob), [], [], { text: 'x' })).toThrow()
    const env = encryptDm(alice, key(bob), [bob.cert], [], { text: 'plaintext?' })
    expect(JSON.stringify(env)).not.toContain('plaintext?')
  })

  it('detects tampering with the header, ciphertext or sender', () => {
    const alice = createIdentity()
    const bob = createIdentity()
    const mallory = createIdentity()
    const env = encryptDm(alice, key(bob), [bob.cert], [], { text: 'original' })

    const later: DmEnvelope = { ...env, header: { ...env.header, sentAt: env.header.sentAt + 1 } }
    expect(() => decryptDm(bob, later, key(alice), key(bob))).toThrow(/tampered/)

    const flipped = env.ct.startsWith('A') ? 'B' + env.ct.slice(1) : 'A' + env.ct.slice(1)
    expect(() => decryptDm(bob, { ...env, ct: flipped }, key(alice), key(bob))).toThrow()

    // The server claiming it's from someone else.
    expect(() => decryptDm(bob, env, key(mallory), key(bob))).toThrow(/doesn't match/)

    // Swapping in another sender device: the box was made by Alice's device, so it won't open.
    const swapped = { ...env, sender: mallory.cert, header: { ...env.header } }
    expect(() => decryptDm(bob, swapped, key(alice), key(bob))).toThrow()
  })

  it('safety numbers match on both sides and differ between pairs', () => {
    const a = key(createIdentity())
    const b = key(createIdentity())
    const c = key(createIdentity())
    expect(safetyNumber(a, b)).toBe(safetyNumber(b, a))
    expect(safetyNumber(a, b)).not.toBe(safetyNumber(a, c))
    expect(safetyNumber(a, b)).toMatch(/^(\d{5} ){11}\d{5}$/)
  })
})
