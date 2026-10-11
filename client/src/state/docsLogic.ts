// Docs pages, the pure parts: the page tree, moving pages, and line diffs and three-way merges for when two people
// edited the same page (state/docs.ts and ui/docs use these).
import type { DocPage } from '../core/protocol'

// ── The page list ───────────────────────────────────────────────────────────

/** Adds or replaces a page (without its text) in a list. */
export function upsertPage(pages: DocPage[], page: DocPage): DocPage[] {
  const { text: _text, ...summary } = page
  const index = pages.findIndex((p) => p.id === page.id)
  return index < 0 ? [...pages, summary] : pages.map((p, i) => (i === index ? summary : p))
}

export interface PageNode {
  page: DocPage
  children: DocPage[]
}

const byPosition = (a: DocPage, b: DocPage) => a.position - b.position || a.id - b.id

/** Top-level pages in order, each with its sub-pages in order. Sub-pages whose parent is missing show at the top. */
export function pageTree(pages: DocPage[]): PageNode[] {
  const ids = new Set(pages.map((p) => p.id))
  const top = pages.filter((p) => p.parentId === null || !ids.has(p.parentId)).sort(byPosition)
  return top.map((page) => ({ page, children: pages.filter((p) => p.parentId === page.id).sort(byPosition) }))
}

/** Pages in reading order (each top-level page, then its sub-pages). */
export const readingOrder = (pages: DocPage[]): DocPage[] => pageTree(pages).flatMap((n) => [n.page, ...n.children])

/** Where "Move up" / "Move down" puts a page: the `before` for docs.page.move (null: last), or undefined if it can't move. */
export function moveTarget(pages: DocPage[], pageId: number, direction: -1 | 1): { parentId: number | null; before: number | null } | undefined {
  const page = pages.find((p) => p.id === pageId)
  if (!page) return undefined
  const siblings = pages.filter((p) => p.parentId === page.parentId).sort(byPosition)
  const index = siblings.findIndex((p) => p.id === pageId)
  const target = index + direction
  if (target < 0 || target >= siblings.length) return undefined
  // Moving down: before the page after the next one (or last).
  const before = direction < 0 ? siblings[target].id : siblings[target + 1]?.id ?? null
  return { parentId: page.parentId, before }
}

/** Search a page list by title (ignoring case and accents), for the sidebar filter and the link picker. */
export function filterPages(pages: DocPage[], query: string): DocPage[] {
  const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (!words.length) return readingOrder(pages)
  return readingOrder(pages).filter((p) => words.every((w) => fold(p.title).includes(w)))
}

// ── Diffs ───────────────────────────────────────────────────────────────────

export type DiffLine = { kind: 'same' | 'added' | 'removed'; text: string }

/** A change to `a`: lines [aStart, aEnd) become `lines`. */
interface Hunk {
  aStart: number
  aEnd: number
  lines: string[]
}

/** Above this many cells, the changed middle is shown as one replaced block instead of a line-by-line diff. */
const MAX_CELLS = 4_000_000

