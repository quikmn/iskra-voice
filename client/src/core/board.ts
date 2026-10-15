// Whiteboards: the board model. See "Whiteboards" in protocol/PROTOCOL.md.
//
// A board is a map of objects, each a flat record of fields. A change is an op: an object id and the fields to set
// (null removes one). The server orders batches of ops (seq), so every app folds the same ops in the same order: each
// field is a last-writer-wins register. Ops this app sent but hasn't seen come back yet stay "pending" on top of the
// confirmed board, so drawing feels instant and still ends up exactly where everyone else is.
//
// Undo is per person: every local change records the fields it overwrote, and undo sends them back.
// No DOM here (the bot SDK and tests use it): rendering lives in ui/whiteboard.

export type BoardKind = 'pen' | 'hl' | 'line' | 'arrow' | 'rect' | 'ellipse' | 'text' | 'note' | 'image'
export const BOARD_KINDS: readonly BoardKind[] = ['pen', 'hl', 'line', 'arrow', 'rect', 'ellipse', 'text', 'note', 'image']

export interface Props {
  kind?: BoardKind
  x?: number
  y?: number
  w?: number
  h?: number
  /** Pen and highlighter: whole tenths relative to (x, y): first point, then steps. */
  pts?: number[]
  color?: string
  fill?: string
  size?: number
  text?: string
  src?: string
  z?: number
  d?: boolean
}

export type Field = keyof Props
export type Patch = { [K in Field]?: Props[K] | null }

export interface Op {
  id: string
  p: Patch
}

export const MAX_OPS_PER_BATCH = 200
export const MAX_BATCH_CHARS = 48 * 1024
export const MAX_TEXT = 2000
export const MAX_POINTS = 4000
const MAX_COORD = 1_000_000
const MAX_POINT = 10_000_000
const MAX_Z = 1_000_000_000
const FIELDS: readonly Field[] = ['kind', 'x', 'y', 'w', 'h', 'pts', 'color', 'fill', 'size', 'text', 'src', 'z', 'd']
const ID = /^[A-Za-z0-9_-]{8,24}$/
const COLOR = /^#[0-9a-f]{6}$/
const SRC = /^\/files\/[A-Za-z0-9_-]{16,64}\/[^/?#\s]{1,255}$/

export class BoardError extends Error {}

const num = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max

function checkField(name: string, v: unknown): void {
  if (v === null) {
    if (!FIELDS.includes(name as Field)) throw new BoardError(`Unknown field ${name}`)
    return
  }
  const ok = (() => {
    switch (name) {
      case 'kind': return BOARD_KINDS.includes(v as BoardKind)
      case 'x': case 'y': case 'w': case 'h': return num(v, -MAX_COORD, MAX_COORD)
      case 'size': return num(v, 1, 200)
      case 'z': return num(v, -MAX_Z, MAX_Z)
      case 'pts': return Array.isArray(v) && v.length >= 2 && v.length <= MAX_POINTS && v.length % 2 === 0
        && v.every((n) => Number.isSafeInteger(n) && Math.abs(n) <= MAX_POINT)
      case 'color': case 'fill': return typeof v === 'string' && COLOR.test(v)
      // eslint-disable-next-line no-control-regex
      case 'text': return typeof v === 'string' && v.length <= MAX_TEXT && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(v)
      case 'src': return typeof v === 'string' && SRC.test(v)
      case 'd': return typeof v === 'boolean'
      default: return false
    }
  })()
  if (!ok) throw new BoardError(`Bad value for ${name}`)
}

/** Checks ops as the server does (encrypted boards: the apps are the only check). Throws {@link BoardError}. */
export function checkOps(ops: unknown): Op[] {
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > MAX_OPS_PER_BATCH) throw new BoardError('Bad batch')
  for (const op of ops) {
    if (!op || typeof op !== 'object' || Array.isArray(op)) throw new BoardError('Bad op')
    const keys = Object.keys(op)
    const { id, p } = op as { id?: unknown; p?: unknown }
    if (keys.some((k) => k !== 'id' && k !== 'p') || typeof id !== 'string' || !ID.test(id)) throw new BoardError('Bad op')
    if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).length === 0) throw new BoardError('Bad op')
    for (const [name, v] of Object.entries(p)) checkField(name, v)
  }
  return ops as Op[]
}

