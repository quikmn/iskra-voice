import { describe, expect, it } from 'vitest'
import { hiddenServers, moveFolder, moveServer, newFolder, parseLayout, withHidden, stepServer, ungroup, updateFolder, visibleRail, type RailItem, type RailLayout } from './railLogic'

const k = (c: string) => c.repeat(43)
const [A, B, C, D] = ['a', 'b', 'c', 'd'].map(k)
const order = [A, B, C, D]
const L = (items: RailItem[]): RailLayout => ({ items, updatedAt: 1 })
const ids = (items: RailItem[]) => items.map((i) => (i.kind === 'server' ? i.key[0] : `[${i.servers.map((s) => s[0]).join('')}]`)).join(' ')
let n = 0
const fid = () => `f-${++n}`
const folderId = (items: RailItem[]) => (items.find((i) => i.kind === 'folder') as { id: string }).id

describe('rail layout', () => {
  it('leaves hidden servers off the rail, in folders too, and shows them again', () => {
    const layout: RailLayout = { items: [{ kind: 'folder', id: 'f-1', name: '', color: '#7c6fff', servers: [A, B], collapsed: false }], hidden: [B, D], updatedAt: 1 }
    expect(ids(visibleRail(layout, order))).toBe('[a] c')
    expect(hiddenServers(layout, order).map((x) => x[0])).toEqual(['b', 'd'])
    expect(withHidden(layout, D, false)).toEqual([B])
    expect(withHidden(layout, C, true)).toEqual([B, D, C])
    // Moving a server keeps the others hidden; stepping skips hidden ones.
    expect(ids(stepServer(layout, order, C, -1))).toContain('c')
    expect(visibleRail({ ...layout, items: moveServer(layout, order, C, { kind: 'before', target: A }, fid) }, order).some((i) => i.kind === 'server' && i.key === D)).toBe(false)
  })

  it('reads the hidden list from another device carefully', () => {
    expect(parseLayout({ items: [], updatedAt: 2, hidden: [A, A, 'nope', 5] })).toEqual({ items: [], hidden: [A], updatedAt: 2 })
    expect(parseLayout({ items: [], updatedAt: 2, hidden: 'x' })).toBeNull()
    expect(parseLayout({ items: [], updatedAt: 2 })).toEqual({ items: [], updatedAt: 2 })
  })

  it('shows every server on this device, new ones last, and hides others', () => {
    const layout = L([{ kind: 'server', key: k('z') }, { kind: 'server', key: C }, { kind: 'folder', id: 'f-1', name: '', color: '#7c6fff', servers: [k('y'), B], collapsed: false }])
    expect(ids(visibleRail(layout, order))).toBe('c [b] a d')
  })

  it('reorders and makes folders by dropping onto a server', () => {
    const empty = L([])
    expect(ids(moveServer(empty, order, D, { kind: 'before', target: A }, fid))).toBe('d a b c')
    const folded = moveServer(empty, order, C, { kind: 'combine', target: A }, fid)
    expect(ids(folded)).toBe('[ac] b d')
    const more = moveServer(L(folded), order, D, { kind: 'into', folder: folderId(folded) }, fid)
    expect(ids(more)).toBe('[acd] b')
    // Next to a server inside a folder lands in the folder; out again by dropping beside the folder.
    expect(ids(moveServer(L(more), order, B, { kind: 'before', target: C }, fid))).toBe('[abcd]')
    expect(ids(moveServer(L(more), order, C, { kind: 'after', target: folderId(more) }, fid))).toBe('[ad] c b')
    // A folder emptied out goes away.
    const solo = L([{ kind: 'folder', id: 'f-9', name: '', color: '#7c6fff', servers: [A], collapsed: false }])
    expect(ids(moveServer(solo, order, A, { kind: 'after', target: D }, fid))).toBe('b c d a')
  })

  it('moves, renames, ungroups and steps', () => {
    const layout = L(newFolder(L([]), order, B, 'f-x'))
    expect(ids(layout.items)).toBe('a [b] c d')
    expect(ids(moveFolder(layout, order, 'f-x', { kind: 'after', target: D }))).toBe('a c d [b]')
    expect(updateFolder(layout, 'f-x', { name: 'Games', collapsed: true }).find((i) => i.kind === 'folder')).toMatchObject({ name: 'Games', collapsed: true })
    expect(ids(ungroup(layout, 'f-x'))).toBe('a b c d')
    expect(ids(stepServer(L([]), order, C, -1))).toBe('a c b d')
    expect(stepServer(L([]), order, A, -1)).toEqual([])
  })

  it('rejects malformed layouts from storage or other devices', () => {
    expect(parseLayout({ items: [{ kind: 'server', key: 'short' }], updatedAt: 1 })).toBeNull()
    expect(parseLayout({ items: 'x', updatedAt: 1 })).toBeNull()
    const parsed = parseLayout({ items: [{ kind: 'folder', id: 'f-1', name: 'x'.repeat(99), color: 'red', servers: [A, A, 5], collapsed: 1 }, { kind: 'server', key: A }], updatedAt: 3 })
    expect(parsed?.items).toEqual([{ kind: 'folder', id: 'f-1', name: 'x'.repeat(32), color: '#7c6fff', servers: [A], collapsed: false }])
  })
})
