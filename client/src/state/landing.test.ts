import { describe, expect, it } from 'vitest'
import type { Invite } from '../core/protocol'
import { landingInviteChoices, landingUrl } from './landing'

const invite = (patch: Partial<Invite>): Invite => ({
  code: 'abcdefgh12345678', role: 'member', createdBy: 'k', createdAt: 0, expiresAt: null, maxUses: null, uses: 0, ...patch,
})

describe('landingInviteChoices', () => {
  it('offers only working invites for members or guests', () => {
    const now = 1_000
    const ok = invite({ code: 'ok' })
    const guest = invite({ code: 'guest', role: 'guest' })
    const later = invite({ code: 'later', expiresAt: now + 1 })
    const roomLeft = invite({ code: 'room', maxUses: 3, uses: 2 })
    const all = [
      ok, guest, later, roomLeft,
      invite({ code: 'admin', role: 'admin' }),
      invite({ code: 'trusted', role: 'trusted' }),
      invite({ code: 'expired', expiresAt: now }),
      invite({ code: 'full', maxUses: 2, uses: 2 }),
    ]
    expect(landingInviteChoices(all, now).map((i) => i.code)).toEqual(['ok', 'guest', 'later', 'room'])
  })
})

describe('landingUrl', () => {
  it('prefers the public address and ends with a slash', () => {
    expect(landingUrl({ publicUrl: 'https://crew.example/', directUrl: 'http://192.168.1.2:47070' })).toBe('https://crew.example/')
    expect(landingUrl({ publicUrl: null, directUrl: 'http://192.168.1.2:47070' })).toBe('http://192.168.1.2:47070/')
  })
})
