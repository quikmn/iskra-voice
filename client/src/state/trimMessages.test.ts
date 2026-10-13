import { describe, expect, it } from 'vitest'
import type { PendingMessage, ServerState } from './store'
import { trimChannel, trimMessages, useApp } from './store'

const msg = (id: number, tempId?: string): PendingMessage =>
  ({ id, channelId: 1, author: 'bob', text: 't', createdAt: id * 1000, editedAt: null, attachments: [], replyTo: null, reactions: [], ...(tempId ? { tempId } : {}) })
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => msg(from + i))

describe('trimming a busy channel', () => {
  it('keeps the newest messages once there are too many, and pending ones always', () => {
    expect(trimMessages(range(1, 10), 5, 10)).toBeNull()
    const trimmed = trimMessages([...range(1, 11), msg(0, 'tmp1')], 5, 10)!
    expect(trimmed.map((m) => m.id)).toEqual([7, 8, 9, 10, 11, 0])
    expect(trimmed.at(-1)?.tempId).toBe('tmp1')
  })

  it('says there is more to load, and leaves a channel showing older history alone', () => {
    const server = (detached: boolean) => ({
      key: 's', messages: { 1: range(1, 700) }, hasMore: { 1: false }, detached: detached ? { 1: true } : undefined,
    }) as unknown as ServerState
    useApp.setState({ servers: { s: server(false) } })
    trimChannel('s', 1)
    expect(useApp.getState().servers.s.messages[1]).toHaveLength(300)
    expect(useApp.getState().servers.s.messages[1][0].id).toBe(401)
    expect(useApp.getState().servers.s.hasMore[1]).toBe(true)

    useApp.setState({ servers: { s: server(true) } })
    trimChannel('s', 1)
    expect(useApp.getState().servers.s.messages[1]).toHaveLength(700)
  })
})
