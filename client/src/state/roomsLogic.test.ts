import { describe, expect, it } from 'vitest'
import type { Channel, Member } from '../core/protocol'
import { canEnterRoom, hostedRoom, hostsRoom, isLobby, isRoom, roomSlug } from './roomsLogic'

const me = { accountKey: 'me', name: 'Me', role: 'member' } as Member
const room = (patch: Partial<NonNullable<Channel['room']>> = {}): Channel =>
  ({ id: 9, name: "alice's-room", kind: 'voice', position: 1, readRole: 'member', writeRole: 'member', room: { lobbyId: 3, host: 'alice', locked: false, invited: [], ...patch } }) as Channel

describe('voice rooms', () => {
  it('tells lobbies and rooms apart from plain voice channels', () => {
    expect(isLobby({ kind: 'voice', lobby: true })).toBe(true)
    expect(isLobby({ kind: 'voice' })).toBe(false)
    expect(isLobby({ kind: 'stage', lobby: true })).toBe(false)
    expect(isRoom(room())).toBe(true)
    expect(isRoom({ room: null })).toBe(false)
    expect(isRoom(undefined)).toBe(false)
  })

  it('lets the host and channel managers change a room', () => {
    expect(hostsRoom(room(), me, false)).toBe(false)
    expect(hostsRoom(room({ host: 'me' }), me, false)).toBe(true)
    expect(hostsRoom(room(), me, true)).toBe(true)
    expect(hostsRoom({ room: null }, me, true)).toBe(false)
    expect(hostsRoom(room({ host: 'me' }), null, false)).toBe(false)
  })

  it('keeps a locked room to the host, invited people and movers', () => {
    expect(canEnterRoom(room(), me, false)).toBe(true)
    expect(canEnterRoom(room({ locked: true }), me, false)).toBe(false)
    expect(canEnterRoom(room({ locked: true, invited: ['me'] }), me, false)).toBe(true)
    expect(canEnterRoom(room({ locked: true, host: 'me' }), me, false)).toBe(true)
    expect(canEnterRoom(room({ locked: true }), me, true)).toBe(true)
    expect(canEnterRoom(room({ locked: true }), null, false)).toBe(false)
  })

  it('finds the room you host from your voice session', () => {
    const channels = [room({ host: 'me' }), { ...room(), id: 10 } as Channel]
    expect(hostedRoom(channels, 9, me, false)?.id).toBe(9)
    expect(hostedRoom(channels, 10, me, false)).toBeNull()
    expect(hostedRoom(channels, 10, me, true)?.id).toBe(10)
    expect(hostedRoom(channels, undefined, me, true)).toBeNull()
  })

  it('previews room names the way the server keeps them', () => {
    expect(roomSlug('  Valheim  Build Night ')).toBe('valheim-build-night')
    expect(roomSlug('   ')).toBeNull()
    expect(roomSlug('x'.repeat(61))).toBeNull()
  })
})
