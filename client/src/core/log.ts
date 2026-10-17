// The app's log lines, in the same format as the server's (docs/development.md "Logs"):
// `UTC-time  LEVEL  SRC  AREA  event  CODE  key=value…`, one line per entry, never a newline inside a field.
// What may appear is fixed here: known sources and areas, a kebab event, a code from protocol/log-codes.json, and
// fields from a fixed vocabulary whose values are short plain words or numbers. Only `msg` carries text (a browser's
// own error message), scrubbed of addresses, paths, emails and long tokens. No DOM or React: shared with the bot SDK.
import sodium from 'libsodium-wrappers-sumo'

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'
export const LOG_LEVELS: readonly LogLevel[] = ['DEBUG', 'INFO', 'WARN', 'ERROR']

/** `app` this app (web, phone, desktop page), `desk` the desktop app's main process, `upd` its updater. */
export const LOG_SOURCES = ['app', 'desk', 'upd'] as const
export type LogSource = (typeof LOG_SOURCES)[number]

export const LOG_AREAS = [
  'life', 'conn', 'sess', 'voice', 'call', 'media', 'e2ee', 'tunnel', 'nat', 'tls', 'update', 'push', 'backup',
  'sweep', 'rate', 'store', 'ui', 'http', 'sched', 'misc',
] as const

/** Field keys that may appear; anything else is dropped. The first row is shared with the server. */
export const LOG_FIELDS: ReadonlySet<string> = new Set([
  'srv', 'conn', 'acct', 'chan', 'room', 'call', 'path', 'via', 'nat', 'ice', 'proto', 'codec', 'loss', 'rtt',
  'jitter', 'took', 'dur', 'retry', 'n', 'close', 'why', 'reason', 'op', 'name', 'msg', 'ver', 'os', 'engine',
  'kind', 'count', 'status', 'port',
  // the apps
  'frame', 'state', 'code', 'type', 'what', 'from', 'to', 'mode', 'exit', 'browser', 'lang', 'arch',
])

/** The only text a line may carry (`msg=`): an error message the browser wrote. Made by {@link errorFields}. */
export class BrowserMessage {
  readonly text: string
  constructor(text: string) {
    this.text = text
  }
}

export type LogValue = string | number | boolean | BrowserMessage | null | undefined
export type LogFields = Record<string, LogValue> | [string, LogValue][]

export interface LogEntry {
  at: number
  level: LogLevel
  src: LogSource
  area: string
  event: string
  /** Required on warnings and errors (the default is ERR-900, "area unknown"). */
  code: string | null
  /** Allowed keys only, values already formatted. */
  fields: [string, string][]
}

export const CODE = /^[A-Z][A-Z0-9]{1,2}-[0-9]{3}$/
const EVENT = /^[a-z][a-z0-9-]{0,23}$/
/** A message that needs no quotes (the server's rule). */
const PLAIN_MSG = /^[A-Za-z0-9._:/,+@=%<>-]{1,80}$/
const MAX_MSG = 120

// What each field's value may look like. Anything else is dropped, so a name, a file name, a key or a sentence can't
// pass for a value even when a caller puts one there by mistake.
const WORD = /^[a-z][a-z0-9_-]{0,39}$/
const NUM = /^-?\d{1,12}(\.\d{1,2})?$/
const DUR = /^\d{1,9}(\.\d)?(ms|s)$/
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.-]{1,30})?$/
const SCHEMA: Record<string, RegExp> = {
  srv: /^([0-9a-f]{4}|s\d{1,3})$/, conn: /^[0-9a-z]{1,8}$/, acct: /^[0-9a-f]{6}$/,
  chan: NUM, room: NUM, n: NUM, count: NUM, close: NUM, port: NUM, exit: NUM, status: NUM, loss: NUM,
  rtt: /^\d{1,9}(\.\d{1,2})?(ms)?$/, jitter: /^\d{1,9}(\.\d{1,2})?(ms)?$/,
  took: DUR, dur: DUR, retry: DUR,
  ver: VERSION, from: VERSION, to: VERSION,
  name: /^[A-Z][A-Za-z]{0,39}$/,
  frame: /^[\w.-]{1,30}\.(js|mjs|ts|tsx):\d{1,7}:\d{1,7}$/,
  type: /^[a-z][a-zA-Z0-9]{0,23}(\.[a-z][a-zA-Z0-9]{0,23}){0,3}$/,
  os: /^(Windows|macOS|Linux|ChromeOS|Unknown|Android|iOS|win32|darwin|linux)(-\d{1,3}(\.\d{1,3})?)?$/,
  browser: /^(Electron|Edge|Firefox|Chrome|Safari)-\d{1,4}$/,
  lang: /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/,
  engine: /^[a-z]{1,16}$/,
}

