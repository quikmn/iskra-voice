// Turning the code highlighter's and the math renderer's output into React elements, through strict allowlists. The
// output is built from what people typed, so it's never put into the page as HTML: only known tags, attributes, classes
// and a small set of style properties survive, and everything else (scripts, event handlers, links, sources, unknown
// elements and their contents) is dropped.
import { createElement, type CSSProperties, type ReactNode } from 'react'

// ── Code: a hast tree (lowlight) ────────────────────────────────────────────

export interface HastText { type: 'text'; value: string }
export interface HastElement { type: 'element'; tagName: string; properties?: Record<string, unknown>; children: HastNode[] }
export interface HastRoot { type: 'root'; children: HastNode[] }
export type HastNode = HastText | HastElement | HastRoot | { type: string }

/** highlight.js classes: "hljs-keyword", and sub-scopes like "function_". */
const CODE_CLASS = /^(hljs-[a-z][a-z0-9_-]{0,30}|[a-z][a-z0-9-]{0,30}_+)$/

export function hastToReact(node: HastNode, key: number | string = 0, depth = 0): ReactNode {
  if (depth > 64) return null
  if (node.type === 'text') return (node as HastText).value
  if (node.type === 'root') return (node as HastRoot).children.map((c, i) => hastToReact(c, i, depth + 1))
  if (node.type !== 'element') return null
  const el = node as HastElement
  if (el.tagName !== 'span') return null
  const raw = el.properties?.className
  const classes = (Array.isArray(raw) ? raw : []).filter((c): c is string => typeof c === 'string' && CODE_CLASS.test(c))
  return createElement('span', { key, className: classes.join(' ') || undefined }, el.children.map((c, i) => hastToReact(c, i, depth + 1)))
}

// ── Math: MathML (temml) ────────────────────────────────────────────────────

const MATH_TAGS = new Set([
  'math', 'mrow', 'mi', 'mn', 'mo', 'ms', 'mtext', 'mspace', 'msup', 'msub', 'msubsup', 'mfrac', 'msqrt', 'mroot', 'mover',
  'munder', 'munderover', 'mtable', 'mtr', 'mtd', 'mlabeledtr', 'mstyle', 'mpadded', 'mphantom', 'menclose', 'merror',
  'mmultiscripts', 'mprescripts', 'none', 'semantics',
])

const MATH_ATTRIBUTES = new Set([
  'display', 'mathvariant', 'stretchy', 'fence', 'separator', 'lspace', 'rspace', 'minsize', 'maxsize', 'symmetric',
  'largeop', 'movablelimits', 'accent', 'accentunder', 'form', 'linethickness', 'columnalign', 'rowalign', 'columnspacing',
  'rowspacing', 'columnlines', 'rowlines', 'frame', 'framespacing', 'displaystyle', 'scriptlevel', 'width', 'height',
  'depth', 'voffset', 'notation', 'mathsize', 'mathcolor', 'mathbackground', 'columnspan', 'rowspan', 'align',
])

/** The classes temml's stylesheet knows. */
const MATH_CLASSES = new Set([
  'actuarial', 'chr-lrg', 'chr-lrg-vec', 'chr-med', 'chr-med-vec', 'chr-sml', 'chr-sml-vec', 'circle-pad', 'downstrike',
  'ff-narrow', 'ff-nudge-left', 'ff-squash', 'longdiv-arc', 'longdiv-top', 'mathcal', 'mathscr', 'menclose', 'org',
  'phasor-angle', 'phasor-bottom', 'sout', 'special-fraction', 'textcircle', 'tml-cancel', 'tml-cancelto', 'tml-display',
  'tml-eqn', 'tml-fbox', 'tml-hat-1', 'tml-hat-2', 'tml-hat-3', 'tml-hat-4', 'tml-jot', 'tml-left', 'tml-lrg-pad',
  'tml-med-pad', 'tml-overline', 'tml-prime', 'tml-right', 'tml-shift-left', 'tml-small', 'tml-sml-pad', 'tml-tilde-2',
  'tml-tilde-3', 'tml-tilde-4', 'tml-underline', 'tml-vec', 'tml-xcancel', 'upstrike', 'w3', 'wbk-acc', 'wbk-lrg',
  'wbk-lrg-acc', 'wbk-lrg-vec', 'wbk-med', 'wbk-med-acc', 'wbk-med-vec', 'wbk-sml', 'wbk-sml-acc', 'wbk-sml-vec',
])

