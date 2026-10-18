// GitHub-style tables in chat messages: "| a | b |" over "|---|:-:|". Pure parsing; markdown.tsx renders it.
// Too big a table (columns, rows, cell size) is not parsed at all, so it shows as the plain text it was typed as.

export type TableAlign = 'left' | 'center' | 'right' | undefined
export interface ParsedTable {
  head: string[]
  align: TableAlign[]
  rows: string[][]
  /** Index of the first line after the table. */
  end: number
}

export const MAX_TABLE_COLUMNS = 12
export const MAX_TABLE_ROWS = 60
export const MAX_CELL_LENGTH = 400

const ROW = /^\s*\|.*\|\s*$/
const SEPARATOR = /^\s*\|?(\s*:?-{3,}:?\s*\|)+(\s*:?-{3,}:?\s*)?\|?\s*$/

/** "| a | `b|c` | d\|e |" → ["a", "`b|c`", "d|e"]: pipes inside `code` or after a backslash don't split. */
export function tableCells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/(^|[^\\])\|$/, '$1')
  const cells: string[] = []
  let cell = ''
  for (let i = 0; i < inner.length; ) {
    const c = inner[i]
    if (c === '\\' &&inner[i + 1] === '|') {
      cell += '|'
      i += 2
    } else if (c === '`') {
      let n = 1
      while (inner[i + n] === '`') n++
      const ticks = '`'.repeat(n)
      const close = inner.indexOf(ticks, i + n)
      if (close === -1) {
        cell += ticks
        i += n
      } else {
        cell += inner.slice(i, close + n).replace(/\\\|/g, '|')
        i = close + n
      }
    } else if (c === '|') {
      cells.push(cell.trim())
      cell = ''
      i++
    } else {
      cell += c
      i++
    }
  }
  cells.push(cell.trim())
  return cells
}

const alignOf = (cell: string): TableAlign =>
  cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : undefined

/** A table starting at lines[start] (header row, separator row, body rows), or null if there is none (or it's over the limits). */
export function parseTable(lines: string[], start: number): ParsedTable | null {
  const first = lines[start]
  const sep = lines[start + 1]
  if (first === undefined || sep === undefined || !ROW.test(first) || !SEPARATOR.test(sep)) return null
  const head = tableCells(first)
  const align = tableCells(sep).map(alignOf)
  if (head.length !== align.length || head.length > MAX_TABLE_COLUMNS) return null
  const rows: string[][] = []
  let i = start + 2
  while (i < lines.length && ROW.test(lines[i])) {
    if (rows.length >= MAX_TABLE_ROWS) return null
    const cells = tableCells(lines[i++])
    rows.push(head.map((_, c) => cells[c] ?? ''))
  }
  if ([...head, ...rows.flat()].some((cell) => cell.length > MAX_CELL_LENGTH)) return null
  return { head, align, rows, end: i }
}
