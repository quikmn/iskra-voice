import { beforeAll, describe, expect, it } from 'vitest'
import { b64u, ready } from './crypto'
import {
  currentPrekey, generatePrekey, PREKEY_GRACE_MS, PREKEY_ROTATE_MS, revokedSet, rotatePrekeys, signPrekey, signRevocation,
  usablePrekeys, verifyPrekey, verifyRevocation,
} from './devices'
import { createIdentity } from './identity'

beforeAll(ready)

describe('device revocations', () => {
  it('are signed by the account and bound to the device and time', () => {
    const alice = createIdentity()
    const phone = createIdentity().cert.deviceKey
    const r = signRevocation(alice, phone, 1_760_000_000_000)
    const account = b64u(alice.account.publicKey)
    expect(verifyRevocation(account, r)).toBe(true)
    expect(verifyRevocation(account, { ...r, revokedAt: r.revokedAt + 1 })).toBe(false)
    expect(verifyRevocation(account, { ...r, deviceKey: alice.cert.deviceKey })).toBe(false)
    expect(verifyRevocation(b64u(createIdentity().account.publicKey), r)).toBe(false)
    expect(verifyRevocation(account, { ...r, sig: 'garbage' })).toBe(false)
  })

  it('only counts revocations the account really signed', () => {
    const alice = createIdentity()
    const mallory = createIdentity()
    const real = signRevocation(alice, 'A'.repeat(43))
    const fake = signRevocation(mallory, alice.cert.deviceKey)
    expect([...revokedSet(b64u(alice.account.publicKey), [real, fake])]).toEqual([real.deviceKey])
  })
})

describe('prekeys', () => {
  it('are signed by the device key', () => {
    const id = createIdentity()
    const signed = signPrekey(id, generatePrekey())
    expect(signed.deviceKey).toBe(id.cert.deviceKey)
    expect(verifyPrekey(signed)).toBe(true)
    expect(verifyPrekey({ ...signed, created: signed.created + 1 })).toBe(false)
    expect(verifyPrekey({ ...signed, deviceKey: createIdentity().cert.deviceKey })).toBe(false)
  })

  it('rotate weekly and delete retired secrets after the grace period', () => {
    const t0 = 1_760_000_000_000
    const first = rotatePrekeys([], t0)
    expect(first.changed).toBe(true)
    expect(first.prekeys).toHaveLength(1)

    expect(rotatePrekeys(first.prekeys, t0 + PREKEY_ROTATE_MS - 1).changed).toBe(false)

    const week = rotatePrekeys(first.prekeys, t0 + PREKEY_ROTATE_MS)
    expect(week.prekeys).toHaveLength(2)
    expect(week.prekeys[0].retiredAt).toBe(t0 + PREKEY_ROTATE_MS)
    expect(currentPrekey(week.prekeys)!.created).toBe(t0 + PREKEY_ROTATE_MS)

    // A day after the grace period, the first prekey's secret is gone (and zeroed).
    const later = rotatePrekeys(week.prekeys, t0 + PREKEY_ROTATE_MS + PREKEY_GRACE_MS + 1)
    expect(later.prekeys.map((p) => p.created)).not.toContain(t0)
    expect(week.prekeys[0].secretKey.every((b) => b === 0)).toBe(true)
  })

  it('senders pick the newest valid prekey per device', () => {
    const id = createIdentity()
    const now = Date.now()
    const older = signPrekey(id, generatePrekey(now - 1000))
    const newer = signPrekey(id, generatePrekey(now))
    const forged = { ...signPrekey(createIdentity(), generatePrekey(now + 5)), deviceKey: id.cert.deviceKey }
    const usable = usablePrekeys([older, forged, newer], now)
    expect(usable.get(id.cert.deviceKey)!.key).toBe(newer.key)
  })
})