/** A fresh object id (16 characters of base64url). */
export function newObjectId(): string {
  const bytes = new Uint8Array(12)
  globalThis.crypto.getRandomValues(bytes)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// ── Geometry ────────────────────────────────────────────────────────────────

export interface Point { x: number; y: number }
export interface Rect { x0: number; y0: number; x1: number; y1: number }

/** Absolute points of a pen stroke as [x0, y0, x1, y1, …]. */
export function decodePoints(o: Props): number[] {
  const pts = o.pts ?? []
  const out: number[] = []
  let x = 0
  let y = 0
  for (let i = 0; i + 1 < pts.length; i += 2) {
    x += pts[i]
    y += pts[i + 1]
    out.push((o.x ?? 0) + x / 10, (o.y ?? 0) + y / 10)
  }
  return out
}

/** Points relative to (ox, oy), as whole tenths: the first point, then steps. */
export function encodePoints(points: Point[], ox: number, oy: number): number[] {
  const out: number[] = []
  let px = 0
  let py = 0
  for (const p of points) {
    const x = Math.round((p.x - ox) * 10)
    const y = Math.round((p.y - oy) * 10)
    out.push(x - px, y - py)
    px = x
    py = y
  }
  return out
}

/** Ramer–Douglas–Peucker: drops points closer than `tolerance` to the line between their neighbours. */
export function simplify(points: Point[], tolerance: number): Point[] {
  if (points.length <= 2) return points.slice()
  const keep = new Uint8Array(points.length)
  keep[0] = keep[points.length - 1] = 1
  const stack: [number, number][] = [[0, points.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    let best = -1
    let far = tolerance
    for (let i = a + 1; i < b; i++) {
      const d = segmentDistance(points[i], points[a], points[b])
      if (d > far) {
        far = d
        best = i
      }
    }
    if (best >= 0) {
      keep[best] = 1
      stack.push([a, best], [best, b])
    }
  }
  return points.filter((_, i) => keep[i])
}

export function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = dx * dx + dy * dy
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** Lines of text and an estimate of their size (the canvas measures exactly; this is for bounds and hits). */
export function textBox(o: Props): { w: number; h: number } {
  const size = o.size ?? 20
  const lines = (o.text ?? '').split('\n')
  const longest = Math.max(1, ...lines.map((l) => l.length))
  return { w: longest * size * 0.6, h: lines.length * size * 1.25 }
}

const norm = (x: number, y: number, w: number, h: number): Rect => ({ x0: Math.min(x, x + w), y0: Math.min(y, y + h), x1: Math.max(x, x + w), y1: Math.max(y, y + h) })

/** Where an object is on the board (strokes include their width). */
export function bounds(o: Props): Rect {
  const pad = (o.size ?? 2) / 2
  switch (o.kind) {
    case 'pen': case 'hl': {
      const pts = decodePoints(o)
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (let i = 0; i < pts.length; i += 2) {
        x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i])
        y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1])
      }
      if (!Number.isFinite(x0)) return { x0: o.x ?? 0, y0: o.y ?? 0, x1: o.x ?? 0, y1: o.y ?? 0 }
      return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad }
    }
    case 'text': {
      const box = textBox(o)
      return norm(o.x ?? 0, o.y ?? 0, box.w, box.h)
    }
    case 'line': case 'arrow': case 'rect': case 'ellipse': {
      const r = norm(o.x ?? 0, o.y ?? 0, o.w ?? 0, o.h ?? 0)
      return { x0: r.x0 - pad, y0: r.y0 - pad, x1: r.x1 + pad, y1: r.y1 + pad }
    }
    default:
      return norm(o.x ?? 0, o.y ?? 0, o.w ?? 0, o.h ?? 0)
  }
}

export const intersects = (a: Rect, b: Rect) => a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0

/** Whether (x, y) touches the object, within `slop` board units. */
export function hits(o: Props, p: Point, slop: number): boolean {
  const b = bounds(o)
  if (p.x < b.x0 - slop || p.x > b.x1 + slop || p.y < b.y0 - slop || p.y > b.y1 + slop) return false
  const reach = slop + (o.size ?? 2) / 2
  switch (o.kind) {
    case 'pen': case 'hl': {
      const pts = decodePoints(o)
      if (pts.length === 2) return Math.hypot(p.x - pts[0], p.y - pts[1]) <= reach
      for (let i = 2; i < pts.length; i += 2) {
        if (segmentDistance(p, { x: pts[i - 2], y: pts[i - 1] }, { x: pts[i], y: pts[i + 1] }) <= reach) return true
      }
      return false
    }
    case 'line': case 'arrow':
      return segmentDistance(p, { x: o.x ?? 0, y: o.y ?? 0 }, { x: (o.x ?? 0) + (o.w ?? 0), y: (o.y ?? 0) + (o.h ?? 0) }) <= reach
    case 'ellipse': {
      const r = norm(o.x ?? 0, o.y ?? 0, o.w ?? 0, o.h ?? 0)
      const rx = Math.max(1, (r.x1 - r.x0) / 2)
      const ry = Math.max(1, (r.y1 - r.y0) / 2)
      const nx = (p.x - (r.x0 + rx)) / (rx + reach)
      const ny = (p.y - (r.y0 + ry)) / (ry + reach)
      if (nx * nx + ny * ny > 1) return false
      if (o.fill) return true
      const ix = (p.x - (r.x0 + rx)) / Math.max(1, rx - reach)
      const iy = (p.y - (r.y0 + ry)) / Math.max(1, ry - reach)
      return ix * ix + iy * iy >= 1
    }
    case 'rect': {
      if (o.fill) return true
      const r = norm(o.x ?? 0, o.y ?? 0, o.w ?? 0, o.h ?? 0)
      return Math.min(Math.abs(p.x - r.x0), Math.abs(p.x - r.x1), Math.abs(p.y - r.y0), Math.abs(p.y - r.y1)) <= reach
    }
    default:
      return true
  }
}

