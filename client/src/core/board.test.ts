import { beforeAll, describe, expect, it } from 'vitest'
import {
  batches, BoardState, checkLive, checkOps, decodePoints, encodePoints, hits, History, newObjectId, simplify, type Op, type Props,
} from './board'
import { openBoard, sealBoard } from './boardCrypto'
import { b64u, ready } from './crypto'
import { newChainId, newEpochKey, signChannelChange, verifyChannelChain } from './channelChain'
import { createIdentity } from './identity'

beforeAll(ready)

const pen = (id: string, x = 0, color = '#1f2328'): Op => ({ id, p: { kind: 'pen', x, y: 0, pts: [0, 0, 10, 10], color, size: 3, z: 1 } })

/** Two apps on one board: each folds the server's order (with its own pending changes on top). */
function replicas() {
  const a = new BoardState()
  const b = new BoardState()
  let seq = 0
  const log: { seq: number; ops: Op[]; cid: string; from: 'a' | 'b' }[] = []
  return {
    a, b, log,
    /** The server takes a batch: every app applies it in this order. */
    deliver(from: 'a' | 'b', cid: string, ops: Op[]) {
      log.push({ seq: ++seq, ops, cid, from })
      a.applyConfirmed(ops, from === 'a' ? cid : undefined)
      b.applyConfirmed(ops, from === 'b' ? cid : undefined)
    },
  }
}