/** Style properties temml uses for layout and colour (\color, padding in arrays, \boxed borders). */
const MATH_STYLES: Record<string, keyof CSSProperties | string> = {
  color: 'color', 'background-color': 'backgroundColor', padding: 'padding', 'padding-left': 'paddingLeft',
  'padding-right': 'paddingRight', 'padding-top': 'paddingTop', 'padding-bottom': 'paddingBottom', border: 'border',
  'border-top': 'borderTop', 'border-bottom': 'borderBottom', 'border-left': 'borderLeft', 'border-right': 'borderRight',
  'margin-left': 'marginLeft', 'margin-right': 'marginRight', 'math-depth': 'mathDepth', 'math-style': 'mathStyle',
  'white-space': 'whiteSpace', 'vertical-align': 'verticalAlign', 'font-style': 'fontStyle', 'font-weight': 'fontWeight',
  width: 'width', height: 'height', display: 'display', 'text-align': 'textAlign', 'line-height': 'lineHeight',
}

/** Plain values only: numbers, lengths, words, hex and rgb() colours. No url(), var(), expression(), escapes or quotes. */
const SAFE_VALUE = /^[#\w\s.%,+-]*(\((?:[\d\s.,%]+)\))?[#\w\s.%,+-]*$/
const SAFE_COLOR = /^(#[0-9a-f]{3,8}|[a-z]{3,20})$/i

function safeValue(value: string): boolean {
  return value.length <= 120 && SAFE_VALUE.test(value) && !/url|expression|var|image|attr|javascript/i.test(value)
}

function styleOf(text: string): CSSProperties | undefined {
  const style: Record<string, string> = {}
  for (const part of text.split(';')) {
    const colon = part.indexOf(':')
    if (colon < 0) continue
    const name = part.slice(0, colon).trim().toLowerCase()
    const value = part.slice(colon + 1).trim()
    const prop = MATH_STYLES[name]
    if (!prop || !value || !safeValue(value)) continue
    if (prop === 'display' && !/^(block|inline|block math|inline math|inline-block)$/.test(value)) continue
    style[prop] = value
  }
  return Object.keys(style).length ? (style as CSSProperties) : undefined
}

function mathNode(node: Node, key: number, depth: number): ReactNode {
  if (depth > 128) return null
  if (node.nodeType === 3) return node.nodeValue ?? ''
  if (node.nodeType !== 1) return null
  const el = node as Element
  const tag = el.localName.toLowerCase()
  if (!MATH_TAGS.has(tag)) return null // unknown elements go, with everything in them
  const props: Record<string, unknown> = { key }
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase()
    const value = attr.value
    if (name === 'class') {
      const classes = value.split(/\s+/).filter((c) => MATH_CLASSES.has(c))
      if (classes.length) props.className = classes.join(' ')
    } else if (name === 'style') {
      const style = styleOf(value)
      if (style) props.style = style
    } else if (MATH_ATTRIBUTES.has(name)) {
      if (name === 'mathcolor' || name === 'mathbackground' ? SAFE_COLOR.test(value) : safeValue(value)) props[name] = value
    }
  }
  const children = Array.from(el.childNodes).map((c, i) => mathNode(c, i, depth + 1))
  return createElement(tag, props, ...children)
}

/** MathML markup (temml's output) as React elements, or null if it isn't a single <math> element. */
export function mathmlToReact(markup: string, parser: DOMParser = new DOMParser()): ReactNode {
  // A detached document: nothing in it runs or loads.
  const doc = parser.parseFromString(`<!doctype html><body>${markup}</body>`, 'text/html')
  const roots = Array.from(doc.body.childNodes).filter((n) => n.nodeType === 1 || (n.nodeValue ?? '').trim())
  if (roots.length !== 1 || (roots[0] as Element).localName?.toLowerCase() !== 'math') return null
  return mathNode(roots[0], 0, 0)
}
