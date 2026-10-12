import { describe, expect, it } from 'vitest'
import { nativeVoiceInfo } from './nativeVoiceInfo'

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
