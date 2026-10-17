import { describe, expect, it } from 'vitest'
import type { AuditEntry, JoinedVia } from '../core/protocol'
import { inviteRequest } from './inviteRules'
import {
  SIGNING_MAX, inviteName, joinInvites, joinedViaText, newSigningSecret, signingSecretProblem, webhookFormatUrl,
} from './inviteTrackRules'
import { auditText } from './moderationRules'
import { CHANNEL_EVENTS, OUTHOOK_EVENTS, needsChannels } from './outhookRules'

const join = (accountKey: string, id: string, label: string | null, extra: Partial<JoinedVia> = {}): JoinedVia => ({
  accountKey, joinedAt: 1,
  invite: { id, label, createdBy: 'anna', createdByName: 'Anna (then)', role: 'member' },
  approvedBy: null, approvedByName: null, ...extra,
})

describe('invite tracking', () => {
  it('names an invite by its label, else the start of its id', () => {
    expect(inviteName({ id: 'abcdefghijk', label: 'Reddit post' })).toBe('“Reddit post”')
    expect(inviteName({ id: 'abcdefghijk', label: null })).toBe('invite abcdef')
  })

  it('says who made it and who let them in, with current names first', () => {
    const names: Record<string, string> = { anna: 'Anna', mod: 'Mo' }
    const nameOf = (k: string) => names[k]
    expect(joinedViaText(join('sam', 'i1', 'Reddit post'), nameOf)).toBe('Joined with “Reddit post” from Anna')
    expect(joinedViaText(join('sam', 'i1', null), () => undefined)).toBe('Joined with invite i1 from Anna (then)')
    expect(joinedViaText(join('sam', 'i1', 'Forum', { approvedBy: 'mod', approvedByName: 'Old' }), nameOf))
      .toBe('Joined with “Forum” from Anna, let in by Mo')
    const owner = join('o', 'i9', null)
    owner.invite.createdBy = 'server'
    expect(joinedViaText(owner, nameOf)).toBe('Joined with invite i9 from the setup link')
  })

  it('lists the invites people came through, most used first', () => {
    const list = joinInvites([join('a', 'x', 'Reddit'), join('b', 'y', null), join('c', 'y', null), join('d', 'z', 'Forum')])
    expect(list.map((i) => [i.invite.id, i.count])).toEqual([['y', 2], ['z', 1], ['x', 1]])
  })

  it('sends a label only when there is one', () => {
    expect(inviteRequest(3600_000, false, false, '  Reddit  ')).toEqual({ expiresInMs: 3600_000, maxUses: undefined, label: 'Reddit' })
    expect(inviteRequest(3600_000, true, true, ' ')).toEqual({ expiresInMs: 3600_000, maxUses: 1, approve: true })
  })

  it('describes a join in the activity log without the invite code', () => {
    const entry: AuditEntry = {
      id: 1, at: 0, action: 'member.join', actor: 'k', actorName: 'Sam', target: 'k', targetName: 'Sam', reason: null,
      details: { role: 'member', invite: { id: 'abcdefghijk', label: 'Reddit post', createdBy: 'anna' } },
    }
    expect(auditText(entry)).toBe('Sam joined with “Reddit post”')
    expect(auditText({ ...entry, details: { invite: { id: 'abcdefghijk', label: null } } })).toBe('Sam joined with invite abcdef')
  })
})

describe('incoming webhook formats', () => {
  it('adds the service suffix', () => {
    expect(webhookFormatUrl('https://x/hooks/a/b', 'discord')).toBe('https://x/hooks/a/b')
    expect(webhookFormatUrl('https://x/hooks/a/b', 'gitlab')).toBe('https://x/hooks/a/b/gitlab')
  })

  it('checks signing secrets like the server', () => {
    const secret = newSigningSecret()
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(newSigningSecret()).not.toBe(secret)
    expect(signingSecretProblem(secret)).toBeNull()
    expect(signingSecretProblem("It's a Secret to Everybody")).toBeNull()
    expect(signingSecretProblem('short')).toBe('length')
    expect(signingSecretProblem('x'.repeat(SIGNING_MAX + 1))).toBe('length')
    expect(signingSecretProblem(' leading-space-secret')).toBe('characters')
    expect(signingSecretProblem('tab\tinside-the-secret')).toBe('characters')
    expect(signingSecretProblem('åäö-not-ascii-secret')).toBe('characters')
  })
})

describe('more outgoing webhook events', () => {
  it('offers every event, and channel events need channels', () => {
    expect(OUTHOOK_EVENTS).toHaveLength(17)
    expect(new Set(OUTHOOK_EVENTS).size).toBe(17)
    for (const e of CHANNEL_EVENTS) expect(needsChannels([e])).toBe(true)
    expect(needsChannels(['member.updated', 'role.created', 'channel.deleted'])).toBe(false)
  })
})