/** A field value already written as text: kept only when it has the shape its key allows. */
export function fieldText(key: string, text: string): string | null {
  if (!LOG_FIELDS.has(key) || key === 'msg') return null
  return (SCHEMA[key] ?? WORD).test(text) ? text : null
}

/** A field value as text: numbers and yes/no, words and ids in their key's shape, a browser's message scrubbed and quoted. Null drops it. */
export function logValue(key: string, value: LogValue): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return fieldText(key, value ? 'yes' : 'no')
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    return fieldText(key, Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100))
  }
  if (typeof value === 'string') return fieldText(key, value)
  if (value instanceof BrowserMessage && key === 'msg') {
    const text = scrub(value.text)
    if (!text) return null
    if (PLAIN_MSG.test(text)) return text
    const cut = text.length > MAX_MSG ? `${text.slice(0, MAX_MSG - 1)}…` : text
    return `"${cut.replace(/"/g, "'").replace(/[\u0000-\u001f\u007f]/g, ' ')}"`
  }
  return null
}

/** An entry exactly as it may be kept, or null. Unknown areas become `misc`, unknown events `note`, unknown keys go. */
export function makeEntry(at: number, level: LogLevel, src: LogSource, area: string, event: string, code: string | null | undefined, fields?: LogFields): LogEntry | null {
  if (!Number.isFinite(at) || at < 0 || !LOG_LEVELS.includes(level) || !(LOG_SOURCES as readonly string[]).includes(src)) return null
  const kept: [string, string][] = []
  for (const [key, value] of Array.isArray(fields) ? fields : Object.entries(fields ?? {})) {
    if (!LOG_FIELDS.has(key) || kept.some(([k]) => k === key)) continue
    const text = logValue(key, value)
    if (text !== null) kept.push([key, text])
  }
  const goodCode = typeof code === 'string' && CODE.test(code) ? code : null
  const entry: LogEntry = Object.freeze({
    at: Math.floor(at), level, src,
    area: (LOG_AREAS as readonly string[]).includes(area) ? area : 'misc',
    event: typeof event === 'string' && EVENT.test(event) ? event : 'note',
    code: goodCode ?? (level === 'WARN' || level === 'ERROR' ? 'ERR-900' : null),
    fields: Object.freeze(kept.map((f) => Object.freeze(f))) as [string, string][],
  })
  made.add(entry)
  return entry
}

const made = new WeakSet<LogEntry>()
/** Made by {@link makeEntry}, so already checked (and frozen). */
export const isCheckedEntry = (entry: LogEntry): boolean => typeof entry === 'object' && entry !== null && made.has(entry)

/** The whole line: `<UTC ISO ms> <LEVEL:5> <SRC:5> <AREA:6> <event:11> <CODE|-:7> <key=value…>`. */
export function formatLine(e: LogEntry): string {
  const head = `${new Date(e.at).toISOString()} ${e.level.padEnd(5)} ${e.src.padEnd(5)} ${e.area.padEnd(6)} ${e.event.padEnd(11)} ${(e.code ?? '-').padEnd(7)}`
  const body = e.fields.map(([k, v]) => `${k}=${v}`).join(' ')
  return (body ? `${head} ${body}` : head).trimEnd()
}

