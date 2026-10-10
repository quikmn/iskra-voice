import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CustomEmoji, Poll } from '../../core/protocol'
import { plainText, renderMarkdown } from '../markdown'
import { completeEmoji, decodeEmoji, emojiQueryAt, encodeEmoji, insertAt, isEmojiOnly, parseCustomEmoji, searchEmoji } from './emoji'
import { isPollClosed, myVotes, pollProblem, pollResults, timeLeft } from './poll'

const blob: CustomEmoji = { id: 'AbCdEfGhIjK_', name: 'blob', url: '/files/x/blob.png', animated: false, createdBy: 'k' }
const party: CustomEmoji = { id: 'ZZZZZZZZZZZ-', name: 'party_parrot', url: '/files/y/p.gif', animated: true, createdBy: 'k' }

describe('custom emoji text', () => {
  it('encodes :name: for server emoji and standard shortcodes', () => {
    expect(encodeEmoji('hi :blob: and :fire:', [blob])).toBe(`hi <:blob:${blob.id}> and 🔥`)
    expect(encodeEmoji(':blob::blob:', [blob])).toBe(`<:blob:${blob.id}><:blob:${blob.id}>`)
    expect(encodeEmoji(':unknown: stays', [blob])).toBe(':unknown: stays')
  })

  it('leaves code, times and existing tokens alone', () => {
    expect(encodeEmoji('`:blob:` and ```\n:fire:\n```', [blob])).toBe('`:blob:` and ```\n:fire:\n```')
    expect(encodeEmoji('meet at 12:30:00', [blob])).toBe('meet at 12:30:00')
    const token = `<:blob:${blob.id}>`
    expect(encodeEmoji(token, [blob])).toBe(token)
  })

  it('decodes tokens for editing', () => {
    expect(decodeEmoji(`a <:blob:${blob.id}> b`)).toBe('a :blob: b')
    expect(parseCustomEmoji(`<:blob:${blob.id}>`)).toEqual({ name: 'blob', id: blob.id })
    expect(parseCustomEmoji('🔥')).toBeNull()
    expect(parseCustomEmoji('<:Blob:AbCdEfGhIjK_>')).toBeNull()
  })

  it('spots emoji-only messages', () => {
    expect(isEmojiOnly('🔥🔥')).toBe(true)
    expect(isEmojiOnly(`<:blob:${blob.id}> 👍🏽`)).toBe(true)
    expect(isEmojiOnly('🔥 hot')).toBe(false)
    expect(isEmojiOnly('123')).toBe(false)
    expect(isEmojiOnly('')).toBe(false)
  })

  it('searches server emoji first, by prefix', () => {
    const results = searchEmoji('pa', [blob, party])
    expect(results[0]).toEqual({ kind: 'custom', emoji: party })
    expect(results.some((r) => r.kind === 'standard' && r.name === 'partying')).toBe(true)
    expect(searchEmoji('thumbsup', [])[0]).toMatchObject({ kind: 'standard', char: '👍' })
  })

  it('completes the :query being typed', () => {
    expect(emojiQueryAt('hello :bl', 9)).toBe('bl')
    expect(emojiQueryAt('hello :b', 8)).toBeNull() // needs two characters
    expect(emojiQueryAt('12:30', 5)).toBeNull()
    expect(completeEmoji('hello :bl', 9, ':blob:')).toEqual({ text: 'hello :blob: ', caret: 13 })
    expect(insertAt('hi', 2, '🔥')).toEqual({ text: 'hi 🔥', caret: 5 })
    expect(insertAt('', 0, '🔥')).toEqual({ text: '🔥', caret: 2 })
  })
})

describe('custom emoji rendering', () => {
  const ctx = { nameOf: () => null, emoji: (id: string) => (id === blob.id ? 'https://srv/files/x/blob.png' : null) }
  const html = (text: string) => renderToStaticMarkup(<>{renderMarkdown(text, ctx)}</>)

  it('renders known emoji as images and unknown ones as text', () => {
    expect(html(`hi <:blob:${blob.id}>`)).toContain(
      'hi <img class="custom-emoji" src="https://srv/files/x/blob.png" alt=":blob:" title=":blob:" draggable="false"/>',
    )
    expect(html('hi <:gone:AAAAAAAAAAAA>')).toBe('hi <span class="custom-emoji-missing">:gone:</span>')
    expect(html(`\`<:blob:${blob.id}>\``)).toBe(`<code>&lt;:blob:${blob.id}&gt;</code>`)
  })

  it('makes emoji-only messages big', () => {
    expect(html('🎉')).toBe('<span class="jumbo">🎉</span>')
  })

  it('shows :name: in plain text', () => {
    expect(plainText(`nice <:blob:${blob.id}>`, ctx)).toBe('nice :blob:')
  })
})

describe('polls', () => {
  const poll: Poll = {
    question: 'Pizza?',
    options: [{ text: 'Yes', votes: ['a', 'b'] }, { text: 'No', votes: ['b'] }, { text: 'Maybe', votes: [] }],
    multi: true, expiresAt: 10_000, closedAt: null,
  }

  it('counts each voter once', () => {
    expect(pollResults(poll)).toEqual({ voters: 2, counts: [2, 1, 0], percents: [100, 50, 0], leaders: [0] })
    expect(pollResults({ ...poll, options: poll.options.map((o) => ({ ...o, votes: [] })) }).leaders).toEqual([])
    expect(myVotes(poll, 'b')).toEqual([0, 1])
    expect(myVotes(poll, undefined)).toEqual([])
  })

  it('closes at expiry or when ended', () => {
    expect(isPollClosed(poll, 9_999)).toBe(false)
    expect(isPollClosed(poll, 10_000)).toBe(true)
    expect(isPollClosed({ ...poll, expiresAt: null }, 1e15)).toBe(false)
    expect(isPollClosed({ ...poll, expiresAt: null, closedAt: 5 }, 0)).toBe(true)
  })

  it('words the time left and checks drafts', () => {
    expect(timeLeft(30_000)).toBe('less than a minute left')
    expect(timeLeft(45 * 60_000)).toBe('45m left')
    expect(timeLeft(5 * 3_600_000)).toBe('5h left')
    expect(timeLeft(3 * 86_400_000)).toBe('3d left')
    expect(pollProblem('', ['a', 'b'])).toBe('Ask a question.')
    expect(pollProblem('Q', ['a', ' '])).toBe('Add at least two answers.')
    expect(pollProblem('Q', ['a', 'A'])).toBe('Answers must be different from each other.')
    expect(pollProblem('Q', ['a', 'b', ''])).toBeNull()
  })
})
