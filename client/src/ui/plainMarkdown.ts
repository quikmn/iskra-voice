// Markdown markers out of short previews (search results, saved messages, docs hits): "**Game Night**" reads as
// "Game Night", a table row "| Game | Night |" as "Game · Night". Works on pieces of one text (highlighted search
// segments), so the highlights stay on the same words.

/** Per character: undefined keeps it, '' drops it, anything else replaces it. */
type Edits = (string | undefined)[]

const PAIRED = /(\*\*\*|\*\*|\*|__|~~|\|\||`+)(?=\S)([^\n]*?\S)\1/g
const LINK = /\[([^\]\n]+)\]\((?:https?:\/\/[^)\s]+)\)/g
const LINE_START = /^(?:#{1,3} |-# |>>> |> )/gm
const TABLE_ROW = /^[ \t]*\|.*\|[ \t]*$/gm
const TABLE_RULE = /^[ \t]*\|?[ \t:|-]*-{3,}[ \t:|-]*\|?[ \t]*$/
/** Mentions, custom emoji and timestamps (<@…>, <:name:id>, <t:…>): their insides are never markers. */
const TOKEN = /<[^<>\s]{1,100}>/g

function edits(text: string): Edits {
  const out: Edits = new Array(text.length)
  // A copy with tokens blanked out, same length, so positions match.
  const work = text.replace(TOKEN, (m) => ' '.repeat(m.length))
  const drop = (from: number, length: number) => {
    for (let i = from; i < from + length; i++) out[i] = ''
  }

  for (const row of work.matchAll(TABLE_ROW)) {
    const start = row.index
    const line = row[0]
    if (TABLE_RULE.test(line)) {
      // The |---|---| line under a header: gone, with its line break.
      drop(start, line.length + (text[start + line.length] === '\n' ? 1 : 0))
      continue
    }
    const first = line.indexOf('|')
    const last = line.lastIndexOf('|')
    for (let i = first; i <= last; i++) {
      if (line[i] !== '|') continue
      out[start + i] = i === first || i === last ? '' : '·'
    }
  }
  for (const m of work.matchAll(LINE_START)) drop(m.index, m[0].length)
  for (const m of work.matchAll(LINK)) {
    drop(m.index, 1)
    drop(m.index + 1 + m[1].length, m[0].length - 1 - m[1].length)
  }
  for (const m of work.matchAll(PAIRED)) {
    const marker = m[1].length
    drop(m.index, marker)
    drop(m.index + m[0].length - marker, marker)
  }
  return out
}

function apply(text: string, list: Edits, offset: number): string {
  let out = ''
  for (let i = 0; i < text.length; i++) out += list[offset + i] ?? text[i]
  return out
}

export function stripMarkdown(text: string): string {
  return apply(text, edits(text), 0)
}

/** The same, for consecutive pieces of one text; pieces left empty are dropped. */
export function stripMarkdownPieces<T extends { text: string }>(pieces: T[]): T[] {
  const list = edits(pieces.map((p) => p.text).join(''))
  let offset = 0
  const out: T[] = []
  for (const piece of pieces) {
    const text = apply(piece.text, list, offset)
    offset += piece.text.length
    if (text) out.push({ ...piece, text })
  }
  return out
}