/** Line diff of `a` → `b` (longest common subsequence, after trimming the shared start and end). */
export function diffLines(a: string[], b: string[]): DiffLine[] {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const out: DiffLine[] = a.slice(0, start).map((text) => ({ kind: 'same', text }))
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  if (midA.length * midB.length > MAX_CELLS) {
    out.push(...midA.map((text) => ({ kind: 'removed' as const, text })), ...midB.map((text) => ({ kind: 'added' as const, text })))
  } else {
    // lcs[i][j]: common length of midA[i..] and midB[j..], in one flat array.
    const w = midB.length + 1
    const lcs = new Uint32Array((midA.length + 1) * w)
    for (let i = midA.length - 1; i >= 0; i--) {
      for (let j = midB.length - 1; j >= 0; j--) {
        lcs[i * w + j] = midA[i] === midB[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < midA.length || j < midB.length) {
      if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
        out.push({ kind: 'same', text: midA[i] })
        i++
        j++
      } else if (i < midA.length && (j >= midB.length || lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) {
        out.push({ kind: 'removed', text: midA[i++] }) // removals before additions, as diffs usually show them
      } else {
        out.push({ kind: 'added', text: midB[j++] })
      }
    }
  }
  out.push(...a.slice(endA).map((text) => ({ kind: 'same' as const, text })))
  return out
}

/** The changes from `a` to `b`, as hunks over `a`'s lines. */
function hunks(a: string[], b: string[]): Hunk[] {
  const result: Hunk[] = []
  let pos = 0
  let open: Hunk | null = null
  for (const line of diffLines(a, b)) {
    if (line.kind === 'same') {
      if (open) result.push(open)
      open = null
      pos++
      continue
    }
    open ??= { aStart: pos, aEnd: pos, lines: [] }
    if (line.kind === 'removed') {
      open.aEnd++
      pos++
    } else {
      open.lines.push(line.text)
    }
  }
  if (open) result.push(open)
  return result
}

/** Base lines [start, end) with one side's hunks in that range applied. */
function applyRange(base: string[], changes: Hunk[], start: number, end: number): string[] {
  const out: string[] = []
  let pos = start
  for (const h of changes) {
    out.push(...base.slice(pos, h.aStart), ...h.lines)
    pos = h.aEnd
  }
  out.push(...base.slice(pos, end))
  return out
}

export const CONFLICT_MINE = '<<<<<<< Your version'
export const CONFLICT_SPLIT = '======='
export const CONFLICT_THEIRS = '>>>>>>> Their version'

export interface MergeResult {
  text: string
  /** Places where both changed the same lines differently (marked in `text`). */
  conflicts: number
}

/**
 * Three-way merge by lines: changes from `base` to `mine` and to `theirs` that don't touch the same lines both apply.
 * Where they do (and differ), both versions go in, between conflict markers.
 */
export function merge3(base: string, mine: string, theirs: string): MergeResult {
  if (mine === theirs) return { text: mine, conflicts: 0 }
  if (mine === base) return { text: theirs, conflicts: 0 }
  if (theirs === base) return { text: mine, conflicts: 0 }
  const b = base.split('\n')
  const ours = hunks(b, mine.split('\n')).map((h) => ({ ...h, side: 0 }))
  const other = hunks(b, theirs.split('\n')).map((h) => ({ ...h, side: 1 }))
  const all = [...ours, ...other].sort((x, y) => x.aStart - y.aStart || x.aEnd - y.aEnd)
  const out: string[] = []
  let conflicts = 0
  let pos = 0
  for (let i = 0; i < all.length; ) {
    // A cluster: hunks that overlap or touch (from either side).
    let end = all[i].aEnd
    const start = all[i].aStart
    let j = i + 1
    // Both adding lines at the same spot counts as touching too (so the same addition isn't doubled).
    const sameInsert = (k: number) => all[k].aStart === end && all[k].aEnd === end && all[k - 1].aStart === end && all[k - 1].aEnd === end
    while (j < all.length && (all[j].aStart < end || sameInsert(j))) {
      end = Math.max(end, all[j].aEnd)
      j++
    }
    const cluster = all.slice(i, j)
    out.push(...b.slice(pos, start))
    const mineSide = cluster.filter((h) => h.side === 0)
    const theirSide = cluster.filter((h) => h.side === 1)
    const mineLines = applyRange(b, mineSide, start, end)
    const theirLines = applyRange(b, theirSide, start, end)
    if (!theirSide.length || mineLines.join('\n') === theirLines.join('\n')) out.push(...mineLines)
    else if (!mineSide.length) out.push(...theirLines)
    else {
      conflicts++
      out.push(CONFLICT_MINE, ...mineLines, CONFLICT_SPLIT, ...theirLines, CONFLICT_THEIRS)
    }
    pos = end
    i = j
  }
  out.push(...b.slice(pos))
  return { text: out.join('\n'), conflicts }
}

/** Whether text still has conflict markers from a merge. */
export const hasConflictMarkers = (text: string) =>
  text.split('\n').some((line) => line === CONFLICT_MINE || line === CONFLICT_THEIRS)

/** How many lines were added and removed between two texts. */
export function changeCounts(from: string, to: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of diffLines(from.split('\n'), to.split('\n'))) {
    if (line.kind === 'added') added++
    else if (line.kind === 'removed') removed++
  }
  return { added, removed }
}

// ── Markdown helpers for the editor ─────────────────────────────────────────

/** A server file path pages may show as a picture: "/files/<id>/<name>" on this server, nothing else. */
export const FILE_PATH = /^\/files\/[A-Za-z0-9_-]{16,64}\/[^\s<>"'()]*$/

/** A picture's Markdown for an uploaded file. */
export const imageMarkdown = (name: string, url: string) => `![${name.replace(/[[\]\n]/g, '').slice(0, 100)}](${url})`

/** A starter table for the toolbar. */
export const TABLE_TEMPLATE = '| Column | Column |\n| --- | --- |\n| Cell | Cell |'
