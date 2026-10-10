import { beforeAll, describe, expect, it } from 'vitest'
import { ready } from './crypto'
import { createIdentity, verifyDeviceCert } from './identity'
import { accountKeyOf, decodeRecoveryKey, encodeRecoveryKey, restoreIdentity, seedOf } from './recovery'

beforeAll(ready)

describe('recovery keys', () => {
  it('restore the same account with a new device', () => {
    const original = createIdentity()
    const key = encodeRecoveryKey(seedOf(original))
    expect(key).toMatch(/^ISKRA(-[0-9A-HJKMNP-TV-Z]{4})+$/)

    const restored = restoreIdentity(decodeRecoveryKey(key)!)
    expect(accountKeyOf(restored)).toBe(accountKeyOf(original))
    expect(restored.cert.deviceKey).not.toBe(original.cert.deviceKey)
    expect(verifyDeviceCert(restored.cert)).toBe(true)
  })

  it('forgives formatting and look-alike characters', () => {
    const seed = seedOf(createIdentity())
    const key = encodeRecoveryKey(seed)
    const messy = `  ${key.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l')}\n`
    expect(decodeRecoveryKey(messy)).toEqual(seed)
  })

  it('catches typos instead of restoring a different account', () => {
    const key = encodeRecoveryKey(seedOf(createIdentity()))
    const chars = key.split('')
    const i = 10
    chars[i] = chars[i] === 'A' ? 'B' : 'A'
    expect(decodeRecoveryKey(chars.join(''))).toBeNull()
    expect(decodeRecoveryKey(key.slice(0, -4))).toBeNull()
    expect(decodeRecoveryKey('hello')).toBeNull()
    expect(decodeRecoveryKey('')).toBeNull()
  })
})
