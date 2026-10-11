// Docs pages: the message Markdown (ui/markdown.tsx) plus what longer documents need: tables, pictures from this
// server's uploads ("![alt](/files/…)" on a line of its own) and horizontal rules. Rendered straight to React elements.
import type { ReactNode } from 'react'
import { renderInline, renderMarkdown, type MarkdownContext } from '../markdown'
import { FILE_PATH } from '../../state/docsLogic'

export interface DocContext extends MarkdownContext {
  /** The server's address, for pictures ("/files/…" paths are relative to it). */
  serverUrl: string
}

type Align = 'left' | 'center' | 'right' | undefined

const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_SEPARATOR = /^\s*\|?(\s*:?-{3,}:?\s*\|)+(\s*:?-{3,}:?\s*)?\|?\s*$/
const IMAGE = /^!\[([^\]\n]{0,200})\]\(([^\s)]+)\)$/
const RULE = /^(-{3,}|\*{3,}|_{3,})$/
const FENCE = /^```/

/** "| a | b |" → ["a", "b"] (an escaped "\|" stays in its cell). */
export function tableCells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let cell = ''
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '\\' && inner[i + 1] === '|') {
      cell += '|'
      i++
    } else if (inner[i] === '|') {
      cells.push(cell.trim())
      cell = ''
    } else cell += inner[i]
  }
  cells.push(cell.trim())
  return cells
}

const alignOf = (cell: string): Align =>
  cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : undefined

export type DocBlock =
  | { kind: 'markdown'; text: string }
  | { kind: 'table'; head: string[]; align: Align[]; rows: string[][] }
  | { kind: 'image'; alt: string; path: string }
  | { kind: 'rule' }

/** Splits a page into blocks: tables, pictures and rules of its own, everything else as message Markdown. */
export function docBlocks(text: string): DocBlock[] {
  const lines = text.split('\n')
  const blocks: DocBlock[] = []
  let chunk: string[] = []
  let fenced = false
  const flush = () => {
    if (chunk.length) blocks.push({ kind: 'markdown', text: chunk.join('\n') })
    chunk = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (FENCE.test(line.trim())) fenced = !fenced
    if (fenced || FENCE.test(line.trim())) {
      chunk.push(line)
      continue
    }
    if (TABLE_ROW.test(line) && TABLE_SEPARATOR.test(lines[i + 1] ?? '')) {
      flush()
      const head = tableCells(line)
      const align = tableCells(lines[i + 1]).map(alignOf)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && TABLE_ROW.test(lines[i])) rows.push(tableCells(lines[i++]))
      i--
      blocks.push({ kind: 'table', head, align, rows: rows.map((r) => head.map((_, c) => r[c] ?? '')) })
      continue
    }
    const image = IMAGE.exec(line.trim())
    if (image && FILE_PATH.test(image[2])) {
      flush()
      blocks.push({ kind: 'image', alt: image[1], path: image[2] })
      continue
    }
    if (RULE.test(line.trim())) {
      flush()
      blocks.push({ kind: 'rule' })
      continue
    }
    // A blank line ends a paragraph (spacing between blocks comes from CSS).
    if (line.trim() === '') {
      flush()
      continue
    }
    chunk.push(line)
  }
  flush()
  return blocks.map((b) => (b.kind === 'markdown' ? { ...b, text: b.text.replace(/\n+$/, '') } : b)).filter((b) => b.kind !== 'markdown' || b.text !== '')
}

/** The page's headings ("#", "##", "###" outside code), for the outline. */
export function docHeadings(text: string): { level: number; text: string; index: number }[] {
  const out: { level: number; text: string; index: number }[] = []
  let fenced = false
  text.split('\n').forEach((line) => {
    if (FENCE.test(line.trim())) fenced = !fenced
    const m = !fenced ? /^(#{1,3}) (\S.*)$/.exec(line) : null
    if (m) out.push({ level: m[1].length, text: m[2], index: out.length })
  })
  return out
}

export function renderDoc(text: string, ctx: DocContext): ReactNode {
  return docBlocks(text).map((block, i) => {
    switch (block.kind) {
      case 'markdown':
        return <div key={i} className="doc-block message-text">{renderMarkdown(block.text, ctx)}</div>
      case 'rule':
        return <hr key={i} className="doc-rule" />
      case 'image':
        return (
          <figure key={i} className="doc-figure">
            <img src={ctx.serverUrl + block.path} alt={block.alt} loading="lazy" referrerPolicy="no-referrer" />
            {block.alt && <figcaption>{block.alt}</figcaption>}
          </figure>
        )
      case 'table':
        return (
          <div key={i} className="doc-table-wrap">
            <table className="doc-table">
              <thead>
                <tr>{block.head.map((cell, c) => <th key={c} style={{ textAlign: block.align[c] }}>{renderInline(cell, ctx)}</th>)}</tr>
              </thead>
              <tbody>
                {block.rows.map((row, r) => (
                  <tr key={r}>{row.map((cell, c) => <td key={c} style={{ textAlign: block.align[c] }}>{renderInline(cell, ctx)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        )
    }
  })
}