describe('board model', () => {
  it('checks ops like the server', () => {
    expect(() => checkOps([pen('stroke-0001')])).not.toThrow()
    expect(() => checkOps([])).toThrow()
    expect(() => checkOps([{ id: 'short', p: { x: 1 } }])).toThrow()
    expect(() => checkOps([{ id: 'stroke-0001', p: { color: 'red' } }])).toThrow()
    expect(() => checkOps([{ id: 'stroke-0001', p: { kind: 'blob' } }])).toThrow()
    expect(() => checkOps([{ id: 'stroke-0001', p: { pts: [1, 2, 3] } }])).toThrow()
    expect(() => checkOps([{ id: 'stroke-0001', p: { text: 'x'.repeat(2001) } }])).toThrow()
    expect(() => checkOps([{ id: 'stroke-0001', p: { src: 'https://evil.example/x.png' } }])).toThrow()
    expect(() => checkOps([{ id: 'stroke-0001', p: { html: '<b>' } }])).toThrow()
    expect(() => checkOps([{ id: 'stroke-0001', p: { x: null } }])).not.toThrow()
    expect(newObjectId()).toMatch(/^[A-Za-z0-9_-]{16}$/)
  })

  it('merges concurrent edits field by field, in the server order, on every replica', () => {
    const { a, b, deliver } = replicas()
    deliver('a', 'c0', [pen('stroke-0001')])
    // Alice moves it and Bob recolours it at the same time: both changes land.
    a.addPending('c1', [{ id: 'stroke-0001', p: { x: 50 } }])
    b.addPending('c2', [{ id: 'stroke-0001', p: { color: '#e5484d' } }])
    expect(a.get('stroke-0001')?.x).toBe(50)
    expect(a.get('stroke-0001')?.color).toBe('#1f2328')
    deliver('b', 'c2', [{ id: 'stroke-0001', p: { color: '#e5484d' } }])
    // Alice's own move is still pending: shown on top of Bob's confirmed change.
    expect(a.get('stroke-0001')).toMatchObject({ x: 50, color: '#e5484d' })
    deliver('a', 'c1', [{ id: 'stroke-0001', p: { x: 50 } }])
    expect(a.pendingCount()).toBe(0)
    expect(a.list()).toEqual(b.list())
    expect(b.get('stroke-0001')).toMatchObject({ x: 50, color: '#e5484d' })

    // Same field at once: the later one in server order wins everywhere.
    a.addPending('c3', [{ id: 'stroke-0001', p: { x: 1 } }])
    b.addPending('c4', [{ id: 'stroke-0001', p: { x: 2 } }])
    deliver('b', 'c4', [{ id: 'stroke-0001', p: { x: 2 } }])
    deliver('a', 'c3', [{ id: 'stroke-0001', p: { x: 1 } }])
    expect(a.get('stroke-0001')?.x).toBe(1)
    expect(b.get('stroke-0001')?.x).toBe(1)
  })

  it('hides deleted and kindless objects, orders by z then id, and drops refused batches', () => {
    const s = new BoardState()
    s.applyConfirmed([pen('bbbbbbbb'), { ...pen('aaaaaaaa'), p: { ...pen('aaaaaaaa').p, z: 1 } }, { id: 'cccccccc', p: { ...pen('cccccccc').p, z: 0 } }])
    expect(s.list().map((o) => o.id)).toEqual(['cccccccc', 'aaaaaaaa', 'bbbbbbbb'])
    s.applyConfirmed([{ id: 'aaaaaaaa', p: { d: true } }, { id: 'dddddddd', p: { x: 5 } }])
    expect(s.list().map((o) => o.id)).toEqual(['cccccccc', 'bbbbbbbb'])
    s.addPending('x', [pen('eeeeeeee')])
    expect(s.list()).toHaveLength(3)
    s.dropPending('x')
    expect(s.list()).toHaveLength(2)
    // Records keep their identity until they change (renderers cache by it).
    const before = s.list().find((o) => o.id === 'cccccccc')
    s.applyConfirmed([{ id: 'bbbbbbbb', p: { x: 9 } }])
    expect(s.list().find((o) => o.id === 'cccccccc')).toBe(before)
    expect(s.confirmedObjects()).not.toHaveProperty('aaaaaaaa')
  })

  it('undoes and redoes only this person’s changes', () => {
    const s = new BoardState()
    const h = new History()
    const apply = (ops: Op[]) => s.applyConfirmed(ops)
    const mine = (ops: Op[]) => {
      h.record(s, ops)
      apply(ops)
    }
    mine([pen('stroke-0001')])
    mine([{ id: 'stroke-0001', p: { x: 40, color: '#30a46c' } }])
    // Someone else adds a stroke meanwhile; undo never touches it.
    apply([pen('theirs-0001', 100)])
    apply(h.undo()!)
    expect(s.get('stroke-0001')).toMatchObject({ x: 0, color: '#1f2328' })
    apply(h.undo()!)
    expect(s.list().map((o) => o.id)).toEqual(['theirs-0001'])
    expect(h.undo()).toBeNull()
    apply(h.redo()!)
    apply(h.redo()!)
    expect(s.get('stroke-0001')).toMatchObject({ kind: 'pen', x: 40, color: '#30a46c' })
    expect(h.canRedo).toBe(false)
    // Undoing a delete brings the object back; a new change clears redo.
    mine([{ id: 'stroke-0001', p: { d: true } }])
    expect(s.list().map((o) => o.id)).toEqual(['theirs-0001'])
    apply(h.undo()!)
    expect(s.list().map((o) => o.id).sort()).toEqual(['stroke-0001', 'theirs-0001'])
    mine([{ id: 'stroke-0001', p: { x: 1 } }])
    expect(h.canRedo).toBe(false)
  })

  it('encodes strokes compactly and simplifies them', () => {
    const points = Array.from({ length: 200 }, (_, i) => ({ x: 10 + i * 0.5, y: 20 + Math.sin(i / 20) * 15 }))
    const kept = simplify(points, 0.5)
    expect(kept.length).toBeLessThan(40)
    const pts = encodePoints(kept, 10, 20)
    const back = decodePoints({ kind: 'pen', x: 10, y: 20, pts })
    expect(back[0]).toBeCloseTo(kept[0].x, 1)
    expect(back[back.length - 1]).toBeCloseTo(kept[kept.length - 1].y, 1)
    expect(pts.every(Number.isInteger)).toBe(true)
  })

  it('hit-tests strokes, shapes and notes', () => {
    const line: Props = { kind: 'line', x: 0, y: 0, w: 100, h: 0, size: 2 }
    expect(hits(line, { x: 50, y: 2 }, 2)).toBe(true)
    expect(hits(line, { x: 50, y: 20 }, 2)).toBe(false)
    const rect: Props = { kind: 'rect', x: 0, y: 0, w: 100, h: 100, size: 2 }
    expect(hits(rect, { x: 1, y: 50 }, 3)).toBe(true)
    expect(hits(rect, { x: 50, y: 50 }, 3)).toBe(false) // an outline isn't hit in the middle
    expect(hits({ ...rect, fill: '#ffffff' }, { x: 50, y: 50 }, 3)).toBe(true)
    expect(hits({ kind: 'note', x: 0, y: 0, w: 100, h: 100 }, { x: 50, y: 50 }, 0)).toBe(true)
    expect(hits({ kind: 'pen', x: 0, y: 0, pts: [0, 0, 1000, 0], size: 4 }, { x: 50, y: 1 }, 1)).toBe(true)
  })

  it('splits big changes into batches the server takes', () => {
    const ops = Array.from({ length: 450 }, (_, i) => pen(`stroke-${String(i).padStart(4, '0')}`))
    const parts = batches(ops)
    expect(parts.length).toBe(3)
    expect(parts.flat()).toHaveLength(450)
    expect(parts.every((p) => p.length <= 200 && JSON.stringify(p).length < 48 * 1024)).toBe(true)
  })

  it('checks live cursors from others', () => {
    expect(checkLive({ x: 1, y: 2, tool: 'pen' })).toEqual({ x: 1, y: 2, tool: 'pen' })
    expect(checkLive({ x: 'a', y: 2 })).toBeNull()
    const live = checkLive({ x: 1, y: 2, draft: { id: 'a', kind: 'pen', color: '#1f2328', size: 3, from: 0, pts: [1, 2] } })
    expect(live?.draft?.pts).toEqual([1, 2])
    expect(checkLive({ x: 1, y: 2, draft: { id: 'a', kind: 'rect', color: 'red', size: 3, from: 0, pts: [] } })?.draft).toBeUndefined()
  })

  it('keeps 5,000 strokes quick to fold and list', () => {
    const s = new BoardState()
    const ops = Array.from({ length: 5000 }, (_, i) => ({ id: `stroke-${String(i).padStart(5, '0')}`, p: { kind: 'pen' as const, x: i % 100, y: i / 100, pts: Array.from({ length: 60 }, (_, j) => j % 7), color: '#1f2328', size: 3, z: i } }))
    const start = performance.now()
    for (const part of batches(ops)) s.applyConfirmed(part)
    expect(s.list()).toHaveLength(5000)
    s.applyConfirmed([{ id: 'stroke-00001', p: { x: 5 } }])
    expect(s.list()).toHaveLength(5000)
    expect(performance.now() - start).toBeLessThan(2000)
  })
})

