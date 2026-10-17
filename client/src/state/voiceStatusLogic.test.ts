import { describe, expect, it } from 'vitest'
import type { Channel, Member, ServerRole } from '../core/protocol'
import { checkStatusText, mayClearAsModerator, maySetStatus, statusLength, VOICE_STATUS_MAX } from './voiceStatusLogic'

const member = (role: Member['role'], roles: number[] = []) => ({ accountKey: 'me', name: 'Me', role, roles }) as unknown as Member
const voice = (patch: Partial<Channel> = {}) => ({ id: 1, name: 'lounge', kind: 'voice', readRole: 'member', writeRole: 'member', ...patch }) as Channel
const role = (id: number, permissions: string[] = []) => ({ id, name: `r${id}`, position: id, permissions }) as unknown as ServerRole

describe('voice status text', () => {
  it('counts an emoji once', () => {
    expect(statusLength('CS2 ranked 🔫')).toBe(12)
    expect(statusLength('👨‍👩‍👧‍👦🇸🇪')).toBe(2)
  })

  it('trims, clears when empty, and refuses long or hidden text', () => {
    expect(checkStatusText('  movie night ')).toEqual({ ok: true, text: 'movie night' })
    expect(checkStatusText('   ')).toEqual({ ok: true, text: null })
    expect(checkStatusText('a'.repeat(VOICE_STATUS_MAX))).toMatchObject({ ok: true })
    expect(checkStatusText('🔫'.repeat(VOICE_STATUS_MAX))).toMatchObject({ ok: true })
    expect(checkStatusText('a'.repeat(VOICE_STATUS_MAX + 1))).toEqual({ ok: false, reason: 'tooLong' })
    expect(checkStatusText('two\nlines')).toEqual({ ok: false, reason: 'invalid' })
    expect(checkStatusText('hid​den')).toEqual({ ok: false, reason: 'invalid' })
    expect(checkStatusText('👨‍👩‍👧')).toMatchObject({ ok: true }) // the emoji joiner is fine
  })
})

describe('who may set or clear it', () => {
  it('people in the call who may speak, unless a role is denied it', () => {
    expect(maySetStatus(member('member'), voice(), [], true)).toBe(true)
    expect(maySetStatus(member('member'), voice(), [], false)).toBe(false)
    expect(maySetStatus(member('member'), voice({ writeRole: 'trusted' }), [], true)).toBe(false)
    expect(maySetStatus(member('member'), voice({ kind: 'stage' }), [], true)).toBe(false)
    const denied = voice({ overrides: [{ roleId: 5, allow: [], deny: ['setVoiceStatus'] }] })
    expect(maySetStatus(member('member', [5]), denied, [role(5)], true)).toBe(false)
    const allowed = voice({ writeRole: 'trusted', overrides: [{ roleId: 5, allow: ['setVoiceStatus'], deny: [] }] })
    expect(maySetStatus(member('member', [5]), allowed, [role(5)], true)).toBe(true)
  })

  it('voice moderators clear it from anywhere', () => {
    expect(mayClearAsModerator(member('member'), [])).toBe(false)
    expect(mayClearAsModerator(member('member', [2]), [role(2, ['muteMembers'])])).toBe(true)
    expect(mayClearAsModerator(member('admin'), [])).toBe(true)
  })
})
