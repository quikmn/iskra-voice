import { describe, expect, it } from 'vitest'
import { laterMark, parseReceiptMark, parseReceiptSettings, receiptToSend, seenBy, seenMessage, type ReceiptMessage } from './receiptsLogic'

const ME = 'me'
const BOB = 'bob'
const CAT = 'cat'
const m = (id: string, from: string, sentAt: number, extra: Partial<ReceiptMessage> = {}): ReceiptMessage => ({ id, from, sentAt, ...extra })

describe('read receipts', () => {
  const chat = [m('a', ME, 10), m('b', BOB, 20), m('c', ME, 30), m('d', BOB, 40), m('e', ME, 50)]

  it('is off unless turned on, and reads only a well formed setting', () => {
    expect(parseReceiptSettings({ v: 1, updatedAt: 3, send: true })).toEqual({ v: 1, updatedAt: 3, send: true })
    expect(parseReceiptSettings({ v: 1, updatedAt: 3 })).toBeNull()
    expect(parseReceiptSettings({ v: 2, updatedAt: 3, send: true })).toBeNull()
    expect(parseReceiptSettings('on')).toBeNull()
  })

  it('reads only a well formed mark', () => {
    expect(parseReceiptMark({ id: 'abc', sentAt: 5, extra: 1 })).toEqual({ id: 'abc', sentAt: 5 })
    expect(parseReceiptMark({ id: '', sentAt: 5 })).toBeNull()
    expect(parseReceiptMark({ id: 'x'.repeat(65), sentAt: 5 })).toBeNull()
    expect(parseReceiptMark({ id: 'abc', sentAt: -1 })).toBeNull()
    expect(parseReceiptMark({ id: 'abc', sentAt: 1.5 })).toBeNull()
    expect(parseReceiptMark(null)).toBeNull()
  })

  it('sends the newest message from someone else, once', () => {
    expect(receiptToSend(chat, ME, undefined)).toEqual({ id: 'd', sentAt: 40 })
    expect(receiptToSend(chat, ME, { id: 'd', sentAt: 40 })).toBeNull()
    expect(receiptToSend(chat, ME, { id: 'b', sentAt: 20 })).toEqual({ id: 'd', sentAt: 40 })
    // Nothing from anyone else: nothing to say.
    expect(receiptToSend([m('a', ME, 10)], ME, undefined)).toBeNull()
    expect(receiptToSend([], ME, undefined)).toBeNull()
  })

  it('never names a pending, unreadable or quiet line', () => {
    const list = [m('b', BOB, 20), m('f', BOB, 60, { error: 'unreadable' }), m('g', BOB, 70, { quiet: true }), m('h', BOB, 80, { pending: 'sending' })]
    expect(receiptToSend(list, ME, undefined)).toEqual({ id: 'b', sentAt: 20 })
  })

  it('never moves a mark back', () => {
    expect(laterMark({ id: 'd', sentAt: 40 }, { id: 'b', sentAt: 20 })).toEqual({ id: 'd', sentAt: 40 })
    expect(laterMark({ id: 'b', sentAt: 20 }, { id: 'd', sentAt: 40 })).toEqual({ id: 'd', sentAt: 40 })
    expect(laterMark(undefined, { id: 'b', sentAt: 20 })).toEqual({ id: 'b', sentAt: 20 })
  })

  it('shows Seen under the last message you sent that the other side read', () => {
    // Bob read up to his own "d": that covers my "c", not my later "e".
    expect(seenMessage(chat, ME, { id: 'd', sentAt: 40 })).toBe('c')
    expect(seenMessage(chat, ME, { id: 'b', sentAt: 20 })).toBe('a')
    expect(seenMessage(chat, ME, undefined)).toBeNull()
    // In a group the newest message someone else wrote can be mine.
    expect(seenMessage(chat, ME, { id: 'e', sentAt: 50 })).toBe('e')
  })

  it('falls back to the times when the named message is not on this device', () => {
    expect(seenMessage(chat, ME, { id: 'gone', sentAt: 45 })).toBe('c')
    expect(seenMessage(chat, ME, { id: 'gone', sentAt: 5 })).toBeNull()
  })

  it('does not count a message that is still sending or failed', () => {
    const list = [m('a', ME, 10), m('b', BOB, 20), m('p', ME, 15, { pending: 'failed', error: 'x' })]
    expect(seenMessage(list, ME, { id: 'b', sentAt: 20 })).toBe('a')
  })

  it('groups readers under the last of your messages each has seen', () => {
    const marks = { [BOB]: { id: 'e', sentAt: 50 }, [CAT]: { id: 'b', sentAt: 20 }, [ME]: { id: 'e', sentAt: 50 } }
    expect(seenBy(chat, ME, marks, [BOB, CAT, ME, 'dan'])).toEqual({ e: [BOB], a: [CAT] })
    expect(seenBy(chat, ME, {}, [BOB, CAT])).toEqual({})
  })
})