/** Moves an object by (dx, dy): the fields to set. */
export function moved(o: Props, dx: number, dy: number): Patch {
  return { x: round((o.x ?? 0) + dx), y: round((o.y ?? 0) + dy) }
}

export const round = (n: number) => Math.round(n * 10) / 10

// ── The board state ─────────────────────────────────────────────────────────

export interface Shown extends Props {
  id: string
}

export const isShown = (o: Props | undefined): o is Props & { kind: BoardKind } => !!o && !!o.kind && o.d !== true

function applyPatch(target: Props | undefined, patch: Patch): Props {
  const next: Props = { ...target }
  for (const [k, v] of Object.entries(patch) as [Field, unknown][]) {
    if (v === null || v === undefined) delete next[k]
    else (next as Record<string, unknown>)[k] = v
  }
  return next
}

interface PendingBatch {
  cid: string
  ops: Op[]
}

/**
 * The board as this app shows it: the confirmed board (server order) with this app's pending batches on top.
 * Objects are immutable records, replaced on every change (renderers cache by identity).
 */
export class BoardState {
  private confirmed = new Map<string, Props>()
  private pending: PendingBatch[] = []
  private shown = new Map<string, Props>()
  private sorted: Shown[] | null = null
  /** One Shown per record, so renderers can cache paths and bounds by identity. */
  private shownOf = new WeakMap<Props, Shown>()
  /** Bumped on every change, for renderers. */
  revision = 0
  maxZ = 0

  /** Replaces everything with a snapshot (pending batches stay on top). */
  load(objects: Record<string, Props>): void {
    this.confirmed = new Map(Object.entries(objects))
    this.rebuild()
  }

  clear(): void {
    this.confirmed.clear()
    this.pending = []
    this.rebuild()
  }

  /** Confirmed ops, in server order. Ops of this app's own batch `cid` stop being pending. */
  applyConfirmed(ops: Op[], cid?: string): void {
    const touched = new Set<string>()
    for (const op of ops) {
      this.confirmed.set(op.id, applyPatch(this.confirmed.get(op.id), op.p))
      touched.add(op.id)
    }
    if (cid) {
      const i = this.pending.findIndex((b) => b.cid === cid)
      if (i >= 0) for (const op of this.pending.splice(i, 1)[0].ops) touched.add(op.id)
    }
    this.refresh(touched)
  }

  /** A local change, shown at once and sent as batch `cid`. */
  addPending(cid: string, ops: Op[]): void {
    this.pending.push({ cid, ops })
    this.refresh(new Set(ops.map((o) => o.id)))
  }

  /** A batch the server refused: it no longer shows. */
  dropPending(cid: string): void {
    const i = this.pending.findIndex((b) => b.cid === cid)
    if (i < 0) return
    const [batch] = this.pending.splice(i, 1)
    this.refresh(new Set(batch.ops.map((o) => o.id)))
  }

  pendingCount(): number {
    return this.pending.length
  }

  get(id: string): Props | undefined {
    return this.shown.get(id)
  }

  /** The confirmed board only (for snapshots of encrypted boards), without deleted objects. */
  confirmedObjects(): Record<string, Props> {
    const out: Record<string, Props> = {}
    for (const [id, o] of this.confirmed) if (isShown(o)) out[id] = o
    return out
  }

