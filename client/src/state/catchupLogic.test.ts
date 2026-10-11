import { describe, expect, it } from 'vitest'
import { i18next } from '../i18n'
import {
  busyStretches, durationText, excerpt, linkCount, overviewText, summarize, type CatchUpMessage, type Translate,
} from './catchupLogic'
import { catchUp, currentSummarizer, deterministicSummarizer, registerSummarizer } from './catchup'

const MIN = 60_000
const T0 = Date.UTC(2026, 9, 11, 12, 0)

let nextId = 1
function msg(over: Partial<CatchUpMessage> = {}): CatchUpMessage {
  return {
    id: nextId++, author: 'anna', at: T0, text: 'hi', mine: false, reactions: 0, replyTo: null, threadReplies: 0,
    pinned: false, mentionsMe: false, images: 0, files: 0, poll: null, ...over,
  }
}

const en: Translate = i18next.getFixedT('en') as unknown as Translate
const sv: Translate = i18next.getFixedT('sv') as unknown as Translate

describe('catch-up scoring', () => {
  it('ranks what stood out: mentions, pins, polls, reactions and replies', () => {
    nextId = 1
    const plain = msg({ text: 'just chatting' })
    const liked = msg({ author: 'bo', reactions: 4, at: T0 + MIN })
    const asked = msg({ author: 'cleo', mentionsMe: true, at: T0 + 2 * MIN })
    const pinned = msg({ author: 'bo', pinned: true, at: T0 + 3 * MIN })
    const poll = msg({ author: 'anna', poll: 'Pizza or tacos?', text: 'Pizza or tacos?', at: T0 + 4 * MIN })
    const discussed = msg({ author: 'dan', text: 'hot take', at: T0 + 5 * MIN })
    const replies = [1, 2, 3].map((i) => msg({ author: 'erik', replyTo: discussed.id, at: T0 + (5 + i) * MIN }))
    const s = summarize([plain, liked, asked, pinned, poll, discussed, ...replies])

    expect(s.highlights.map((h) => h.id)).toEqual([liked.id, asked.id, discussed.id, pinned.id, poll.id])
    expect(s.highlights[0]).toMatchObject({ reactions: 4, reasons: ['reactions'], score: 12 })
    expect(s.highlights.find((h) => h.id === discussed.id)).toMatchObject({ replies: 3, reasons: ['replies'] })
    expect(s.forYou.map((i) => i.id)).toEqual([asked.id])
    expect(s.pinned.map((i) => i.id)).toEqual([pinned.id])
    expect(s.polls.map((i) => i.excerpt)).toEqual(['Pizza or tacos?'])
    expect(s.highlights.some((h) => h.id === plain.id)).toBe(false)
  })

  it('counts others only, but replies to you stand out', () => {
    nextId = 1
    const mine = msg({ author: 'me', mine: true, text: 'anyone up for a game?' })
    const answer = msg({ author: 'bo', replyTo: mine.id, at: T0 + MIN })
    const s = summarize([mine, answer])
    expect(s.overview.messages).toBe(1)
    expect(s.people).toEqual([{ author: 'bo', count: 1 }])
    expect(s.forYou).toMatchObject([{ id: answer.id, reasons: ['replyToYou'] }])
  })

  it('collects links, pictures and files, and who talked most', () => {
    nextId = 1
    const s = summarize([
      msg({ author: 'bo', text: 'see https://example.com and https://example.com and http://a.test/x' }),
      msg({ author: 'bo', images: 2, text: '', at: T0 + MIN }),
      msg({ author: 'cleo', files: 1, at: T0 + 2 * MIN }),
      msg({ author: 'bo', at: T0 + 3 * MIN }),
    ])
    expect(s.overview).toMatchObject({ messages: 4, people: 2, links: 2, images: 2, files: 1, polls: 0, mentions: 0 })
    expect(s.shared).toHaveLength(3)
    expect(s.people).toEqual([{ author: 'bo', count: 3 }, { author: 'cleo', count: 1 }])
  })

  it('is deterministic whatever order the messages come in', () => {
    nextId = 1
    const list = Array.from({ length: 60 }, (_, i) => msg({ author: `p${i % 7}`, at: T0 + i * 30_000, reactions: i % 5, replyTo: i > 3 && i % 4 === 0 ? i - 2 : null }))
    const a = summarize(list)
    const b = summarize([...list].reverse())
    expect(b).toEqual(a)
    expect(JSON.stringify(summarize(list))).toBe(JSON.stringify(a))
  })

  it('finds the busiest stretches', () => {
    nextId = 1
    const burst = (start: number, n: number) => Array.from({ length: n }, (_, i) => msg({ at: start + i * MIN }))
    const list = [...burst(T0, 3), ...burst(T0 + 120 * MIN, 12), ...burst(T0 + 300 * MIN, 6)]
    const stretches = busyStretches(list)
    expect(stretches.map((s) => s.count)).toEqual([12, 6])
    expect(stretches[0]).toMatchObject({ start: T0 + 120 * MIN, end: T0 + 131 * MIN, firstId: list[3].id })
    expect(busyStretches(burst(T0, 40))).toEqual([]) // one long run: nothing to point out
  })

  it('makes short one-line excerpts and counts each link once', () => {
    expect(excerpt('line one\nline   two')).toBe('line one line two')
    expect(excerpt('x'.repeat(200))).toHaveLength(140)
    expect(excerpt('before ```const a = 1``` after')).toBe('before [code] after')
    expect(linkCount('https://a.test https://a.test https://b.test/x')).toBe(2)
  })
})