describe('encrypted boards', () => {
  it('seals batches to one channel, board and purpose', () => {
    const [alice, bob, eve] = [createIdentity(), createIdentity(), createIdentity()]
    const chain = newChainId()
    const view = verifyChannelChain(chain, [signChannelChange(alice, null, chain, 'create', [b64u(bob.account.publicKey)])])
    const key = newEpochKey()
    const place = { channel: 7, board: 'board-1' }
    const env = sealBoard(alice, view, key, place, 'ops', { ops: [pen('stroke-0001')] })
    const from = b64u(alice.account.publicKey)
    const opened = openBoard(env, from, place, 'ops', view, () => key)
    expect((opened.content as { ops: Op[] }).ops[0].id).toBe('stroke-0001')
    expect(JSON.stringify(env)).not.toContain('stroke-0001')
    // Moved to another board or channel, used as another purpose, claimed by someone else, tampered, or no key: refused.
    expect(() => openBoard(env, from, { channel: 7, board: 'board-2' }, 'ops', view, () => key)).toThrow()
    expect(() => openBoard(env, from, { channel: 8, board: 'board-1' }, 'ops', view, () => key)).toThrow()
    expect(() => openBoard(env, from, place, 'snapshot', view, () => key)).toThrow()
    expect(() => openBoard(env, b64u(bob.account.publicKey), place, 'ops', view, () => key)).toThrow()
    expect(() => openBoard({ ...env, ct: env.ct.slice(0, -2) + 'AA' }, from, place, 'ops', view, () => key)).toThrow()
    expect(() => openBoard(env, from, place, 'ops', view, () => undefined)).toThrow()
    // Someone outside the chain can't seal for it.
    expect(() => sealBoard(eve, view, key, place, 'ops', {})).toThrow()
    // Snapshots carry the seq they cover, signed.
    const snap = sealBoard(alice, view, key, place, 'snapshot', { objects: {} }, 12)
    expect(openBoard(snap, from, place, 'snapshot', view, () => key).header.seq).toBe(12)
  })
})
