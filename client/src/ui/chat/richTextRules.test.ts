import { describe, expect, it } from 'vitest'
import { formatTimestamp, highlight, languageOf, parseTimestamp } from './richTextRules'

const at = Date.UTC(2026, 9, 10, 15, 4, 5)
const opts = { locale: 'en-US', timeZone: 'UTC', now: at }

describe('timestamps', () => {
  it('formats every Discord style', () => {
    expect(formatTimestamp(at, 't', opts)).toBe('3:04 PM')
    expect(formatTimestamp(at, 'T', opts)).toBe('3:04:05 PM')
    expect(formatTimestamp(at, 'd', opts)).toBe('10/10/2026')
    expect(formatTimestamp(at, 'D', opts)).toBe('October 10, 2026')
    expect(formatTimestamp(at, 'f', opts)).toBe('October 10, 2026 at 3:04 PM')
    expect(formatTimestamp(at, 'F', opts)).toBe('Saturday, October 10, 2026 at 3:04 PM')
  })

  it('says relative times', () => {
    expect(formatTimestamp(at + 5 * 60_000, 'R', opts)).toBe('in 5 minutes')
    expect(formatTimestamp(at - 2 * 3_600_000, 'R', opts)).toBe('2 hours ago')
    expect(formatTimestamp(at - 86_400_000, 'R', opts)).toBe('yesterday')
    expect(formatTimestamp(at + 3 * 365 * 86_400_000, 'R', opts)).toBe('in 3 years')
  })

  it('only takes dates JavaScript can show', () => {
    expect(parseTimestamp('1760000000')).toBe(1_760_000_000_000)
    expect(parseTimestamp('9999999999999')).toBeNull()
  })
})

describe('highlighting', () => {
  const kinds = (code: string, lang: string) => highlight(code, lang).filter((t) => t.kind !== 'plain').map((t) => `${t.kind}:${t.text}`)

  it('colours keywords, strings, numbers, literals and comments', () => {
    expect(kinds('const x = "hi" // note\nreturn null', 'ts')).toEqual(['keyword:const', 'string:"hi"', 'comment:// note', 'keyword:return', 'literal:null'])
    expect(kinds("def f(): return 'x' # c", 'python')).toEqual(['keyword:def', 'keyword:return', "string:'x'", 'comment:# c'])
    expect(kinds('SELECT id FROM t WHERE n = 42', 'sql')).toEqual(['keyword:SELECT', 'keyword:FROM', 'keyword:WHERE', 'number:42'])
    expect(kinds('a /* x */ b', 'c')).toEqual(['comment:/* x */'])
  })

  it('handles escapes, template strings and words that contain keywords', () => {
    expect(kinds('"a \\" b"', 'js')).toEqual(['string:"a \\" b"'])
    expect(kinds('`multi\nline`', 'js')).toEqual(['string:`multi\nline`'])
    expect(kinds('constant x1 = 2', 'js')).toEqual(['number:2'])
  })

  it('marks diffs and leaves unknown languages alone', () => {
    expect(kinds('+added\n-removed\n same', 'diff')).toEqual(['added:+added\n', 'removed:-removed\n'])
    expect(highlight('whatever', 'brainfuck')).toEqual([{ kind: 'plain', text: 'whatever' }])
    expect(languageOf('TSX')).toBe('ts')
    // The tokens always add back up to the code.
    const code = 'fn main() { let s = "x"; } // done'
    expect(highlight(code, 'rust').map((t) => t.text).join('')).toBe(code)
  })
})
