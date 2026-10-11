import { beforeAll, describe, expect, it } from 'vitest'
import { generateSigningKeyPair, ready } from './crypto'
import { prefsKey } from './prefs'
import { openPrivate, privateKey, sealPrivate } from './sealed'

beforeAll(ready)

describe('private records', () => {
  it('open only for the same account and purpose', () => {
    const account = generateSigningKeyPair()
    const key = privateKey(account.secretKey)
    const sealed = sealPrivate(key, 'reminder', { note: 'call mum' })
    expect(openPrivate(privateKey(account.secretKey), 'reminder', sealed)).toEqual({ note: 'call mum' })
    expect(openPrivate(key, 'other', sealed)).toBeNull()
    expect(openPrivate(privateKey(generateSigningKeyPair().secretKey), 'reminder', sealed)).toBeNull()
    expect(openPrivate(key, 'reminder', 'garbage')).toBeNull()
    expect(sealPrivate(key, 'reminder', 1)).not.toBe(sealPrivate(key, 'reminder', 1))
  })

  it('use a different key than synced prefs', () => {
    const account = generateSigningKeyPair()
    expect(privateKey(account.secretKey)).not.toEqual(prefsKey(account.secretKey))
  })
})
