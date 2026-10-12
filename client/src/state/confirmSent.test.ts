import { describe, expect, it } from 'vitest'
import { confirmSent, type PendingMessage } from './store'

const msg = (id: number, extra: Partial<PendingMessage> = {}): PendingMessage => ({
  id, channelId: 1, author: 'me', text: `m${id}`, createdAt: id, editedAt: null, replyTo: null, reactions: [], attachments: [], ...extra,
})

describe('a send confirmed by its reply', () => {
  it('replaces the placeholder', () => {
    const list = [msg(1), msg(Number.MAX_SAFE_INTEGER, { tempId: 't1', pending: 'sending' })]
    expect(confirmSent(list, 't1', msg(2))).toEqual([msg(1), msg(2)])
  })

  it("keeps what the events already brought: a reaction that came before the reply isn't lost", () => {
    // Regression (bots e2e on CI): the bot reacted to the message while the server was still finishing the send, so
    // chat.message and chat.reactions both arrived before the reply, whose older copy then wiped the reaction.
    const reacted = msg(2, { reactions: [{ emoji: '🎲', accounts: ['bot'] }] })
    const list = [msg(1), reacted, msg(Number.MAX_SAFE_INTEGER, { tempId: 't1', pending: 'sending' })]
    expect(confirmSent(list, 't1', msg(2))).toEqual([msg(1), reacted])
  })

  it('works before the channel is loaded', () => {
    expect(confirmSent(undefined, 't1', msg(2))).toEqual([msg(2)])
  })
})