/** A line in this format, split back into its parts (null if it isn't one). */
export interface ParsedLine { time: string; level: LogLevel; src: string; area: string; event: string; code: string | null; fields: Record<string, string> }
const LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) (DEBUG|INFO |WARN |ERROR) ([a-z0-9:]{1,12})\s+([a-z]{1,6})\s+([a-z][a-z0-9-]{0,23})\s+([A-Z][A-Z0-9]{1,2}-\d{3}|-)\s*(.*)$/
export function parseLine(line: string): ParsedLine | null {
  const m = LINE.exec(line)
  if (!m) return null
  const fields: Record<string, string> = {}
  for (const part of m[7].matchAll(/([a-z]+)=("[^"]*"|\S+)/g)) fields[part[1]] = part[2]
  return { time: m[1], level: m[2].trim() as LogLevel, src: m[3], area: m[4], event: m[5], code: m[6] === '-' ? null : m[6], fields }
}

/**
 * A line from elsewhere (the desktop app's log file) written again by these rules: a known source, area and event, a
 * code, and only the fields whose values have their key's shape (a message scrubbed again). Null if it isn't a line.
 */
export function cleanLine(line: string, sources: readonly string[] = LOG_SOURCES): string | null {
  const p = typeof line === 'string' && line.length <= 1000 ? parseLine(line) : null
  if (!p || !sources.includes(p.src) || !(LOG_AREAS as readonly string[]).includes(p.area)) return null
  const fields: [string, string][] = []
  for (const [key, text] of Object.entries(p.fields)) {
    const kept = key === 'msg' ? logValue('msg', new BrowserMessage(text.replace(/^"|"$/g, ''))) : fieldText(key, text)
    if (kept !== null && !fields.some(([k]) => k === key)) fields.push([key, kept])
  }
  const head = `${p.time} ${p.level.padEnd(5)} ${p.src.padEnd(5)} ${p.area.padEnd(6)} ${p.event.padEnd(11)} ${(p.code ?? '-').padEnd(7)}`
  return (fields.length ? `${head} ${fields.map(([k, v]) => `${k}=${v}`).join(' ')}` : head).trimEnd()
}

/** Milliseconds the way the server writes a duration: `497ms`, `6.7s`, `312s`. */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return ms < 99_950 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 1000)}s`
}

/**
 * Takes out what a log line must never carry, whatever a browser or library put in a message: URLs past their host,
 * emails, file paths, IP addresses and long base64/hex runs (keys, tokens, secrets, invite codes). Same rules as the server.
 */
export function scrub(input: string): string {
  let text = input.length > 2000 ? input.slice(0, 2000) : input
  text = text.replace(/([A-Za-z][A-Za-z0-9+.-]{1,9}):\/\/(\[[^\]]*\]|[^/\s:?#"']+)(:\d+)?[^\s"']*/g, (_m, scheme: string, host: string) =>
    `${scheme}://${IPV4.test(host) || host.includes(':') ? '<ip>' : host}/…`)
  text = text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
  text = text.replace(/(?<![A-Za-z])[A-Za-z]:[\\/][^\s"']*|\\\\[^\s"']+/g, '<path>')
  text = text.replace(/(?<![\w.:/<])\/(?:home|Users|var|tmp|root|etc|opt|srv|mnt|private|usr|run|data|Volumes|Library)(?:\/[^\s"']*)?/g, '<path>')
  text = text.replace(/(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?![\d.])/g, '<ip>')
  text = text.replace(/(?<![\w:])\[?(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}\]?(?:%\w+)?(?::\d+)?(?![\w:])/g, '<ip>')
  text = text.replace(/[A-Za-z0-9_+/=-]{20,}/g, (m) => (m.length >= 32 || /\d/.test(m) ? '<token>' : m))
  return text.replace(/[\r\n]/g, ' ').trim()
}
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

// ── Errors ──────────────────────────────────────────────────────────────────

/** The bundle file and line an error came from ("index-3f2a.js:12:3456"): the first frame of its stack, if any. */
export function errorFrame(stack: unknown): string | undefined {
  if (typeof stack !== 'string') return undefined
  for (const line of stack.split('\n').slice(0, 6)) {
    const m = /([\w.-]+\.(?:js|mjs|ts|tsx)):(\d+):(\d+)\)?\s*$/.exec(line.trim())
    if (m) return `${m[1]}:${m[2]}:${m[3]}`.slice(-40)
  }
  return undefined
}

/** Errors the browser itself makes (DOMException): their message is the browser's wording, never ours or a person's. */
const isDomException = (e: unknown): boolean =>
  (typeof DOMException === 'function' && e instanceof DOMException) || Object.prototype.toString.call(e) === '[object DOMException]'

/** What an error may say in a log: its class, where it came from, and (browser errors only) its message. */
export function errorFields(error: unknown): [string, LogValue][] {
  const e = error as { name?: unknown; stack?: unknown; message?: unknown } | null | undefined
  const name = typeof e?.name === 'string' && /^[A-Z][A-Za-z]{0,39}$/.test(e.name) ? e.name : 'Error'
  const fields: [string, LogValue][] = [['name', name], ['frame', errorFrame(e?.stack)]]
  if (isDomException(error) && typeof e?.message === 'string') fields.push(['msg', new BrowserMessage(e.message)])
  return fields
}

// ── Sinks ───────────────────────────────────────────────────────────────────

type Sink = (entry: LogEntry) => void
const sinks = new Set<Sink>()

/** Where entries go (the bug report buffer, the desktop app's log file). Returns a function that removes it. */
export function addLogSink(sink: Sink): () => void {
  sinks.add(sink)
  return () => sinks.delete(sink)
}

let clock: () => number = () => Date.now()
/** Tests: a fixed clock. */
export const setLogClock = (now: (() => number) | null) => { clock = now ?? (() => Date.now()) }

/** Logs one entry from this app (anything off the allowlist is dropped). Never throws. */
export function log(level: LogLevel, area: string, event: string, code?: string | null, fields?: LogFields): void {
  try {
    const entry = makeEntry(clock(), level, 'app', area, event, code, fields)
    if (!entry) return
    for (const sink of sinks) {
      try { sink(entry) } catch { /* a sink never breaks the caller */ }
    }
  } catch { /* logging never throws */ }
}

/** A known operation failed (`area` and `op` say which, e.g. voice/audio-close); the error adds only its class, frame and browser message. */
export function logError(area: string, op: string, error: unknown, code = 'ERR-910', fields: [string, LogValue][] = []): void {
  log(code === 'ERR-910' ? 'ERROR' : 'WARN', area, 'failed', code, [['op', op], ...fields, ...errorFields(error)])
}

// ── Ids ─────────────────────────────────────────────────────────────────────

const serverIds = new Map<string, string>()

/**
 * The server's id in logs, as the server prints it in its `life start` line: the first 4 hex of
 * BLAKE2b-256("iskra-log-v1" ‖ 0x00 ‖ server public key) (PROTOCOL.md "Log ids"). Null until libsodium is ready.
 */
export function serverLogId(serverKey: string): string | null {
  const known = serverIds.get(serverKey)
  if (known) return known
  try {
    const key = sodium.from_base64(serverKey, sodium.base64_variants.URLSAFE_NO_PADDING)
    const context = new TextEncoder().encode('iskra-log-v1')
    const payload = new Uint8Array(context.length + 1 + key.length)
    payload.set(context)
    payload.set(key, context.length + 1)
    const id = sodium.to_hex(sodium.crypto_generichash(32, payload, null)).slice(0, 4)
    serverIds.set(serverKey, id)
    return id
  } catch {
    return null
  }
}
