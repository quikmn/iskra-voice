import { beforeAll, describe, expect, it } from 'vitest'
import { b64u, generateSigningKeyPair, ready, signingKeyPairFromSeed, fromB64u } from './crypto'
import { decryptDm, encryptDm, safetyNumber } from './dm'
import { certifyDevice, createIdentity, verifyDeviceCert, type Identity } from './identity'
import {
  chainFrom, chainTo, KeyMap, openHandover, prepareRotation, sealHandover, signRotation, verifyRotation, type Rotation,
} from './rotation'
import vectors from '../../../protocol/vectors.json'

beforeAll(ready)

const key = (id: Identity) => b64u(id.account.publicKey)

function secondDevice(id: Identity): Identity {
  const device = generateSigningKeyPair()
  return { account: id.account, device, cert: certifyDevice(id.account, device.publicKey, Date.now()) }
}

describe('account key rotation', () => {
  it('matches the shared test vector', () => {
    const v = vectors.rotation
    const account = signingKeyPairFromSeed(fromB64u(vectors.v1.accountSeed))
    const next = signingKeyPairFromSeed(fromB64u(v.newSeed))
    expect(signRotation(account, next, v.rotation.rotatedAt)).toEqual(v.rotation)
    expect(verifyRotation(v.rotation)).toBe(true)
  })

  it('needs both signatures over the same statement', () => {
    const a = generateSigningKeyPair()
    const b = generateSigningKeyPair()
    const r = signRotation(a, b, 1_760_000_000_000)
    expect(verifyRotation(r)).toBe(true)
    expect(verifyRotation({ ...r, rotatedAt: r.rotatedAt + 1 })).toBe(false)
    expect(verifyRotation({ ...r, newSig: r.oldSig })).toBe(false)
    expect(verifyRotation({ ...r, newKey: b64u(generateSigningKeyPair().publicKey) })).toBe(false)
    expect(verifyRotation({ ...r, newKey: r.oldKey })).toBe(false)
    expect(verifyRotation({ ...r, oldSig: 'nope' })).toBe(false)
    expect(verifyRotation(null)).toBe(false)
  })

  it('follows chains and treats every key in one as the same person', () => {
    const [k0, k1, k2, other] = [generateSigningKeyPair(), generateSigningKeyPair(), generateSigningKeyPair(), generateSigningKeyPair()]
    const r1 = signRotation(k0, k1)
    const r2 = signRotation(k1, k2)
    const keys = new KeyMap([r2, r1])
    const [a, b, c] = [b64u(k0.publicKey), b64u(k1.publicKey), b64u(k2.publicKey)]
    expect(keys.resolve(a)).toBe(c)
    expect(keys.same(a, c)).toBe(true)
    expect(keys.same(a, b64u(other.publicKey))).toBe(false)
    expect(new Set(keys.aliases(b))).toEqual(new Set([a, b, c]))
    expect(chainFrom(a, [r2, r1])).toEqual([r1, r2])
    expect(chainTo(c, [r1, r2])).toEqual([r1, r2])
    // First claim on an old key wins; a second one is ignored (that's a dispute, not a rotation).
    expect(keys.add(signRotation(k0, other))).toBe(false)
    expect(keys.resolve(a)).toBe(c)
    // Forged rotations never count.
    expect(new KeyMap([{ ...signRotation(other, k0), newSig: r1.newSig }]).resolve(b64u(other.publicKey))).toBe(b64u(other.publicKey))
  })

  it('re-certifies kept devices and hands each the new key', () => {
    const laptop = createIdentity()
    const phone = secondDevice(laptop)
    const lost = secondDevice(laptop)
    const { identity, rotation, certs, handovers } = prepareRotation(laptop, [phone.cert])

    expect(verifyRotation(rotation)).toBe(true)
    expect(rotation.oldKey).toBe(key(laptop))
    expect(rotation.newKey).toBe(key(identity))
    expect(certs.map((c) => c.deviceKey).sort()).toEqual([laptop.cert.deviceKey, phone.cert.deviceKey].sort())
    expect(certs.every((c) => c.accountKey === rotation.newKey && verifyDeviceCert(c))).toBe(true)
    expect(identity.device).toBe(laptop.device) // same device key: prekeys keep working
    expect(handovers.map((h) => h.device)).toEqual([phone.cert.deviceKey])

    const opened = openHandover(phone, handovers[0].seal, [rotation])
    expect(opened && b64u(opened.account.publicKey)).toBe(rotation.newKey)
    expect(opened?.account.secretKey).toEqual(identity.account.secretKey)
    // A device that wasn't carried over can't open it.
    expect(openHandover(lost, handovers[0].seal, [rotation])).toBeNull()
  })

  it("refuses a hand-over whose key isn't the signed new key (a server swapping it)", () => {
    const laptop = createIdentity()
    const phone = secondDevice(laptop)
    const { rotation } = prepareRotation(laptop, [phone.cert])
    const impostor = generateSigningKeyPair()
    const swapped = sealHandover(impostor.secretKey.slice(0, 32), phone.cert.deviceKey)
    expect(openHandover(phone, swapped.seal, [rotation])).toBeNull()
    // Nor a rotation of someone else's key.
    const stranger = createIdentity()
    const theirs = prepareRotation(stranger, [])
    const sealed = sealHandover(theirs.identity.account.secretKey.slice(0, 32), phone.cert.deviceKey)
    expect(openHandover(phone, sealed.seal, [theirs.rotation])).toBeNull()
  })

  it('old DMs still open after either side rotated, and the safety number changes', () => {
    const alice = createIdentity()
    const bob = createIdentity()
    const env = encryptDm(alice, key(bob), [bob.cert], [], { text: 'before' })
    const next = prepareRotation(bob, [])
    const keys = new KeyMap([next.rotation])
    // The server re-routed the stored envelope to Bob's new key; the signed header still says the old one.
    expect(() => decryptDm(next.identity, env, key(alice), key(next.identity))).toThrow()
    expect(decryptDm(next.identity, env, key(alice), key(next.identity), (a, b) => keys.same(a, b)).text).toBe('before')
    // An unrelated key is still refused.
    const other: Rotation = prepareRotation(createIdentity(), []).rotation
    const unrelated = new KeyMap([other])
    expect(() => decryptDm(next.identity, env, key(alice), key(next.identity), (a, b) => unrelated.same(a, b))).toThrow()
    expect(safetyNumber(key(alice), key(bob))).not.toBe(safetyNumber(key(alice), key(next.identity)))
  })
})
