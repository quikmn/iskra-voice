import { describe, expect, it } from 'vitest'
import { cleanForward } from '../core/dm'
import { dmForward, forwardLabel } from './forward'
import type { ServerState } from './store'
import type { Channel, Member, Message } from '../core/protocol'

const member = (accountKey: string, role: Member['role'], name = accountKey): Member => ({ accountKey, name, role, online: true })
const channel = (id: number, name: string, readRole: Channel['readRole']): Channel => ({ id, name, kind: 'text', position: id, readRole, writeRole: readRole })
const P = 'p'.repeat(43)
const M = 'm'.repeat(43)

describe('forwarding to a DM', () => {
  const server = {
    key: 's', url: 'http://localhost:1', publicUrl: 'https://iskra.example', name: 'Gaming',
    channels: [channel(1, 'general', 'member'), channel(2, 'staff', 'admin')],
    members: { [P]: member(P, 'member', 'Pat'), [M]: member(M, 'member', 'Mo') },
  } as unknown as ServerState

  it('names the channel only when the recipient can read it', () => {
    expect(forwardLabel(server, server.channels[0], server.members[P])).toBe('#general on Gaming')
    expect(forwardLabel(server, server.channels[1], server.members[P])).toBeNull()
    expect(forwardLabel(server, server.channels[0], undefined)).toBeNull()
  })

  it('carries files as links and mentions as names', () => {
    const message: Message = {
      id: 9, channelId: 2, author: 'x', text: `hi <@${M}>`, createdAt: 1, editedAt: null, replyTo: null, reactions: [],
      attachments: [{ id: 'f', name: 'a.png', size: 5, type: 'image/png', width: 1, height: 1, url: '/files/f/a.png' }],
    }
    const { text, forward } = dmForward(server, message, P)
    expect(text).toBe('hi @Mo')
    expect(forward).toEqual({ from: null, files: [{ name: 'a.png', url: 'https://iskra.example/files/f/a.png', size: 5, type: 'image/png' }] })
  })

  it('accepts only clean forwards from other devices', () => {
    expect(cleanForward({ from: '#x', files: [{ name: 'a', url: 'https://h/f', size: 1, type: 'x' }] })).not.toBeNull()
    expect(cleanForward({ from: null, files: [{ name: 'a', url: 'javascript:alert(1)', size: 1, type: 'x' }] })).toBeNull()
    expect(cleanForward({ from: 5, files: [] })).toBeNull()
    expect(cleanForward({ from: null, files: new Array(11).fill({ name: 'a', url: 'https://h', size: 1, type: 'x' }) })).toBeNull()
    expect(cleanForward('nope')).toBeNull()
  })
})
