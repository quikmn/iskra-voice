import { describe, expect, it } from 'vitest'
import { stripMarkdown, stripMarkdownPieces } from './plainMarkdown'

describe('stripMarkdown', () => {
  it('drops paired emphasis, strike, spoiler and code markers', () => {
    expect(stripMarkdown('**Game Night** is *on*')).toBe('Game Night is on')
    expect(stripMarkdown('***both*** __under__ ~~gone~~ ||secret|| `code`')).toBe('both under gone secret code')
  })

  it('leaves lone or spaced markers alone', () => {
    expect(stripMarkdown('2 * 3 * 4')).toBe('2 * 3 * 4')
    expect(stripMarkdown('snake_case_name and a * star')).toBe('snake_case_name and a * star')
  })

  it('drops heading, small print and quote marks at line starts', () => {
    expect(stripMarkdown('# Rules\n-# small\n> quoted\nplain # not')).toBe('Rules\nsmall\nquoted\nplain # not')
  })

  it('turns tables into readable rows', () => {
    expect(stripMarkdown('| Game | Night |\n|---|---|\n| Catan | Friday |')).toBe(' Game · Night \n Catan · Friday ')
  })

  it('keeps the text of masked links', () => {
    expect(stripMarkdown('see [the docs](https://iskra.foo/docs) now')).toBe('see the docs now')
  })

  it('never touches mention or emoji tokens', () => {
    const key = 'ab__cd'.padEnd(43, 'x')
    expect(stripMarkdown(`<@${key}> said __hi__ <:blob__x:7>`)).toBe(`<@${key}> said hi <:blob__x:7>`)
  })
})

describe('stripMarkdownPieces', () => {
  it('keeps highlights on the same words', () => {
    const pieces = [{ text: '**Game ', hit: false }, { text: 'Night', hit: true }, { text: '** soon', hit: false }]
    expect(stripMarkdownPieces(pieces)).toEqual([{ text: 'Game ', hit: false }, { text: 'Night', hit: true }, { text: ' soon', hit: false }])
  })

  it('drops pieces that were only markers', () => {
    expect(stripMarkdownPieces([{ text: '**' }, { text: 'bold' }, { text: '**' }])).toEqual([{ text: 'bold' }])
  })
})
