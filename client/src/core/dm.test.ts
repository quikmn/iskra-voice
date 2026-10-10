import { beforeAll, describe, expect, it } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'
import { b64u, fromB64u, generateSigningKeyPair, ready } from './crypto'
import {
  generatePrekey, PREKEY_GRACE_MS, PREKEY_MAX_AGE_MS, PREKEY_ROTATE_MS, rotatePrekeys, signPrekey, type SignedPrekey,
} from './devices'
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

describe('forward-secret envelopes (v2)', () => {
  /** A device with a fresh prekey, as it would publish it. */
  function withPrekey(id: Identity, now = Date.now()): { id: Identity; signed: SignedPrekey } {
    const pair = generatePrekey(now)
    const withKeys = { ...id, prekeys: [pair] }
    return { id: withKeys, signed: signPrekey(withKeys, pair) }
  }

  it('wraps to prekeys, and both sides read it', () => {
    const alice = withPrekey(createIdentity())
    const bob = withPrekey(createIdentity())
    const env = encryptDm(alice.id, key(bob.id), [bob.id.cert], [], { text: 'hello v2' }, Date.now(), { prekeys: [bob.signed] })
    expect(env.v).toBe(2)
    expect(env.keys.every((k) => 'seal' in k)).toBe(true) // Bob's device and Alice's own
    expect(decryptDm(bob.id, env, key(alice.id), key(bob.id)).text).toBe('hello v2')
    expect(decryptDm(alice.id, env, key(alice.id), key(bob.id)).text).toBe('hello v2')
  })

  it('once the prekey is deleted, even the long-term keys cannot read captured messages', () => {
    const alice = withPrekey(createIdentity())
    const bob = withPrekey(createIdentity())
    const env = encryptDm(alice.id, key(bob.id), [bob.id.cert], [], { text: 'gone later' }, Date.now(), { prekeys: [bob.signed] })

    // Bob's prekey rotates and the old secret is deleted after the grace period.
    const later = Date.now() + PREKEY_ROTATE_MS + PREKEY_GRACE_MS + 60_000
    const rotated = rotatePrekeys(rotatePrekeys(bob.id.prekeys!, Date.now() + PREKEY_ROTATE_MS).prekeys, later).prekeys
    const bobLater = { ...bob.id, prekeys: rotated }
    expect(() => decryptDm(bobLater, env, key(alice.id), key(bob.id))).toThrow(/deleted/)

    // An attacker holding both devices' long-term secrets can't open the slot either:
    // the static key alone opens neither the seal nor the inner box.
    const slot = env.keys.find((k) => k.device === bob.id.cert.deviceKey) as { seal: string }
    const bobStatic = sodium.crypto_sign_ed25519_sk_to_curve25519(bob.id.device.secretKey)
    const bobStaticPublic = sodium.crypto_sign_ed25519_pk_to_curve25519(bob.id.device.publicKey)
    expect(() => sodium.crypto_box_seal_open(fromB64u(slot.seal), bobStaticPublic, bobStatic)).toThrow()
    const aliceStatic = sodium.crypto_sign_ed25519_sk_to_curve25519(alice.id.device.secretKey)
    expect(() => sodium.crypto_box_seal_open(fromB64u(slot.seal), bobStaticPublic, aliceStatic)).toThrow()
  })

  it('still reads messages wrapped to a retired prekey during the grace period', () => {
    const alice = withPrekey(createIdentity())
    const bob = withPrekey(createIdentity())
    const env = encryptDm(alice.id, key(bob.id), [bob.id.cert], [], { text: 'in flight' }, Date.now(), { prekeys: [bob.signed] })
    const rotated = rotatePrekeys(bob.id.prekeys!, Date.now() + PREKEY_ROTATE_MS).prekeys
    expect(rotated).toHaveLength(2)
    expect(decryptDm({ ...bob.id, prekeys: rotated }, env, key(alice.id), key(bob.id)).text).toBe('in flight')
  })

  it('falls back to the device key for devices without a usable prekey, and ignores forged prekeys', () => {
    const alice = withPrekey(createIdentity())
    const bob = createIdentity()
    const mallory = withPrekey(createIdentity())
    // Mallory's prekey relabelled as Bob's: the signature doesn't match Bob's device key.
    const forged = { ...mallory.signed, deviceKey: bob.cert.deviceKey }
    const env = encryptDm(alice.id, key(bob), [bob.cert], [], { text: 'static' }, Date.now(), { prekeys: [forged] })
    const slot = env.keys.find((k) => k.device === bob.cert.deviceKey)!
    expect('box' in slot).toBe(true)
    expect(decryptDm(bob, env, key(alice.id), key(bob)).text).toBe('static')
  })

  it('ignores stale prekeys', () => {
    const alice = withPrekey(createIdentity())
    const old = Date.now() - PREKEY_MAX_AGE_MS - 1000
    const bob = withPrekey(createIdentity(), old)
    const env = encryptDm(alice.id, key(bob.id), [bob.id.cert], [], { text: 'x' }, Date.now(), { prekeys: [bob.signed] })
    expect('box' in env.keys.find((k) => k.device === bob.id.cert.deviceKey)!).toBe(true)
  })

  it('gives revoked devices no slot', () => {
    const alice = withPrekey(createIdentity())
    const bob = createIdentity()
    const bobPhone = secondDevice(bob)
    const env = encryptDm(alice.id, key(bob), [bob.cert, bobPhone.cert], [], { text: 'x' }, Date.now(), {
      prekeys: [], revokedDevices: [bobPhone.cert.deviceKey],
    })
    expect(env.keys.map((k) => k.device)).not.toContain(bobPhone.cert.deviceKey)
    expect(() => decryptDm(bobPhone, env, key(alice.id), key(bob))).toThrow(/wasn't encrypted for this device/)
  })

  it('detects tampering and refuses a prekey slot inside a v1 envelope', () => {
    const alice = withPrekey(createIdentity())
    const bob = withPrekey(createIdentity())
    const env = encryptDm(alice.id, key(bob.id), [bob.id.cert], [], { text: 'x' }, Date.now(), { prekeys: [bob.signed] })
    expect(() => decryptDm(bob.id, { ...env, header: { ...env.header, sentAt: env.header.sentAt + 1 } }, key(alice.id), key(bob.id))).toThrow(/tampered/)
    expect(() => decryptDm(bob.id, { ...env, v: 1 }, key(alice.id), key(bob.id))).toThrow(/format/)
    // A slot sealed by someone else (not Alice's device) doesn't open: the inner box authenticates the sender.
    const mallory = withPrekey(createIdentity())
    const forged = encryptDm(mallory.id, key(bob.id), [bob.id.cert], [], { text: 'x' }, Date.now(), { prekeys: [bob.signed] })
    const swapped = { ...forged, sender: alice.id.cert, header: { ...forged.header, from: key(alice.id) } }
    expect(() => decryptDm(bob.id, swapped, key(alice.id), key(bob.id))).toThrow()
  })

  it('v1 envelopes still decrypt, and encryptDm without prekeys still makes v1', () => {
    const alice = createIdentity()
    const bob = withPrekey(createIdentity())
    const env = encryptDm(alice, key(bob.id), [bob.id.cert], [], { text: 'old style' })
    expect(env.v).toBe(1)
    expect(decryptDm(bob.id, env, key(alice), key(bob.id)).text).toBe('old style')
  })
})
