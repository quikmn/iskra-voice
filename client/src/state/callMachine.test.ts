import { describe, expect, it } from 'vitest'
import { asLog, callLog, callLogText, checkInvite, endMessage, formatDuration, isBusy, reduce, type CallInfo } from './callMachine'

const dial = (id = 'c1') => ({ type: 'dial' as const, id, peer: 'bob', serverKey: 's', video: false, at: 1000 })
const ring = (id = 'c2') => ({ type: 'ring' as const, id, peer: 'alice', serverKey: 's', video: true, at: 1000 })

describe('call state machine', () => {
  it('an outgoing call is answered, then hung up', () => {
    let call = reduce(null, dial())
    expect(call).toMatchObject({ phase: 'outgoing', direction: 'out', peer: 'bob' })
    call = reduce(call, { type: 'accepted', id: 'c1', at: 3000 })
    expect(call).toMatchObject({ phase: 'active', answeredAt: 3000 })
    call = reduce(call, { type: 'ended', id: 'c1', reason: 'ended', at: 63_000 })
    expect(call).toMatchObject({ phase: 'ended', endReason: 'ended' })
    expect(callLog(call!)).toEqual({ outcome: 'ended', duration: 60_000 })
    expect(reduce(call, { type: 'clear' })).toBeNull()
  })

  it('an unanswered call ends as "No answer" and is logged as missed', () => {
    const call = reduce(reduce(null, dial()), { type: 'ended', id: 'c1', reason: 'no_answer', at: 46_000 })!
    expect(endMessage(call)).toBe('No answer')
    expect(callLog(call)).toEqual({ outcome: 'missed' })
  })

  it('a declined call is logged as declined; failures are not logged', () => {
    const declined = reduce(reduce(null, dial()), { type: 'ended', id: 'c1', reason: 'declined', at: 2000 })!
    expect(callLog(declined)).toEqual({ outcome: 'declined' })
    const failed = reduce(reduce(null, dial()), { type: 'ended', id: 'c1', reason: 'failed', at: 2000, error: 'nope' })!
    expect(callLog(failed)).toBeNull()
    expect(endMessage(failed)).toBe('nope')
  })

  it('only the caller writes the call log', () => {
    const incoming = reduce(reduce(null, ring()), { type: 'ended', id: 'c2', reason: 'no_answer', at: 2000 })!
    expect(callLog(incoming)).toBeNull()
  })

  it('a second call while busy is ignored (and should be declined as busy)', () => {
    const active = reduce(reduce(null, dial()), { type: 'accepted', id: 'c1', at: 2000 })
    expect(isBusy(active)).toBe(true)
    expect(reduce(active, ring('c9'))).toBe(active)
    expect(reduce(active, dial('c9'))).toBe(active)
    expect(isBusy(reduce(active, { type: 'ended', id: 'c1', reason: 'ended', at: 3000 }))).toBe(false)
  })

  it('events for other calls, and late events, change nothing', () => {
    const outgoing = reduce(null, dial())
    expect(reduce(outgoing, { type: 'accepted', id: 'other', at: 2 })).toBe(outgoing)
    expect(reduce(outgoing, { type: 'ended', id: 'other', reason: 'ended', at: 2 })).toBe(outgoing)
    const ended = reduce(outgoing, { type: 'ended', id: 'c1', reason: 'cancelled', at: 2 })
    // The server's own call.ended arrives after we hung up locally: the first reason stays.
    expect(reduce(ended, { type: 'ended', id: 'c1', reason: 'ended', at: 3 })).toBe(ended)
    expect(reduce(ended, { type: 'accepted', id: 'c1', at: 3 })).toBe(ended)
    expect(reduce(outgoing, { type: 'clear' })).toBe(outgoing) // only ended calls are cleared
  })

  it('answered on another device ends the ringing here', () => {
    const call = reduce(reduce(null, ring()), { type: 'ended', id: 'c2', reason: 'answered_elsewhere', at: 2 }) as CallInfo
    expect(call.phase).toBe('ended')
    expect(callLog(call)).toBeNull()
  })
})

describe('call invites', () => {
  const key = 'A'.repeat(43)
  const invite = { kind: 'invite', id: 'c1', key, video: false }

  it('accepts a fresh invite for this call', () => {
    expect(checkInvite(invite, 'c1', false, 1000, 2000)).toEqual(invite)
  })

  it('rejects invites for another call, a different kind, bad keys or old ones', () => {
    expect(checkInvite(invite, 'c2', false, 1000, 2000)).toBeNull()
    expect(checkInvite(invite, 'c1', true, 1000, 2000)).toBeNull()
    expect(checkInvite({ ...invite, kind: 'log' }, 'c1', false, 1000, 2000)).toBeNull()
    expect(checkInvite({ ...invite, key: 'short' }, 'c1', false, 1000, 2000)).toBeNull()
    expect(checkInvite({ ...invite, key: '+'.repeat(43) }, 'c1', false, 1000, 2000)).toBeNull()
    expect(checkInvite(invite, 'c1', false, 1000, 1000 + 3 * 60_000)).toBeNull()
    expect(checkInvite(null, 'c1', false, 1000, 2000)).toBeNull()
  })
})

describe('call log entries', () => {
  it('reads well-formed entries only', () => {
    expect(asLog({ kind: 'log', id: 'x', video: true, outcome: 'ended', duration: 5000 })).toMatchObject({ outcome: 'ended', duration: 5000 })
    expect(asLog({ kind: 'log', id: 'x', video: true, outcome: 'hacked' })).toBeNull()
    expect(asLog({ kind: 'log', id: 'x', video: true, outcome: 'ended', duration: -1 })?.duration).toBeUndefined()
    expect(asLog('text')).toBeNull()
  })

  it('has readable fallback text', () => {
    expect(callLogText(false, 'missed')).toBe('Missed voice call')
    expect(callLogText(true, 'declined')).toBe('Declined video call')
    expect(callLogText(false, 'ended', 75_000)).toBe('Voice call · 1:15')
    expect(formatDuration(3_725_000)).toBe('1:02:05')
  })
})
