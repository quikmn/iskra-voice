import { describe, expect, it } from 'vitest'
import type { PendingMessage } from '../../state/store'
import { relativeTime, withPinNotes } from './pinThreadHelpers'

const message = (id: number, createdAt: number, tempId?: string): PendingMessage => ({
  id, channelId: 1, author: 'a', text: `m${id}`, createdAt, editedAt: null, attachments: [], replyTo: null, reactions: [], tempId,
})
const rows = (...list: PendingMessage[]) => list.map((m) => ({ message: m, grouped: false }))

describe('pin notes in the timeline', () => {
  it('go after the last message sent before them', () => {
    const items = withPinNotes(rows(message(1, 100), message(2, 200), message(3, 300)), [
      { messageId: 1, by: 'b', at: 250 },
      { messageId: 2, by: 'b', at: 400 },
    ])
    expect(items.map((i) => (i.note ? `note:${i.note.messageId}` : i.message.id))).toEqual([1, 2, 'note:1', 3, 'note:2'])
  })

  it('stay above messages still being sent and drop ones older than what is loaded', () => {
    const items = withPinNotes(rows(message(5, 500), message(Number.MAX_SAFE_INTEGER, 50, 't1')), [
      { messageId: 5, by: 'b', at: 10 },
      { messageId: 5, by: 'b', at: 600 },
    ])
    expect(items.map((i) => (i.note ? 'note' : i.message.text))).toEqual(['m5', 'note', `m${Number.MAX_SAFE_INTEGER}`])
  })

  it('leave the list alone without notes', () => {
    const list = rows(message(1, 1))
    expect(withPinNotes(list, undefined)).toBe(list)
  })
})

describe('relative time', () => {
  it('reads naturally', () => {
    const now = 1_000_000_000
    expect(relativeTime(now - 10_000, now)).toBe('just now')
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5m ago')
    expect(relativeTime(now - 3 * 3600_000, now)).toBe('3h ago')
  })
})
