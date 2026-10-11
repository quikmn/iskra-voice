import { describe, expect, it } from 'vitest'
import type { DocPage } from '../core/protocol'
import { pageLink, parseOpenRoute } from '../core/pushRoute'
import {
  CONFLICT_MINE, CONFLICT_SPLIT, CONFLICT_THEIRS, changeCounts, diffLines, filterPages, hasConflictMarkers, merge3, moveTarget, pageTree,
  readingOrder, upsertPage,
} from './docsLogic'

const page = (id: number, title: string, parentId: number | null = null, position = 0): DocPage => ({
  id, channelId: 1, parentId, title, position, version: 1, createdBy: 'a', createdAt: 0, updatedBy: 'a', updatedAt: 0, size: 0,
})

describe('page tree', () => {
  const pages = [page(3, 'FAQ', null, 1), page(1, 'Guide', null, 0), page(5, 'Setup', 1, 1), page(4, 'Install', 1, 0), page(9, 'Orphan', 77)]

  it('orders top-level pages and their sub-pages', () => {
    expect(pageTree(pages).map((n) => [n.page.title, n.children.map((c) => c.title)])).toEqual([
      ['Guide', ['Install', 'Setup']], ['Orphan', []], ['FAQ', []],
    ])
    expect(readingOrder(pages).map((p) => p.title)).toEqual(['Guide', 'Install', 'Setup', 'Orphan', 'FAQ'])
  })

  it('moves pages up and down among their siblings', () => {
    expect(moveTarget(pages, 4, 1)).toEqual({ parentId: 1, before: null }) // Install below Setup: last
    expect(moveTarget(pages, 5, -1)).toEqual({ parentId: 1, before: 4 })
    expect(moveTarget(pages, 4, -1)).toBeUndefined()
    expect(moveTarget(pages, 3, -1)).toEqual({ parentId: null, before: 1 })
  })

  it('filters by title ignoring case and accents', () => {
    const list = [page(1, 'Café rules'), page(2, 'Server setup'), page(3, 'Rules for raids', null, 1)]
    expect(filterPages(list, 'cafe').map((p) => p.id)).toEqual([1])
    expect(filterPages(list, 'RULES').map((p) => p.id)).toEqual([1, 3])
    expect(filterPages(list, '  ').map((p) => p.id)).toEqual([1, 2, 3])
  })

  it('keeps lists free of page text', () => {
    const list = upsertPage([page(1, 'A')], { ...page(1, 'A2'), version: 2, text: 'body' })
    expect(list).toEqual([{ ...page(1, 'A2'), version: 2 }])
    expect(upsertPage(list, page(2, 'B')).map((p) => p.id)).toEqual([1, 2])
  })
})

describe('diffs and merges', () => {
  it('diffs by line', () => {
    const d = diffLines(['a', 'b', 'c'], ['a', 'x', 'c', 'd'])
    expect(d).toEqual([
      { kind: 'same', text: 'a' }, { kind: 'removed', text: 'b' }, { kind: 'added', text: 'x' }, { kind: 'same', text: 'c' }, { kind: 'added', text: 'd' },
    ])
    expect(changeCounts('a\nb\nc', 'a\nx\nc\nd')).toEqual({ added: 2, removed: 1 })
  })

  it('combines changes to different parts of a page', () => {
    const base = 'intro\n\nrule one\nrule two\n\noutro'
    const mine = 'intro, edited\n\nrule one\nrule two\n\noutro'
    const theirs = 'intro\n\nrule one\nrule two\nrule three\n\noutro'
    expect(merge3(base, mine, theirs)).toEqual({ text: 'intro, edited\n\nrule one\nrule two\nrule three\n\noutro', conflicts: 0 })
  })

  it('takes the only side that changed, and identical changes once', () => {
    expect(merge3('a', 'a', 'b')).toEqual({ text: 'b', conflicts: 0 })
    expect(merge3('a', 'b', 'a')).toEqual({ text: 'b', conflicts: 0 })
    expect(merge3('a\nb', 'a\nnew\nb', 'a\nnew\nb')).toEqual({ text: 'a\nnew\nb', conflicts: 0 })
    expect(merge3('a\nb\nc', 'a\nb\nc\nmine', 'a\nb2\nc')).toEqual({ text: 'a\nb2\nc\nmine', conflicts: 0 })
  })

  it('marks lines both changed differently', () => {
    const merged = merge3('one\ntwo\nthree', 'one\nTWO (me)\nthree', 'one\nTWO (them)\nthree')
    expect(merged.conflicts).toBe(1)
    expect(merged.text).toBe(['one', CONFLICT_MINE, 'TWO (me)', CONFLICT_SPLIT, 'TWO (them)', CONFLICT_THEIRS, 'three'].join('\n'))
    expect(hasConflictMarkers(merged.text)).toBe(true)
    expect(hasConflictMarkers('a line with <<<<<<< Your version inside')).toBe(false)
    // Both adding different lines at the same spot is a conflict too.
    expect(merge3('a\nb', 'a\nmine\nb', 'a\ntheirs\nb').conflicts).toBe(1)
  })
})

describe('page links', () => {
  it('round-trip through the open route', () => {
    const server = 'S'.repeat(43)
    const link = pageLink('https://app.iskra.foo/', server, 7, 42)
    expect(link).toBe(`https://app.iskra.foo/#/open/${server}/c/7/p/42`)
    expect(parseOpenRoute(link.slice(link.indexOf('#')))).toEqual({ server, kind: 'channel', channelId: 7, pageId: 42 })
    expect(parseOpenRoute(`#/open/${server}/c/7/p/0`)).toBeNull()
  })
})
