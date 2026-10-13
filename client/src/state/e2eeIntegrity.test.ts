import { describe, expect, it } from 'vitest'
import { MOVED } from '../core/channelChain'
import { checkSeen, noteSeen, REPLAYED, ROLLED_BACK, seenIndex, type Seen } from './e2eeIntegrity'

/** One device's memory of a channel's messages, fed envelopes the way decryptOne does. */
function device() {
  const messages = new Map<number, Seen & { id: number }>()
  const show = (messageId: number, header: { id: string; sentAt: number; edit?: string }, legacy = false): string | null => {
    const index = seenIndex(messages.values())
    const seen = messages.get(messageId)
    const problem = checkSeen(seen, (h) => index.get(h), messageId, header, legacy)
    if (!problem) messages.set(messageId, { id: messageId, ...noteSeen(seen, header, legacy) })
    return problem
  }
  return { show, messages }
}

describe('what a device remembers about encrypted messages (security review L13)', () => {
  it('takes a message, the same envelope again, and its edits in order', () => {
    const d = device()
    expect(d.show(1, { id: 'a', sentAt: 100 })).toBeNull()
    expect(d.show(1, { id: 'a', sentAt: 100 })).toBeNull()
    expect(d.show(1, { id: 'b', sentAt: 200, edit: 'a' })).toBeNull()
    expect(d.show(1, { id: 'c', sentAt: 300, edit: 'a' })).toBeNull()
    expect(d.show(1, { id: 'c', sentAt: 300, edit: 'a' })).toBeNull()
  })

  it('refuses an envelope replayed under another message id', () => {
    const d = device()
    expect(d.show(1, { id: 'a', sentAt: 100 })).toBeNull()
    expect(d.show(2, { id: 'a', sentAt: 100 })).toBe(REPLAYED)
    // Older-format envelopes are caught the same way.
    expect(d.show(3, { id: 'x', sentAt: 100 }, true)).toBeNull()
    expect(d.show(4, { id: 'x', sentAt: 100 }, true)).toBe(REPLAYED)
  })

  it('refuses an edit shown under a message it does not belong to', () => {
    const d = device()
    expect(d.show(1, { id: 'a', sentAt: 100 })).toBeNull()
    expect(d.show(2, { id: 'z', sentAt: 100 })).toBeNull()
    expect(d.show(2, { id: 'b', sentAt: 200, edit: 'a' })).toBe(MOVED)
    expect(d.show(2, { id: 'c', sentAt: 200, edit: 'q' })).toBe(MOVED)
    // An edit of 'a' seen first still claims 'a' for message 1 only.
    const e = device()
    expect(e.show(1, { id: 'b', sentAt: 200, edit: 'a' })).toBeNull()
    expect(e.show(2, { id: 'a', sentAt: 100 })).toBe(REPLAYED)
  })

  it('refuses an edited message rolled back to an older text', () => {
    const d = device()
    d.show(1, { id: 'a', sentAt: 100 })
    d.show(1, { id: 'b', sentAt: 200, edit: 'a' })
    expect(d.show(1, { id: 'a', sentAt: 100 })).toBe(ROLLED_BACK)
    // One this device never saw, but older than the newest: also refused.
    expect(d.show(1, { id: 'old-edit', sentAt: 150, edit: 'a' })).toBe(ROLLED_BACK)
    // The original after an edit, even if the author's clocks disagree.
    const e = device()
    e.show(1, { id: 'b', sentAt: 50, edit: 'a' })
    expect(e.show(1, { id: 'a', sentAt: 100 })).toBe(ROLLED_BACK)
  })

  it('keeps what it learnt in the local copy', () => {
    const d = device()
    d.show(1, { id: 'a', sentAt: 100 })
    d.show(1, { id: 'b', sentAt: 200, edit: 'a' })
    expect(d.messages.get(1)).toMatchObject({ hids: ['a', 'b'], origin: 'a', last: 'b', sentAt: 200, edited: true, legacy: false })
  })
})
