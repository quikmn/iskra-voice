import { describe, expect, it } from 'vitest'
import type { Channel, Member } from '../core/protocol'
import {
  callPlace, clipFileName, clipsOnIn, clipTime, encodeClipData, flagToSend, parseClipData, parseClipSettings,
} from './clipsLogic'
import { canSendIn, channelAccess } from './permissions'

describe('clip settings', () => {
  it('are off by default, 30 s, and clamp what was stored', () => {
    expect(parseClipSettings(null)).toEqual({ enabled: false, seconds: 30 })
    expect(parseClipSettings('{"enabled":true,"seconds":300}')).toEqual({ enabled: true, seconds: 120 })
    expect(parseClipSettings('{"enabled":"yes","seconds":5}')).toEqual({ enabled: false, seconds: 15 })
    expect(parseClipSettings('not json')).toEqual({ enabled: false, seconds: 30 })
  })
})

describe('the call data channel', () => {
  it('round-trips the two messages and ignores anything else', () => {
    expect(parseClipData(encodeClipData({ clips: true }))).toEqual({ clips: true })
    expect(parseClipData(encodeClipData({ clips: false }))).toEqual({ clips: false })
    expect(parseClipData(encodeClipData({ saved: true }))).toEqual({ saved: true })
    const bytes = (o: unknown) => new TextEncoder().encode(JSON.stringify(o))
    expect(parseClipData(bytes({ v: 2, clips: true }))).toBeNull()
    expect(parseClipData(bytes({ v: 1, clips: 'yes' }))).toBeNull()
    expect(parseClipData(bytes({ v: 1, saved: false }))).toBeNull()
    expect(parseClipData(new TextEncoder().encode('{'))).toBeNull()
    expect(parseClipData(new Uint8Array(1000))).toBeNull()
  })
})

describe('who has clips on', () => {
  const channel = callPlace({ serverKey: 's', channelId: 7 })
  const dm = callPlace({ serverKey: 's', channelId: 0, call: { peer: 'bob' } })

  it('knows where the call is', () => {
    expect(channel).toEqual({ kind: 'channel', serverKey: 's', channelId: 7 })
    expect(dm).toEqual({ kind: 'dm', serverKey: 's', peer: 'bob' })
    expect(callPlace({ serverKey: 's', channelId: 0, group: { key: 'g' } })).toEqual({ kind: 'group', serverKey: 's', groupKey: 'g' })
  })

  it('reads channels from the server and calls from the room, with your own setting for you', () => {
    const participants = [{ accountKey: 'me', muted: false, deafened: false, clips: false }, { accountKey: 'alex', muted: false, deafened: false, clips: true }]
    expect(clipsOnIn(channel, participants, { bob: true }, 'me', false)).toEqual(['alex'])
    // Your own mark shows at once, before the server echoes it.
    expect(clipsOnIn(channel, participants, {}, 'me', true)).toEqual(['alex', 'me'])
    expect(clipsOnIn(dm, participants, { bob: true }, 'me', false)).toEqual(['bob'])
    expect(clipsOnIn(dm, [], {}, 'me', true)).toEqual(['me'])
  })

  it('sends the flag only once the server lists us with the other value', () => {
    const me = (clips?: boolean) => [{ accountKey: 'me', muted: false, deafened: false, clips }]
    expect(flagToSend([], 'me', true)).toBe(false) // not in the channel yet (LiveKit's webhook hasn't arrived)
    expect(flagToSend(me(false), 'me', true)).toBe(true)
    expect(flagToSend(me(undefined), 'me', true)).toBe(true)
    expect(flagToSend(me(true), 'me', true)).toBe(false)
    expect(flagToSend(me(true), 'me', false)).toBe(true)
    expect(flagToSend(me(false), null, true)).toBe(false)
  })
})

describe('clip files', () => {
  it('are named by local time and timed as m:ss', () => {
    expect(clipFileName(new Date(2026, 9, 11, 9, 5, 3))).toBe('iskra-clip-2026-10-11-090503.webm')
    expect([clipTime(0), clipTime(7_400), clipTime(90_000), clipTime(-5)]).toEqual(['0:00', '0:07', '1:30', '0:00'])
  })
})

describe('voice channel chat permissions', () => {
  const member = (role: Member['role'], roles: number[] = []) => ({ accountKey: 'k', name: 'n', role, online: true, roles }) as Member
  const voice = (writeRole: Channel['writeRole'], overrides: Channel['overrides'] = []) =>
    ({ id: 1, name: 'lounge', kind: 'voice', position: 0, readRole: 'member', writeRole, overrides }) as Channel

  it('posting follows send, not speak', () => {
    expect(canSendIn(member('member'), voice('member'), [])).toBe(true)
    expect(canSendIn(member('member'), voice('trusted'), [])).toBe(false)
    const roles = [{ id: 1, name: 'quiet', color: null, position: 1, permissions: [], hoist: false, mentionable: false }]
    // A role that may talk but not type.
    const mutedChat = voice('member', [{ roleId: 1, allow: [], deny: ['send'] }])
    expect(channelAccess(member('member', [1]), mutedChat, roles as never).has('speak')).toBe(true)
    expect(canSendIn(member('member', [1]), mutedChat, roles as never)).toBe(false)
  })
})