  /** Visible objects, bottom to top. */
  list(): Shown[] {
    if (!this.sorted) {
      this.sorted = []
      for (const [id, o] of this.shown) {
        if (!isShown(o)) continue
        let shown = this.shownOf.get(o)
        if (!shown) {
          shown = { ...o, id }
          this.shownOf.set(o, shown)
        }
        this.sorted.push(shown)
      }
      this.sorted.sort((a, b) => (a.z ?? 0) - (b.z ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    }
    return this.sorted
  }

  private rebuild(): void {
    this.shown.clear()
    const ids = new Set([...this.confirmed.keys(), ...this.pending.flatMap((b) => b.ops.map((o) => o.id))])
    this.refresh(ids)
  }

  private refresh(ids: Set<string>): void {
    for (const id of ids) {
      let o = this.confirmed.get(id)
      for (const batch of this.pending) for (const op of batch.ops) if (op.id === id) o = applyPatch(o, op.p)
      if (o) {
        this.shown.set(id, o)
        if (isShown(o) && (o.z ?? 0) > this.maxZ) this.maxZ = o.z ?? 0
      } else this.shown.delete(id)
    }
    this.sorted = null
    this.revision++
  }
}

// ── Undo and redo (per person) ──────────────────────────────────────────────

interface Step {
  undo: Op[]
  redo: Op[]
}

/**
 * This person's changes, newest last. Each step keeps the fields it overwrote; undoing sends those back (an object it
 * made loses its kind, so it's gone), redoing sends the change again. Other people's changes are never undone.
 */
export class History {
  private done: Step[] = []
  private undone: Step[] = []
  private readonly limit: number
  constructor(limit = 200) {
    this.limit = limit
  }

  /** Records `ops` about to be applied to `state` (call before applying them). */
  record(state: BoardState, ops: Op[]): void {
    const undo: Op[] = []
    for (const op of ops) {
      const before = state.get(op.id)
      const p: Patch = {}
      for (const k of Object.keys(op.p) as Field[]) (p as Record<string, unknown>)[k] = before?.[k] ?? null
      undo.push({ id: op.id, p })
    }
    this.done.push({ undo: undo.reverse(), redo: ops })
    if (this.done.length > this.limit) this.done.shift()
    this.undone = []
  }

  get canUndo(): boolean {
    return this.done.length > 0
  }

  get canRedo(): boolean {
    return this.undone.length > 0
  }

  /** The ops that undo the last step (null: nothing to undo). */
  undo(): Op[] | null {
    const step = this.done.pop()
    if (!step) return null
    this.undone.push(step)
    return step.undo
  }

  redo(): Op[] | null {
    const step = this.undone.pop()
    if (!step) return null
    this.done.push(step)
    return step.redo
  }

  clear(): void {
    this.done = []
    this.undone = []
  }
}

/** Splits ops into batches the server takes (≤ 200 ops, ≤ ~40 KB each). */
export function batches(ops: Op[]): Op[][] {
  const out: Op[][] = []
  let current: Op[] = []
  let size = 2
  for (const op of ops) {
    const len = JSON.stringify(op).length + 1
    if (current.length && (current.length >= MAX_OPS_PER_BATCH || size + len > MAX_BATCH_CHARS - 8 * 1024)) {
      out.push(current)
      current = []
      size = 2
    }
    current.push(op)
    size += len
  }
  if (current.length) out.push(current)
  return out
}

// ── Live cursors ────────────────────────────────────────────────────────────

export interface LiveDraft {
  id: string
  kind: BoardKind
  color: string
  size: number
  /** Index of the first point in `pts` (points are [x, y] pairs in board units). */
  from: number
  pts: number[]
}

export interface Live {
  x: number
  y: number
  tool?: string
  draft?: LiveDraft
}

/** A live cursor from someone else, checked (null: not usable). */
export function checkLive(v: unknown): Live | null {
  if (!v || typeof v !== 'object') return null
  const l = v as Partial<Live>
  if (!num(l.x, -1e7, 1e7) || !num(l.y, -1e7, 1e7)) return null
  const out: Live = { x: l.x, y: l.y, ...(typeof l.tool === 'string' && l.tool.length <= 16 ? { tool: l.tool } : {}) }
  const d = l.draft
  if (d && typeof d === 'object' && typeof d.id === 'string' && d.id.length <= 24 && (d.kind === 'pen' || d.kind === 'hl')
    && typeof d.color === 'string' && COLOR.test(d.color) && num(d.size, 1, 200) && Number.isSafeInteger(d.from) && d.from >= 0 && d.from < 100_000
    && Array.isArray(d.pts) && d.pts.length <= 2000 && d.pts.every((n) => num(n, -1e7, 1e7))) {
    out.draft = { id: d.id, kind: d.kind, color: d.color, size: d.size, from: d.from, pts: d.pts }
  }
  return out
}
