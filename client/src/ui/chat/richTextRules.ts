// Pure helpers for richer message text: Discord-style timestamps and a small syntax highlighter for code blocks.

// ── Timestamps: <t:1700000000> or <t:1700000000:R> ─────────────────────────

export type TimestampStyle = 't' | 'T' | 'd' | 'D' | 'f' | 'F' | 'R'
export const TIMESTAMP_SOURCE = '<t:(-?\\d{1,13})(?::([tTdDfFR]))?>'
const MAX_SECONDS = 8_640_000_000_000 // the range Date supports

export function parseTimestamp(seconds: string): number | null {
  const n = Number(seconds)
  return Number.isSafeInteger(n) && Math.abs(n) <= MAX_SECONDS ? n * 1000 : null
}

interface FormatOptions {
  locale?: string
  timeZone?: string
  now?: number
}

export function formatTimestamp(ms: number, style: TimestampStyle = 'f', options: FormatOptions = {}): string {
  const { locale, timeZone, now = Date.now() } = options
  const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { timeZone, ...o }).format(ms)
  switch (style) {
    case 't': return f({ hour: 'numeric', minute: '2-digit' })
    case 'T': return f({ hour: 'numeric', minute: '2-digit', second: '2-digit' })
    case 'd': return f({ year: 'numeric', month: '2-digit', day: '2-digit' })
    case 'D': return f({ year: 'numeric', month: 'long', day: 'numeric' })
    case 'F': return f({ weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    case 'R': return relative(ms - now, locale)
    default: return f({ year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  }
}

function relative(deltaMs: number, locale?: string): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const s = Math.round(deltaMs / 1000)
  const abs = Math.abs(s)
  if (abs < 60) return rtf.format(s, 'second')
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute')
  if (abs < 86_400) return rtf.format(Math.round(s / 3600), 'hour')
  if (abs < 30 * 86_400) return rtf.format(Math.round(s / 86_400), 'day')
  if (abs < 365 * 86_400) return rtf.format(Math.round(s / (30 * 86_400)), 'month')
  return rtf.format(Math.round(s / (365 * 86_400)), 'year')
}

// ── Syntax highlighting ─────────────────────────────────────────────────────

export type TokenKind = 'plain' | 'keyword' | 'literal' | 'string' | 'comment' | 'number' | 'added' | 'removed'
export interface Token {
  kind: TokenKind
  text: string
}

interface Language {
  keywords: string[]
  line?: string[]
  block?: [string, string]
  strings: string[]
  /** Backtick-style strings that may span lines. */
  multiline?: string[]
}

const C_LIKE = ['if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'return', 'goto', 'struct', 'enum', 'union',
  'typedef', 'static', 'const', 'void', 'int', 'char', 'long', 'short', 'float', 'double', 'unsigned', 'signed', 'sizeof', 'extern', 'inline']
const JS = ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue',
  'new', 'delete', 'typeof', 'instanceof', 'in', 'of', 'class', 'extends', 'super', 'this', 'import', 'export', 'from', 'as', 'async', 'await',
  'yield', 'try', 'catch', 'finally', 'throw', 'void', 'static', 'get', 'set']
const TS = [...JS, 'interface', 'type', 'enum', 'implements', 'private', 'public', 'protected', 'readonly', 'declare', 'namespace', 'abstract',
  'keyof', 'satisfies', 'string', 'number', 'boolean', 'unknown', 'never', 'any']

const LANGUAGES: Record<string, Language> = {
  js: { keywords: JS, line: ['//'], block: ['/*', '*/'], strings: ['"', "'"], multiline: ['`'] },
  ts: { keywords: TS, line: ['//'], block: ['/*', '*/'], strings: ['"', "'"], multiline: ['`'] },
  json: { keywords: [], strings: ['"'] },
  py: {
    keywords: ['def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'in', 'not', 'and', 'or', 'is', 'import', 'from', 'as', 'with',
      'try', 'except', 'finally', 'raise', 'lambda', 'yield', 'pass', 'break', 'continue', 'global', 'nonlocal', 'async', 'await', 'del', 'assert', 'self'],
    line: ['#'], strings: ['"', "'"],
  },
  cs: {
    keywords: ['using', 'namespace', 'class', 'record', 'struct', 'interface', 'enum', 'public', 'private', 'protected', 'internal', 'static',
      'readonly', 'const', 'sealed', 'abstract', 'override', 'virtual', 'async', 'await', 'var', 'new', 'return', 'if', 'else', 'for', 'foreach',
      'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'in', 'out', 'ref', 'is', 'as',
      'void', 'string', 'int', 'long', 'bool', 'double', 'float', 'decimal', 'object', 'this', 'base', 'get', 'set', 'init', 'required', 'partial', 'yield'],
    line: ['//'], block: ['/*', '*/'], strings: ['"', "'"],
  },
  java: {
    keywords: ['package', 'import', 'class', 'interface', 'enum', 'extends', 'implements', 'public', 'private', 'protected', 'static', 'final',
      'abstract', 'new', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'try', 'catch', 'finally',
      'throw', 'throws', 'void', 'int', 'long', 'boolean', 'double', 'float', 'char', 'this', 'super', 'var', 'record', 'fun', 'val', 'when', 'object'],
    line: ['//'], block: ['/*', '*/'], strings: ['"', "'"],
  },
  c: { keywords: [...C_LIKE, 'class', 'public', 'private', 'protected', 'virtual', 'template', 'typename', 'namespace', 'using', 'new', 'delete',
    'auto', 'nullptr', 'this', 'include', 'define'], line: ['//'], block: ['/*', '*/'], strings: ['"', "'"] },
  go: { keywords: ['package', 'import', 'func', 'return', 'if', 'else', 'for', 'range', 'switch', 'case', 'default', 'break', 'continue', 'go',
    'defer', 'chan', 'select', 'type', 'struct', 'interface', 'map', 'var', 'const', 'fallthrough', 'goto'], line: ['//'], block: ['/*', '*/'], strings: ['"', "'"], multiline: ['`'] },
  rust: { keywords: ['fn', 'let', 'mut', 'const', 'static', 'struct', 'enum', 'impl', 'trait', 'pub', 'use', 'mod', 'crate', 'self', 'Self',
    'super', 'return', 'if', 'else', 'match', 'for', 'while', 'loop', 'in', 'break', 'continue', 'as', 'where', 'async', 'await', 'move', 'ref',
    'unsafe', 'dyn', 'type'], line: ['//'], block: ['/*', '*/'], strings: ['"'] },
  sh: { keywords: ['if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'until', 'case', 'esac', 'function', 'return',
    'export', 'local', 'echo', 'cd', 'sudo', 'param', 'foreach'], line: ['#'], strings: ['"', "'"] },
  sql: { keywords: ['select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete', 'create', 'table', 'drop', 'alter',
    'index', 'join', 'left', 'right', 'inner', 'outer', 'on', 'and', 'or', 'not', 'null', 'is', 'as', 'order', 'by', 'group', 'having',
    'limit', 'primary', 'key', 'references', 'distinct', 'union', 'case', 'when', 'then', 'else', 'end', 'returning'], line: ['--'], block: ['/*', '*/'], strings: ["'", '"'] },
  css: { keywords: ['important', 'media', 'supports', 'keyframes', 'from', 'to'], block: ['/*', '*/'], strings: ['"', "'"] },
  lua: { keywords: ['local', 'function', 'end', 'if', 'then', 'else', 'elseif', 'for', 'in', 'do', 'while', 'repeat', 'until', 'return',
    'break', 'and', 'or', 'not'], line: ['--'], strings: ['"', "'"] },
  yaml: { keywords: [], line: ['#'], strings: ['"', "'"] },
}

const ALIASES: Record<string, string> = {
  javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', typescript: 'ts', tsx: 'ts', python: 'py', csharp: 'cs', 'c#': 'cs',
  kotlin: 'java', kt: 'java', cpp: 'c', 'c++': 'c', h: 'c', hpp: 'c', golang: 'go', rs: 'rust', bash: 'sh', shell: 'sh', zsh: 'sh',
  ps1: 'sh', powershell: 'sh', yml: 'yaml', toml: 'yaml', ini: 'yaml', scss: 'css', jsonc: 'json',
}

const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'None', 'True', 'False', 'nil', 'NaN', 'Infinity'])
const MAX_HIGHLIGHT = 20_000

