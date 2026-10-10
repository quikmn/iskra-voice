import { describe, expect, it } from 'vitest'
import type { Channel, Member } from '../../core/protocol'
import { highlightSegments, parseSearch, readableMentions } from './searchQuery'

const channels: Channel[] = [
  { id: 1, name: 'general', kind: 'text', position: 0, readRole: 'member', writeRole: 'member' },
  { id: 2, name: 'game-night', kind: 'text', position: 1, readRole: 'member', writeRole: 'member' },
  { id: 3, name: 'lounge', kind: 'voice', position: 2, readRole: 'member', writeRole: 'member' },
]
const members: Member[] = [
  { accountKey: 'k-viktor', name: 'Viktor', role: 'owner', online: true },
  { accountKey: 'k-big', name: 'Big Bob', role: 'member', online: true },
  { accountKey: 'k-bobby', name: 'Bobby', role: 'member', online: false },
]
const now = new Date(2026, 9, 10, 15, 30)
const parse = (input: string) => parseSearch(input, { channels, members, now })

describe('search syntax', () => {
  it('keeps plain words as the query', () => {
    expect(parse('  minecraft   tonight ')).toEqual({ request: { query: 'minecraft tonight' }, errors: [], empty: false })
    expect(parse('"two words" alone').request.query).toBe('two words alone')
  })

  it('understands channel, person and content filters', () => {
    const { request, errors } = parse('in:#game-night from:viktor has:files has:link pizza')
    expect(errors).toEqual([])
    expect(request).toEqual({ channelId: 2, author: 'k-viktor', has: ['file', 'link'], query: 'pizza' })
    expect(parse('from:"big bob"').request.author).toBe('k-big')
    expect(parse('from:@Bobb').request.author).toBe('k-bobby')
  })

  it('reports filters it cannot resolve', () => {
    expect(parse('in:lounge').errors).toEqual(['No channel called #lounge.'])
    expect(parse('from:b').errors[0]).toMatch(/More than one/)
    expect(parse('from:nobody').errors[0]).toMatch(/Nobody/)
    expect(parse('has:pdf').errors[0]).toMatch(/has:file/)
    expect(parse('before:31/01/2026').errors[0]).toMatch(/Dates/)
    expect(parse('before:2026-02-30').errors[0]).toMatch(/Dates/)
  })

  it('turns dates into local day boundaries', () => {
    const start = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime()
    expect(parse('before:2026-01-31').request.before).toBe(start(2026, 1, 31))
    expect(parse('after:2026-01-31').request.after).toBe(start(2026, 2, 1))
    expect(parse('during:2026-01-31').request).toEqual({ after: start(2026, 1, 31), before: start(2026, 2, 1) })
    expect(parse('during:yesterday').request).toEqual({ after: start(2026, 10, 9), before: start(2026, 10, 10) })
    expect(parse('after:today').request.after).toBe(start(2026, 10, 11))
  })

  it('leaves unknown key:value words in the text and flags empty searches', () => {
    expect(parse('time:12 ok').request.query).toBe('time:12 ok')
    expect(parse('   ').empty).toBe(true)
    expect(parse('in:general').empty).toBe(true)
    expect(parse('in:general has:file').empty).toBe(false)
  })
})

describe('highlighting', () => {
  it('splits text into plain and matched pieces', () => {
    expect(highlightSegments('hello big cat', [[0, 5], [10, 3]])).toEqual([
      { text: 'hello', hit: true },
      { text: ' big ', hit: false },
      { text: 'cat', hit: true },
    ])
  })

  it('ignores bad or overlapping ranges', () => {
    expect(highlightSegments('abc', [[5, 2], [-1, 2], [1, 0]])).toEqual([{ text: 'abc', hit: false }])
    expect(highlightSegments('abcdef', [[0, 4], [2, 3]])).toEqual([{ text: 'abcde', hit: true }, { text: 'f', hit: false }])
  })

  it('cuts long text to a window around the first match', () => {
    const text = 'x'.repeat(500) + 'needle' + 'y'.repeat(500)
    const segments = highlightSegments(text, [[500, 6]], 100)
    expect(segments[0].text.startsWith('…')).toBe(true)
    expect(segments.at(-1)!.text.endsWith('…')).toBe(true)
    expect(segments.find((s) => s.hit)?.text).toBe('needle')
    expect(segments.map((s) => s.text).join('').length).toBeLessThanOrEqual(102)
  })

  it('never splits an emoji at the window edge', () => {
    const text = '😀'.repeat(200) + 'hit'
    const pieces = highlightSegments(text, [[400, 3]], 51).map((s) => s.text).join('')
    expect(pieces.replace(/…/g, '')).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })

  it('shows mentions as names', () => {
    const key = 'A'.repeat(43)
    expect(readableMentions(`hi <@${key}>!`, (k) => (k === key ? 'Alice' : null))).toBe('hi @Alice!')
  })
})
