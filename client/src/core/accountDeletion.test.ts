import { beforeAll, describe, expect, it } from 'vitest'
import { ready } from './crypto'
import { createIdentity } from './identity'
import { signDeletion, verifyDeletion } from './accountDeletion'

beforeAll(ready)

describe('account deletion', () => {
  it('verifies only for the account that signed it, with the choice it signed', () => {
    const me = createIdentity()
    const other = createIdentity()
    const deletion = signDeletion(me, true, 1_760_000_000_000)
    expect(verifyDeletion(deletion.accountKey, deletion)).toBe(true)
    expect(verifyDeletion(signDeletion(other, true).accountKey, deletion)).toBe(false)
    expect(verifyDeletion(deletion.accountKey, { ...deletion, messages: false })).toBe(false)
    expect(verifyDeletion(deletion.accountKey, { ...deletion, deletedAt: deletion.deletedAt + 1 })).toBe(false)
    expect(verifyDeletion(deletion.accountKey, { ...deletion, sig: 'AAAA' })).toBe(false)
    expect(verifyDeletion(deletion.accountKey, null)).toBe(false)
  })
})
