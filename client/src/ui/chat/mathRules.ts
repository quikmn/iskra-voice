// Where math starts and ends in a message: $…$ inline and $$…$$ as a block, by the usual (Pandoc and KaTeX
// auto-render) rules, so ordinary prices stay text: an opening $ needs a non-space right after it, a closing $ a
// non-space right before it and no digit right after it ("$5 and $10" is two prices, "$x^2$" is math).

export const MAX_INLINE_MATH = 500
export const MAX_DISPLAY_MATH = 2000

const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c)
const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9'

/** Inline math starting at `i` (a single "$"), or null. `end` is just past the closing "$". */
export function inlineMathAt(text: string, i: number): { tex: string; end: number } | null {
  if (text[i] !== '$' || text[i + 1] === '$' || isSpace(text[i + 1]) || text[i - 1] === '\\') return null
  for (let j = i + 1; j < text.length && j - i <= MAX_INLINE_MATH + 1; j++) {
    const c = text[j]
    if (c === '\n') return null
    if (c === '\\') {
      j++
      continue
    }
    // The first unescaped "$" closes it or nothing does ("$5 and $10, then $x$" has math only at the end).
    if (c === '$') return !isSpace(text[j - 1]) && !isDigit(text[j + 1]) && text[j + 1] !== '$' ? { tex: text.slice(i + 1, j), end: j + 1 } : null
  }
  return null
}

export type MathSegment = { kind: 'text'; text: string } | { kind: 'math'; tex: string }

/** Splits text into plain stretches and $$…$$ blocks (which may span lines). */
export function splitDisplayMath(text: string): MathSegment[] {
  const out: MathSegment[] = []
  let from = 0
  let i = 0
  while (i < text.length) {
    const open = text.indexOf('$$', i)
    if (open < 0) break
    if (text[open - 1] === '\\') {
      i = open + 2
      continue
    }
    let close = text.indexOf('$$', open + 2)
    while (close > 0 && text[close - 1] === '\\') close = text.indexOf('$$', close + 2)
    if (close < 0) break
    const tex = text.slice(open + 2, close)
    if (!tex.trim() || tex.length > MAX_DISPLAY_MATH || isDigit(text[close + 2])) {
      i = open + 2
      continue
    }
    if (open > from) out.push({ kind: 'text', text: text.slice(from, open) })
    out.push({ kind: 'math', tex: tex.trim() })
    from = close + 2
    // The line break right after a block belongs to it.
    if (text[from] === '\n') from++
    i = from
  }
  if (from < text.length || out.length === 0) out.push({ kind: 'text', text: text.slice(from) })
  return out
}
