import { describe, expect, it } from 'vitest'
import type { Invite } from '../core/protocol'
import { LIFETIMES, NEVER, inviteRequest, lifetimeChoices, sortInvites } from './inviteRules'

const invite = (code: string, createdAt: number, expiresAt: number | null): Invite =>
  ({ code, role: 'member', createdBy: 'k', createdAt, expiresAt, maxUses: null, uses: 0 })

describe('invite options', () => {
  it('offers Never to admins only', () => {
    expect(lifetimeChoices(false)).toEqual(LIFETIMES)
    expect(lifetimeChoices(true).map((l) => l.ms)).toContain(NEVER)
    expect(lifetimeChoices(false).map((l) => l.ms)).not.toContain(NEVER)
  })

  it('asks for neverExpires instead of a lifetime, and keeps the use limit', () => {
    expect(inviteRequest(NEVER, true)).toEqual({ neverExpires: true, maxUses: 1 })
    expect(inviteRequest(NEVER, false)).toEqual({ neverExpires: true, maxUses: undefined })
    expect(inviteRequest(LIFETIMES[2].ms, false)).toEqual({ expiresInMs: 7 * 24 * 3600_000, maxUses: undefined })
  })

  it('lists never-expiring invites first, then newest', () => {
    const sorted = sortInvites([invite('a', 1, 100), invite('b', 3, 200), invite('c', 2, null)])
    expect(sorted.map((i) => i.code)).toEqual(['c', 'b', 'a'])
  })
})
