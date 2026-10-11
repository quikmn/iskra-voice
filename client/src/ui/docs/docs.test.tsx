import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { docBlocks, docHeadings, renderDoc, tableCells } from './docMarkdown'
import { insertBlock, link, prefixLines, wrap } from './editing'

const ctx = { nameOf: () => null, serverUrl: 'https://friends.example' }
const html = (text: string) => renderToStaticMarkup(<>{renderDoc(text, ctx)}</>)
const FILE = '/files/abcdefghijklmnop1234/map.png'

describe('docs markdown', () => {
  it('splits a page into Markdown, tables, pictures and rules', () => {
    const blocks = docBlocks(`# Title\nIntro\n\n| Day | Game |\n| --- | :---: |\n| Fri | Chess |\n| Sat |\n\n![The map](${FILE})\n---\nEnd`)
    expect(blocks).toEqual([
      { kind: 'markdown', text: '# Title\nIntro' },
      { kind: 'table', head: ['Day', 'Game'], align: [undefined, 'center'], rows: [['Fri', 'Chess'], ['Sat', '']] },
      { kind: 'image', alt: 'The map', path: FILE },
      { kind: 'rule' },
      { kind: 'markdown', text: 'End' },
    ])
  })

  it('leaves code blocks alone', () => {
    const text = '```\n| a | b |\n| --- | --- |\n---\n```'
    expect(docBlocks(text)).toEqual([{ kind: 'markdown', text }])
    expect(docHeadings('# One\n```\n# not a heading\n```\n## Two\n### Three')).toEqual([
      { level: 1, text: 'One', index: 0 }, { level: 2, text: 'Two', index: 1 }, { level: 3, text: 'Three', index: 2 },
    ])
  })

  it('shows pictures from this server only', () => {
    expect(html(`![Map](${FILE})`)).toContain(`<img src="https://friends.example${FILE}" alt="Map" loading="lazy" referrerPolicy="no-referrer"/>`)
    const outside = html('![tracker](https://evil.example/pixel.png)')
    expect(outside).not.toContain('<img')
    expect(html('![x](/files/abcdefghijklmnop1234/a"onerror="x.png)')).not.toContain('<img')
  })

  it('renders tables with inline formatting and escaped pipes, as elements', () => {
    expect(tableCells('| a \\| b | **c** |')).toEqual(['a | b', '**c**'])
    const table = html('| Name | Note |\n| --- | ---: |\n| <script>x</script> | **bold** |')
    expect(table).toContain('<th style="text-align:right">Note</th>')
    expect(table).toContain('<td>&lt;script&gt;x&lt;/script&gt;</td>')
    expect(table).toContain('<strong>bold</strong>')
  })
})

describe('editor toolbar', () => {
  it('wraps and unwraps the selection', () => {
    expect(wrap('make this bold', 5, 9, '**')).toEqual({ text: 'make **this** bold', start: 7, end: 11 })
    expect(wrap('make **this** bold', 7, 11, '**')).toEqual({ text: 'make this bold', start: 5, end: 9 })
    expect(wrap('', 0, 0, '*', '*', 'italic')).toEqual({ text: '*italic*', start: 1, end: 7 })
  })

  it('prefixes lines, numbering lists, and toggles back', () => {
    expect(prefixLines('one\ntwo\nthree', 0, 7, '- ').text).toBe('- one\n- two\nthree')
    expect(prefixLines('one\ntwo', 0, 7, '1. ').text).toBe('1. one\n2. two')
    expect(prefixLines('- one\n- two', 0, 11, '- ').text).toBe('one\ntwo')
    expect(prefixLines('# Old', 0, 0, '## ').text).toBe('## Old')
  })

  it('puts blocks on lines of their own and makes links', () => {
    expect(insertBlock('before', 6, '| a |').text).toBe('before\n\n| a |')
    expect(insertBlock('a\n\nb', 3, 'X').text).toBe('a\n\nX\n\nb')
    expect(link('see here', 4, 8, 'https://app/#/open/x', 'Page')).toMatchObject({ text: 'see [here](https://app/#/open/x)' })
    expect(link('', 0, 0, 'https://u', 'Rules [v2]').text).toBe('[Rules v2](https://u)')
  })
})
