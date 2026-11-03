// Security review R3-2: whether a board is encrypted comes from its channel as this device knows it, never from the
// server's wb.get, and plaintext ops, snapshots and cursors are refused on an encrypted board.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, Requests } from '../core/protocol'
import { en } from '../i18n/en'
import { applyChannels, serverEventForTests, setConnectionForTests, useApp, type ServerState } from './store'
import { boardKey, boardSession, change, closeBoard, openBoard, useWhiteboard } from './whiteboard'

vi.mock('../core/storage', async (original) => ({
  ...(await original<typeof import('../core/storage')>()),
  loadE2ee: async () => undefined,
  saveE2ee: async () => undefined,
  deleteE2ee: async () => undefined,
}))

type GetReply = Requests['wb.get'][1]
const RECT = { kind: 'rect', x: 0, y: 0, w: 10, h: 10, size: 2 } as const
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('an encrypted channel’s board', () => {
  const sent: [string, Record<string, unknown>][] = []
  let reply: GetReply
  const channel = { id: 3, name: 'board', kind: 'whiteboard', position: 0, readRole: 'member', writeRole: 'member', createdAt: 5, e2ee: { chain: 'c', version: 1 } } as unknown as Channel
  const board = (encrypted: boolean) => ({ channelId: 3, id: 'b1', seq: 0, openedBy: null, openedAt: 1, encrypted })

  beforeEach(() => {
    sent.length = 0
    const server = { key: 'srv', name: 'S', status: { state: 'online' }, me: null, members: {}, channels: [], messages: {}, hasMore: {}, typing: {}, voice: {} } as unknown as ServerState
    useApp.setState({ servers: { srv: server }, activeServer: 'srv' })
    applyChannels('srv', [channel])
    setConnectionForTests('srv', {
      isOnline: true,
      request: (async (type: string, body: Record<string, unknown>) => {
        sent.push([type, body])
        if (type === 'wb.get') return reply
        return {}
      }) as never,
    })
  })

  it('the server saying it isn’t encrypted: nothing is sent, the board shows why', async () => {
    reply = { board: board(false), snapshot: null, batches: [], hasMore: false, viewers: [], wantSnapshot: false }
    const s = openBoard('srv', 3)
    await settle()
    expect(s.encrypted).toBe(true)
    expect(useWhiteboard.getState().boards[boardKey('srv', 3)]).toMatchObject({ status: 'error', error: en.e2ee.errors.boardMismatch })
    change(s, [{ id: 'abcdefgh1', p: RECT }])
    await new Promise((r) => setTimeout(r, 450)) // two send ticks
    expect(sent.filter(([type]) => type === 'wb.update' || type === 'wb.live')).toEqual([])
    closeBoard('srv', 3)
    await settle()
  })

  it('plaintext ops, snapshots and cursors on it change nothing and count as unreadable', async () => {
    reply = {
      board: board(true),
      snapshot: { seq: 1, at: 1, objects: { abcdefgh2: RECT } },
      batches: [{ seq: 2, by: 'x', at: 2, ops: [{ id: 'abcdefgh3', p: RECT }] }],
      hasMore: false, viewers: [], wantSnapshot: false,
    }
    const s = openBoard('srv', 3)
    await settle()
    expect(boardSession('srv', 3)).toBe(s)
    expect(s.state.confirmedObjects()).toEqual({})
    expect(s.unreadable).toBe(2)
    serverEventForTests('srv', 'wb.batch', { channelId: 3, boardId: 'b1', batch: { seq: 3, by: 'x', at: 3, ops: [{ id: 'abcdefgh4', p: RECT }] } })
    serverEventForTests('srv', 'wb.live', { channelId: 3, boardId: 'b1', accountKey: 'x', live: { x: 1, y: 2 } })
    await settle()
    expect(s.state.confirmedObjects()).toEqual({})
    expect(s.cursors.size).toBe(0)
    expect(s.unreadable).toBe(3)
    closeBoard('srv', 3)
    await settle()
  })
})
