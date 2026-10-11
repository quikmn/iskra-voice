import { describe, expect, it } from 'vitest'
import { callMove, nativeVoiceInfo } from './nativeCallLogic'

const SERVER = 'S'.repeat(43)
const ALEX = 'A'.repeat(43)
const GROUP = 'g'.repeat(22)
const KEY = `${SERVER}/${GROUP}`

describe('the phone in voice', () => {
  it('names the voice channel, DM call or group call', () => {
    const base = { serverKey: SERVER, channelId: 7, state: 'connected' as const, canSpeak: true }
    expect(nativeVoiceInfo(base, { channel: 'lounge' })).toEqual({ title: 'In voice: lounge', call: false })
    expect(nativeVoiceInfo({ ...base, channelId: 0, call: { id: 'c', peer: ALEX } }, { peer: 'Alex' })).toEqual({ title: 'Call with Alex', call: true })
    expect(nativeVoiceInfo({ ...base, channelId: 0, group: { key: KEY, callId: 'g1' } }, {})).toEqual({ title: 'Group call', call: true })
  })
})

describe('answering from the phone call screen', () => {
  const ringing = { phase: 'incoming', peer: ALEX, serverKey: SERVER }

  it('accepts or declines the DM call from that person once it rings here', () => {
    expect(callMove({ action: 'answer', server: SERVER, peer: ALEX }, null, ringing, null, {})).toBe('accept')
    expect(callMove({ action: 'decline', server: SERVER, peer: ALEX }, null, ringing, null, {})).toBe('decline')
    // Not here yet, someone else's call, or no longer ringing: wait.
    expect(callMove({ action: 'answer', server: SERVER, peer: ALEX }, null, null, null, {})).toBeNull()
    expect(callMove({ action: 'answer', server: SERVER, peer: 'B'.repeat(43) }, null, ringing, null, {})).toBeNull()
    expect(callMove({ action: 'answer', server: SERVER, peer: ALEX }, null, { ...ringing, phase: 'active' }, null, {})).toBeNull()
  })

  it('joins or declines a group call', () => {
    const action = { action: 'answer' as const, server: SERVER, group: GROUP }
    expect(callMove(action, KEY, null, { key: KEY }, {})).toBe('join-group')
    expect(callMove(action, KEY, null, null, { [KEY]: {} })).toBe('join-group') // stopped ringing but still on
    expect(callMove(action, KEY, null, null, {})).toBeNull()
    expect(callMove({ ...action, action: 'decline' }, KEY, null, { key: KEY }, {})).toBe('decline-group')
    expect(callMove({ ...action, action: 'decline' }, KEY, null, null, { [KEY]: {} })).toBeNull()
    expect(callMove(action, null, null, { key: KEY }, {})).toBeNull()
  })
})
