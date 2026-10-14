import { describe, expect, it } from 'vitest'
import type { AuditEntry } from '../core/protocol'
import {
  auditText, blockChange, blockedKeys, countdown, mergeBlocks, sameBlocks, slowmodeLabel, slowmodeWait, SLOWMODE_STEPS, timeoutActive,
} from './moderationRules'

describe('block lists', () => {
  it('keeps the newest change per person, a block winning a tie', () => {
    const merged = mergeBlocks(
      [{ accountKey: 'a', blocked: true, at: 10 }, { accountKey: 'b', blocked: true, at: 10 }, { accountKey: 'c', blocked: false, at: 5 }],
      [{ accountKey: 'a', blocked: false, at: 20 }, { accountKey: 'b', blocked: false, at: 10 }, { accountKey: 'c', blocked: true, at: 5 }],
    )
    expect(Object.fromEntries(merged.map((e) => [e.accountKey, e.blocked]))).toEqual({ a: false, b: true, c: true })
    expect(blockedKeys(merged).sort()).toEqual(['b', 'c'])
  })

  it('is the same whichever side merges first', () => {
    const local = [{ accountKey: 'a', blocked: true, at: 1 }, { accountKey: 'b', blocked: false, at: 7 }]
    const remote = [{ accountKey: 'a', blocked: false, at: 3 }, { accountKey: 'c', blocked: true, at: 2 }]
    expect(sameBlocks(mergeBlocks(local, remote), mergeBlocks(remote, local))).toBe(true)
    expect(sameBlocks(mergeBlocks(local, remote), local)).toBe(false)
  })

  it('makes each change newer than the last one, even with a clock that is behind', () => {
    const entries = [{ accountKey: 'a', blocked: true, at: 5_000 }]
    const next = blockChange(entries, 'a', false, 1_000)
    expect(next).toEqual([{ accountKey: 'a', blocked: false, at: 5_001 }])
    expect(blockChange(next, 'b', true, 9_000).find((e) => e.accountKey === 'b')).toEqual({ accountKey: 'b', blocked: true, at: 9_000 })
  })
})

describe('timeouts and slowmode', () => {
  it('knows when a timeout is running', () => {
    expect(timeoutActive({ timedOutUntil: 2_000 }, 1_000)).toBe(true)
    expect(timeoutActive({ timedOutUntil: 1_000 }, 1_000)).toBe(false)
    expect(timeoutActive({ timedOutUntil: null }, 1_000)).toBe(false)
    expect(timeoutActive(null)).toBe(false)
  })

  it('counts down slowmode from your last message', () => {
    expect(slowmodeWait(10, 1_000, 4_000)).toBe(7_000)
    expect(slowmodeWait(10, 1_000, 11_000)).toBe(0)
    expect(slowmodeWait(0, 1_000, 2_000)).toBe(0)
    expect(slowmodeWait(10, undefined, 2_000)).toBe(0)
    expect(countdown(7_000)).toBe('0:07')
    expect(countdown(299_500)).toBe('5:00')
    expect(countdown(3_723_000)).toBe('1:02:03')
  })

  it('labels the slowmode steps the server accepts', () => {
    expect(SLOWMODE_STEPS.map(slowmodeLabel)).toEqual(
      ['Off', '5 s', '10 s', '15 s', '30 s', '1 min', '2 min', '5 min', '10 min', '15 min', '30 min', '1 h', '2 h', '6 h'])
  })
})

describe('audit log', () => {
  const entry = (action: string, details: AuditEntry['details'] = null, extra: Partial<AuditEntry> = {}): AuditEntry => ({
    id: 1, at: 0, action, actor: 'k1', actorName: 'Viktor', target: 'k2', targetName: 'Sam', reason: null, details, ...extra,
  })

  it('describes entries in plain words', () => {
    expect(auditText(entry('member.timeout', { durationMs: 3_600_000 }))).toBe('Viktor timed out Sam for 1 hour')
    expect(auditText(entry('member.role', { from: 'member', to: 'trusted' }))).toBe("Viktor changed Sam's role from member to trusted")
    expect(auditText(entry('channel.update', { name: 'general', changes: { slowmode: { from: 0, to: 30 } } })))
      .toBe('Viktor edited #general: slowmode off → 30 s')
    expect(auditText(entry('message.delete', { channelName: 'general' }, { target: null, targetName: null })))
      .toBe('Viktor deleted a message by a webhook or former member in #general')
    expect(auditText(entry('server.pages', { enabled: false }, { target: null, targetName: null }))).toBe('Viktor turned profile pages off')
    expect(auditText(entry('something.new'))).toBe('Viktor: something.new')
    expect(auditText(entry('invite.create', { role: 'member', maxUses: null, expiresAt: null }))).toBe('Viktor created an invite that never expires (member)')
    expect(auditText(entry('invite.create', { role: 'member', maxUses: null, expiresAt: 5 }))).toBe('Viktor created an invite (member)')
  })
})