describe('catch-up overview line', () => {
  const o = { messages: 128, people: 6, start: T0, end: T0 + 3 * 60 * MIN, links: 4, images: 2, files: 0, polls: 1, mentions: 0 }

  it('reads naturally in English', () => {
    expect(overviewText(o, en)).toBe('128 messages from 6 people over 3 h; 4 links, 2 images, 1 poll')
    expect(overviewText({ ...o, messages: 1, people: 1, links: 1, images: 0, polls: 0, mentions: 1, end: T0 + 45 * MIN }, en))
      .toBe('1 message from 1 person over 45 min; 1 mention of you, 1 link')
    expect(overviewText({ ...o, links: 0, images: 0, polls: 0, end: T0 + 20_000 }, en)).toBe('128 messages from 6 people in under a minute')
    expect(overviewText({ ...o, files: 3, end: T0 + 3 * 24 * 60 * MIN }, en)).toBe('128 messages from 6 people over 3 days; 4 links, 2 images, 3 files, 1 poll')
  })

  it('reads naturally in Swedish, plurals included', () => {
    expect(overviewText(o, sv)).toBe('128 meddelanden från 6 personer under 3 tim; 4 länkar, 2 bilder, 1 omröstning')
    expect(overviewText({ ...o, messages: 1, people: 1, links: 1, images: 1, polls: 2, mentions: 2, end: T0 + 24 * 60 * MIN * 2 }, sv))
      .toBe('1 meddelande från 1 person under 2 dagar; 2 omnämnanden av dig, 1 länk, 1 bild, 2 omröstningar')
    expect(durationText(36 * 60 * MIN, sv)).toBe('36 tim')
    expect(durationText(30_000, sv)).toBe('1 min')
  })
})

describe('summarizers', () => {
  it('uses an extra summarizer only while it is available, and falls back if it fails', async () => {
    nextId = 1
    const messages = [msg({ reactions: 2 })]
    expect(currentSummarizer()).toBe(deterministicSummarizer)
    let ready = false
    const remove = registerSummarizer({
      id: 'future-local-model',
      available: () => ready,
      summarize: async () => { throw new Error('model crashed') },
    })
    expect(currentSummarizer()).toBe(deterministicSummarizer)
    ready = true
    expect(currentSummarizer().id).toBe('future-local-model')
    const result = await catchUp(messages, new AbortController().signal)
    expect(result.by).toBe('local')
    expect(result.overview.messages).toBe(1)
    remove()
    expect(currentSummarizer()).toBe(deterministicSummarizer)
  })
})