export const languageOf = (name: string): string | null => {
  const key = name.toLowerCase()
  return key === 'diff' ? 'diff' : LANGUAGES[key] ? key : ALIASES[key] ?? null
}

/** Splits code into coloured tokens. Unknown languages (or very long code) come back as one plain token. */
export function highlight(code: string, language: string): Token[] {
  const lang = languageOf(language)
  if (!lang || code.length > MAX_HIGHLIGHT) return [{ kind: 'plain', text: code }]
  if (lang === 'diff') {
    return code.split(/(?<=\n)/).map((line) => ({ kind: line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : 'plain', text: line }))
  }
  const def = LANGUAGES[lang]
  const keywords = new Set(def.keywords)
  const caseless = lang === 'sql'
  const out: Token[] = []
  const push = (kind: TokenKind, text: string) => {
    const last = out[out.length - 1]
    if (last && last.kind === kind) last.text += text
    else out.push({ kind, text })
  }

  let i = 0
  while (i < code.length) {
    const rest = code.startsWith.bind(code)
    const lineMarker = def.line?.find((m) => rest(m, i))
    if (lineMarker) {
      const end = code.indexOf('\n', i)
      const stop = end < 0 ? code.length : end
      push('comment', code.slice(i, stop))
      i = stop
      continue
    }
    if (def.block && rest(def.block[0], i)) {
      const end = code.indexOf(def.block[1], i + def.block[0].length)
      const stop = end < 0 ? code.length : end + def.block[1].length
      push('comment', code.slice(i, stop))
      i = stop
      continue
    }
    const quote = [...def.strings, ...(def.multiline ?? [])].find((q) => code[i] === q)
    if (quote) {
      const multi = def.multiline?.includes(quote)
      let j = i + 1
      while (j < code.length && code[j] !== quote && (multi || code[j] !== '\n')) j += code[j] === '\\' ? 2 : 1
      const stop = Math.min(code.length, j + 1)
      push('string', code.slice(i, stop))
      i = stop
      continue
    }
    const prev = code[i - 1] ?? ''
    const number = /^(0x[\da-fA-F_]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?)/.exec(code.slice(i, i + 40))
    if (number && !/[\w$]/.test(prev)) {
      push('number', number[0])
      i += number[0].length
      continue
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(code.slice(i, i + 80))
    if (word && !/[\w$]/.test(prev)) {
      const w = word[0]
      push(LITERALS.has(w) ? 'literal' : keywords.has(caseless ? w.toLowerCase() : w) ? 'keyword' : 'plain', w)
      i += w.length
      continue
    }
    push('plain', code[i])
    i++
  }
  return out
}
