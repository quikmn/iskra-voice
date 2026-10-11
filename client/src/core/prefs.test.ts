import { beforeAll, describe, expect, it } from 'vitest'
import { generateSigningKeyPair, ready } from './crypto'
import { openPrefs, prefsKey, sealPrefs } from './prefs'

beforeAll(ready)

describe('synced prefs', () => {
  it('round-trips only for the same account and setting name', () => {
    const account = generateSigningKeyPair()
    const key = prefsKey(account.secretKey)
    const sealed = sealPrefs(key, 'rail', '{"items":[]}')
    expect(openPrefs(prefsKey(account.secretKey), 'rail', sealed)).toBe('{"items":[]}')
    expect(openPrefs(key, 'other', sealed)).toBeNull()
    expect(openPrefs(prefsKey(generateSigningKeyPair().secretKey), 'rail', sealed)).toBeNull()
    expect(openPrefs(key, 'rail', 'garbage')).toBeNull()
    expect(sealPrefs(key, 'rail', 'x')).not.toBe(sealPrefs(key, 'rail', 'x')) // fresh nonce each time
  })
})
