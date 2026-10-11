// Toolbar edits in the page editor: pure functions from (text, selection) to (text, selection), so they're testable.

export interface Edit {
  text: string
  start: number
  end: number
}

/** "**bold**" around the selection (or a placeholder); undoes it when the selection is already wrapped. */
export function wrap(text: string, start: number, end: number, before: string, after = before, placeholder = ''): Edit {
  const selected = text.slice(start, end)
  if (text.slice(start - before.length, start) === before && text.slice(end, end + after.length) === after) {
    return { text: text.slice(0, start - before.length) + selected + text.slice(end + after.length), start: start - before.length, end: end - before.length }
  }
  const inner = selected || placeholder
  const next = text.slice(0, start) + before + inner + after + text.slice(end)
  return { text: next, start: start + before.length, end: start + before.length + inner.length }
}

/** Puts `prefix` before every selected line ("- ", "> ", "## "); numbered lists count up. Undoes it when every line has it. */
export function prefixLines(text: string, start: number, end: number, prefix: string): Edit {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1
  const nextBreak = text.indexOf('\n', Math.max(end - (end > start && text[end - 1] === '\n' ? 1 : 0), start))
  const lineEnd = nextBreak < 0 ? text.length : nextBreak
  const lines = text.slice(lineStart, lineEnd).split('\n')
  const numbered = prefix === '1. '
  const marker = (i: number) => (numbered ? `${i + 1}. ` : prefix)
  const has = (line: string, i: number) => (numbered ? /^\d{1,9}\. /.test(line) : line.startsWith(marker(i)))
  const remove = lines.every(has)
  const changed = lines.map((line, i) => (remove ? line.replace(numbered ? /^\d{1,9}\. / : prefix, '') : marker(i) + line.replace(/^(#{1,3} |> |- |\d{1,9}\. )/, '')))
  const block = changed.join('\n')
  return { text: text.slice(0, lineStart) + block + text.slice(lineEnd), start: lineStart, end: lineStart + block.length }
}

/** Inserts a block (a table, a picture) on lines of its own at the cursor. */
export function insertBlock(text: string, at: number, block: string): Edit {
  const before = text.slice(0, at)
  const after = text.slice(at)
  const lead = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'
  const trail = after === '' || after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n'
  const next = before + lead + block + trail + after
  const start = before.length + lead.length
  return { text: next, start, end: start + block.length }
}

/** "[label](url)" for the selection (or the given label). */
export function link(text: string, start: number, end: number, url: string, label?: string): Edit {
  const shown = (text.slice(start, end) || label || url).replace(/[[\]\n]/g, '').slice(0, 200)
  const markdown = `[${shown}](${url})`
  return { text: text.slice(0, start) + markdown + text.slice(end), start: start + markdown.length, end: start + markdown.length }
}
