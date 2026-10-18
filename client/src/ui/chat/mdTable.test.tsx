import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MAX_TABLE_COLUMNS, MAX_TABLE_ROWS, parseTable, tableCells } from './mdTable'
import { renderMarkdown } from '../markdown'
import { stripMarkdown } from '../plainMarkdown'

const html = (text: string) => renderToStaticMarkup(<>{renderMarkdown(text, { nameOf: () => null })}</>)

describe('table cells', () => {
  it('splits on pipes but not inside code spans or after a backslash', () => {
    expect(tableCells('| a | `b|c` | d\\|e |')).toEqual(['a', '`b|c`', 'd|e'])
    expect(tableCells('| `x\\|y` | z |')).toEqual(['`x|y`', 'z'])
    expect(tableCells('a | b')).toEqual(['a', 'b'])
    expect(tableCells('| a | `open | b |')).toEqual(['a', '`open', 'b'])
  })
})

describe('parseTable', () => {
  it('reads header, alignment and rows', () => {
    const t = parseTable(['| a | b | c |', '|:---|:---:|---:|', '| 1 | 2 | 3 |', 'after'], 0)!
    expect(t.head).toEqual(['a', 'b', 'c'])
    expect(t.align).toEqual(['left', 'center', 'right'])
    expect(t.rows).toEqual([['1', '2', '3']])
    expect(t.end).toBe(3)
  })
  it('pads short rows and drops extra cells', () => {
    const t = parseTable(['|a|b|', '|---|---|', '|1|', '|1|2|3|'], 0)!
    expect(t.rows).toEqual([['1', ''], ['1', '2']])
  })
  it('needs a matching separator', () => {
    expect(parseTable(['| a | b |', '| a | b |'], 0)).toBeNull()
    expect(parseTable(['| a | b |', '|---|'], 0)).toBeNull()
    expect(parseTable(['| a | b |'], 0)).toBeNull()
  })
  it('refuses tables over the limits', () => {
    const wide = Array.from({ length: MAX_TABLE_COLUMNS + 1 }, () => 'x')
    expect(parseTable([`|${wide.join('|')}|`, `|${wide.map(() => '---').join('|')}|`], 0)).toBeNull()
    const rows = Array.from({ length: MAX_TABLE_ROWS + 1 }, () => '| 1 |')
    expect(parseTable(['| a |', '|---|', ...rows], 0)).toBeNull()
  })
})

describe('tables in messages', () => {
  it('renders cells with inline formatting', () => {
    const out = html('| **a** | `b|c` |\n|---|:---:|\n| _x_ | y |')
    expect(out).toContain('<table class="md-table">')
    expect(out).toContain('<th><strong>a</strong></th>')
    expect(out).toContain('<th style="text-align:center"><code>b|c</code></th>')
    expect(out).toContain('<td><em>x</em></td>')
  })
  it('keeps text before and after, and the table ends at the first non-row line', () => {
    const out = html('before\n| a |\n|---|\n| 1 |\nafter')
    expect(out.startsWith('before')).toBe(true)
    expect(out.endsWith('</div>after')).toBe(true)
  })
  it('leaves tables inside code blocks literal', () => {
    const out = html('```\n| a | b |\n|---|---|\n```')
    expect(out).not.toContain('<table')
    expect(out).toContain('| a | b |')
  })
  it('shows an over-limit table as plain text', () => {
    const wide = Array.from({ length: 13 }, () => 'x')
    expect(html(`|${wide.join('|')}|\n|${wide.map(() => '---').join('|')}|`)).not.toContain('<table')
  })
  it('keeps a lone pipe line as text', () => {
    expect(html('| not a table |')).toBe('| not a table |')
  })
  it('previews read sensibly', () => {
    expect(stripMarkdown('| a | b |').trim()).toBe('a · b')
    expect(stripMarkdown('-# small')).toBe('small')
  })
})
