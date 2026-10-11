import { beforeAll, describe, expect, it } from 'vitest'
import { ready } from './crypto'
import { browserWrapper, isSealed, lockDataKey, newDataKey, openValue, sealValue, unlockDataKey } from './vault'

beforeAll(ready)

const CHEAP = { opslimit: 1, memlimit: 8192 } // tests only; the app uses DEFAULT_LOCK

describe('encryption at rest', () => {
  it('seals values so only the same key and slot open them', () => {
    const key = newDataKey()
    const sealed = sealValue(key, 'identity', { secret: 'abc', n: 1 })
    expect(isSealed(sealed)).toBe(true)
    expect(JSON.stringify(sealed)).not.toContain('abc')
    expect(openValue(key, 'identity', sealed)).toEqual({ secret: 'abc', n: 1 })
    // Moved to another slot, or another device's key: refused.
    expect(() => openValue(key, 'prekeys', sealed)).toThrow()
    expect(() => openValue(newDataKey(), 'identity', sealed)).toThrow()
    expect(isSealed({ accountSecret: 'plain, from before' })).toBe(false)
  })

  it('locks the data key with a passphrase', () => {
    const key = newDataKey()
    const { box, params } = lockDataKey(key, 'correct horse battery', CHEAP)
    expect(unlockDataKey(box, 'correct horse battery', params)).toEqual(key)
    expect(unlockDataKey(box, 'wrong', params)).toBeNull()
    // A fresh salt every time.
    expect(lockDataKey(key, 'correct horse battery', CHEAP).params.salt).not.toBe(params.salt)
  })

  it('wraps with a non-extractable browser key', async () => {
    let stored: CryptoKey | undefined
    const wrapper = browserWrapper(async () => stored, async (k) => { stored = k })
    const key = newDataKey()
    const wrapped = await wrapper.wrap(key)
    expect(stored?.extractable).toBe(false)
    await expect(crypto.subtle.exportKey('raw', stored!)).rejects.toThrow()
    expect(await wrapper.unwrap(wrapped)).toEqual(key)
    // Without that key (another browser profile), the wrapped data key is useless.
    const elsewhere = browserWrapper(async () => undefined, async () => undefined)
    await expect(elsewhere.unwrap(wrapped)).rejects.toThrow()
  })
})
