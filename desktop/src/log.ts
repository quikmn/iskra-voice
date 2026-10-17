// The desktop app's own log: one line per event in the server's format (docs/development.md "Logs"),
// `UTC-time  LEVEL  SRC  AREA  event  CODE  key=value…`, written to userData/logs/YYYY-MM-DD.log (UTC days) and
// trimmed by the same retention stairs as the server's logs: plain for 60 days, gzipped until 180, then deleted, and
// never more than 50 MB in all. Sources: `desk` (this main process), `upd` (the updater) and `app` (the page's own
// lines, checked again here). Fields come from a fixed vocabulary with a shape per key, so names, file names, keys,
// addresses and sentences can't get in; only `msg` carries text (an error's first line), scrubbed. Never throws.
// The rules here match client/src/core/log.ts; protocol/log-format.json holds golden lines both must render.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeSync, appendFileSync, fstatSync } from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'
const LEVELS: readonly LogLevel[] = ['DEBUG', 'INFO', 'WARN', 'ERROR']
export type LogSource = 'desk' | 'upd' | 'app'
const SOURCES: readonly LogSource[] = ['desk', 'upd', 'app']
export const AREAS = ['life', 'conn', 'sess', 'voice', 'call', 'media', 'e2ee', 'tunnel', 'nat', 'tls', 'update', 'push', 'backup', 'sweep', 'rate', 'store', 'ui', 'http', 'sched', 'misc']

export const FIELDS = new Set([
  'srv', 'conn', 'acct', 'chan', 'room', 'call', 'path', 'via', 'nat', 'ice', 'proto', 'codec', 'loss', 'rtt',
  'jitter', 'took', 'dur', 'retry', 'n', 'close', 'why', 'reason', 'op', 'name', 'msg', 'ver', 'os', 'engine',
  'kind', 'count', 'status', 'port',
  'frame', 'state', 'code', 'type', 'what', 'from', 'to', 'mode', 'exit', 'browser', 'lang', 'arch', 'gz', 'deleted',
])

const CODE = /^[A-Z][A-Z0-9]{1,2}-[0-9]{3}$/
const EVENT = /^[a-z][a-z0-9-]{0,23}$/
const PLAIN_MSG = /^[A-Za-z0-9._:/,+@=%<>-]{1,80}$/
const MAX_MSG = 120
const WORD = /^[a-z][a-z0-9_-]{0,39}$/
const NUM = /^-?\d{1,12}(\.\d{1,2})?$/
const DUR = /^\d{1,9}(\.\d)?(ms|s)$/
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.-]{1,30})?$/
const SCHEMA: Record<string, RegExp> = {
  srv: /^([0-9a-f]{4}|s\d{1,3})$/, conn: /^[0-9a-z]{1,8}$/, acct: /^[0-9a-f]{6}$/,
  chan: NUM, room: NUM, n: NUM, count: NUM, close: NUM, port: NUM, exit: NUM, status: NUM, loss: NUM, gz: NUM, deleted: NUM,
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

/** The only free text a line may carry (`msg=`): an error's first line, scrubbed. Made by {@link errorFields}. */
export class LogMessage {
  readonly text: string
  constructor(text: string) {
    this.text = text
  }
}

export type LogValue = string | number | boolean | LogMessage | null | undefined
export type LogFields = [string, LogValue][]

export interface LogEntry {
  at: number
  level: LogLevel
  src: LogSource
  area: string
  event: string
  code: string | null
  fields: [string, string][]
}

/** A value already written as text, kept only in its key's shape. */
function fieldText(key: string, text: string): string | null {
  if (!FIELDS.has(key) || key === 'msg') return null
  return (SCHEMA[key] ?? WORD).test(text) ? text : null
}

function messageText(text: string): string | null {
  const clean = scrub(text)
  if (!clean) return null
  if (PLAIN_MSG.test(clean)) return clean
  const cut = clean.length > MAX_MSG ? `${clean.slice(0, MAX_MSG - 1)}…` : clean
  return `"${cut.replace(/"/g, "'").replace(/[\u0000-\u001f\u007f]/g, ' ')}"`
}

export function logValue(key: string, value: LogValue): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return fieldText(key, value ? 'yes' : 'no')
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    return fieldText(key, Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100))
  }
  if (typeof value === 'string') return fieldText(key, value)
  return value instanceof LogMessage && key === 'msg' ? messageText(value.text) : null
}

/** An entry as it may be written, or null. Unknown areas become `misc`, unknown events `note`, unknown keys go. */
export function makeEntry(at: number, level: LogLevel, src: LogSource, area: string, event: string, code: string | null | undefined, fields: LogFields = []): LogEntry | null {
  if (!Number.isFinite(at) || at < 0 || !LEVELS.includes(level) || !SOURCES.includes(src)) return null
  const kept: [string, string][] = []
  for (const [key, value] of fields) {
    if (kept.some(([k]) => k === key)) continue
    const text = logValue(key, value)
    if (text !== null) kept.push([key, text])
  }
  const good = typeof code === 'string' && CODE.test(code) ? code : null
  return {
    at: Math.floor(at), level, src,
    area: AREAS.includes(area) ? area : 'misc',
    event: typeof event === 'string' && EVENT.test(event) ? event : 'note',
    code: good ?? (level === 'WARN' || level === 'ERROR' ? (src === 'app' ? 'ERR-900' : 'DSK-900') : null),
    fields: kept,
  }
}

export function formatLine(e: LogEntry): string {
  const head = `${new Date(e.at).toISOString()} ${e.level.padEnd(5)} ${e.src.padEnd(5)} ${e.area.padEnd(6)} ${e.event.padEnd(11)} ${(e.code ?? '-').padEnd(7)}`
  const body = e.fields.map(([k, v]) => `${k}=${v}`).join(' ')
  return (body ? `${head} ${body}` : head).trimEnd()
}

/** Milliseconds the way the server writes a duration: `497ms`, `6.7s`, `312s`. */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return ms < 99_950 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 1000)}s`
}

/** Takes out URLs past their host, emails, paths, IP addresses and long tokens (the server's rules). */
export function scrub(input: string): string {
  let text = input.length > 2000 ? input.slice(0, 2000) : input
  text = text.replace(/([A-Za-z][A-Za-z0-9+.-]{1,9}):\/\/(\[[^\]]*\]|[^/\s:?#"']+)(:\d+)?[^\s"']*/g, (_m, scheme: string, host: string) =>
    `${scheme}://${/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') ? '<ip>' : host}/…`)
  text = text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
  text = text.replace(/(?<![A-Za-z])[A-Za-z]:[\\/][^\s"']*|\\\\[^\s"']+/g, '<path>')
  text = text.replace(/(?<![\w.:/<])\/(?:home|Users|var|tmp|root|etc|opt|srv|mnt|private|usr|run|data|Volumes|Library|Applications)(?:\/[^\s"']*)?/g, '<path>')
  text = text.replace(/(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?![\d.])/g, '<ip>')
  text = text.replace(/(?<![\w:])\[?(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}\]?(?:%\w+)?(?::\d+)?(?![\w:])/g, '<ip>')
  text = text.replace(/[A-Za-z0-9_+/=-]{20,}/g, (m) => (m.length >= 32 || /\d/.test(m) ? '<token>' : m))
  return text.replace(/[\r\n]/g, ' ').trim()
}

/**
 * What an error may say: its class, its code (ENOENT, ERR_UPDATER_…), where (a file and line of ours, never a path),
 * and with `withMessage` its first line, scrubbed: only for errors whose wording is a library's own (the updater's).
 */
export function errorFields(error: unknown, withMessage = false): LogFields {
  const e = error as { name?: unknown; message?: unknown; code?: unknown; stack?: unknown } | null | undefined
  const name = typeof e?.name === 'string' && /^[A-Z][A-Za-z]{0,39}$/.test(e.name) ? e.name : 'Error'
  const fields: LogFields = [['name', name]]
  if (typeof e?.code === 'string') fields.push(['why', e.code.toLowerCase().replace(/_/g, '-').slice(0, 40)])
  if (typeof e?.stack === 'string') {
    const m = /([\w.-]+\.(?:js|mjs|ts)):(\d+):(\d+)\)?\s*$/m.exec(e.stack.split('\n').slice(1, 4).join('\n'))
    if (m) fields.push(['frame', `${m[1]}:${m[2]}:${m[3]}`])
  }
  if (withMessage && typeof e?.message === 'string') fields.push(['msg', new LogMessage(e.message.split('\n')[0])])
  return fields
}

// ── The page's lines ────────────────────────────────────────────────────────

/**
 * One of the page's entries (iskra:log), checked again here as if it came from anywhere: source forced to `app`,
 * every field re-checked by its key's shape; a message is accepted only already quoted, and scrubbed again.
 */
export function pageEntry(raw: unknown, now: number): LogEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const at = typeof r.at === 'number' && Math.abs(r.at - now) < 60_000 ? r.at : now
  const level = LEVELS.includes(r.level as LogLevel) ? (r.level as LogLevel) : null
  if (!level || level === 'DEBUG' || typeof r.area !== 'string' || typeof r.event !== 'string') return null
  const fields: LogFields = []
  if (Array.isArray(r.fields)) {
    for (const pair of r.fields.slice(0, 24)) {
      if (!Array.isArray(pair) || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') continue
      const [key, text] = pair as [string, string]
      fields.push([key, key === 'msg' ? new LogMessage(text.replace(/^"|"$/g, '')) : text])
    }
  }
  return makeEntry(at, level, 'app', r.area, r.event, typeof r.code === 'string' ? r.code : null, fields)
}

// ── Retention ───────────────────────────────────────────────────────────────

export interface Retention {
  /** Days a file stays plain text. */
  plainDays: number
  /** Days a file is kept at all (gzipped after plainDays). */
  keepDays: number
  /** All log files together: over it, the oldest go first, whatever their age. */
  maxMb: number
}
export const RETENTION: Retention = { plainDays: 60, keepDays: 180, maxMb: 50 }

const DAY = /^(\d{4}-\d{2}-\d{2})\.log(\.gz)?$/
const DAY_MS = 86_400_000

export const fileName = (at: number) => `${new Date(at).toISOString().slice(0, 10)}.log`

/** The day files in `dir` (`YYYY-MM-DD.log` and `.log.gz`); anything else is left alone. */
function dayFiles(dir: string): { file: string; day: number; zipped: boolean }[] {
  return readdirSync(dir).flatMap((name) => {
    const m = DAY.exec(name)
    const day = m ? Date.parse(`${m[1]}T00:00:00Z`) : Number.NaN
    return m && Number.isFinite(day) ? [{ file: path.join(dir, name), day, zipped: !!m[2] }] : []
  })
}

const size = (file: string) => {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

const tryDelete = (file: string) => {
  try {
    if (!existsSync(file)) return false
    unlinkSync(file)
    return true
  } catch {
    return false
  }
}

/** Crash-safe: to a temp name, flushed to disk, renamed, and only then the plain file goes. */
function compress(file: string): boolean {
  const target = `${file}.gz`
  const temp = `${target}.tmp`
  try {
    if (!existsSync(target)) {
      const data = gzipSync(readFileSync(file), { level: 9 })
      const fd = openSync(temp, 'w')
      try {
        writeSync(fd, data)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(temp, target)
    }
    // Already compressed (a run that stopped right after the rename): the plain copy just goes.
    unlinkSync(file)
    return true
  } catch {
    tryDelete(temp)
    return false
  }
}

/**
 * The retention stairs, as the server runs them (LogRetention.cs): plain for `plainDays`, gzipped until `keepDays`,
 * then deleted, and never more than `maxMb` in all (oldest first, gzipped before plain). Today's file is never
 * touched; leftovers of an interrupted run (.tmp) go; a file that can't be read is skipped.
 */
export function runRetention(dir: string, now: number, settings: Retention = RETENTION): { compressed: number; deleted: number; skipped: number; bytes: number } {
  let compressed = 0, deleted = 0, skipped = 0
  if (!existsSync(dir)) return { compressed, deleted, skipped, bytes: 0 }
  const today = Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00Z`)
  for (const name of readdirSync(dir)) if (name.endsWith('.tmp') && tryDelete(path.join(dir, name))) deleted++
  for (const { file, day, zipped } of dayFiles(dir)) {
    const age = Math.round((today - day) / DAY_MS)
    if (age <= 0) continue
    if (age > settings.keepDays) {
      if (tryDelete(file)) deleted++
      else skipped++
    } else if (!zipped && age > settings.plainDays) {
      if (compress(file)) compressed++
      else skipped++
    }
  }
  const cap = settings.maxMb * 1024 * 1024
  const files = dayFiles(dir).map((f) => ({ ...f, bytes: size(f.file) }))
  let total = files.reduce((sum, f) => sum + f.bytes, 0)
  const oldestFirst = files.filter((f) => f.day < today).sort((a, b) => a.day - b.day || (a.zipped ? 0 : 1) - (b.zipped ? 0 : 1))
  for (const f of oldestFirst) {
    if (total <= cap) break
    if (tryDelete(f.file)) {
      total -= f.bytes
      deleted++
    }
  }
  return { compressed, deleted, skipped, bytes: total }
}

// ── The log ─────────────────────────────────────────────────────────────────

/** How far back a bug report reaches. */
export const TAIL_MS = 30 * 60_000
const TAIL_BYTES = 512 * 1024

export class DeskLog {
  private dir: string | null = null
  private readonly now: () => number
  private readonly echo: boolean
  /** Lines from before the folder was known (the first moments of a start). */
  private early: string[] = []

  constructor(options: { now?: () => number; echo?: boolean } = {}) {
    this.now = options.now ?? (() => Date.now())
    this.echo = options.echo ?? false
  }

  /** Where the files go (userData/logs); lines written before this are kept and written now. */
  open(dir: string): void {
    this.dir = dir
    const early = this.early
    this.early = []
    for (const line of early) this.append(line)
  }

  get folder(): string | null {
    return this.dir
  }

  write(level: LogLevel, src: LogSource, area: string, event: string, code: string | null, fields: LogFields = []): void {
    try {
      const entry = makeEntry(this.now(), level, src, area, event, code, fields)
      if (entry && entry.level !== 'DEBUG') this.append(formatLine(entry))
    } catch {
      /* logging never throws */
    }
  }

  info(area: string, event: string, fields: LogFields = [], src: LogSource = 'desk'): void {
    this.write('INFO', src, area, event, null, fields)
  }

  /** An info line with a code (an end nobody asked for, but nothing wrong). */
  note(code: string, area: string, event: string, fields: LogFields = [], src: LogSource = 'desk'): void {
    this.write('INFO', src, area, event, code, fields)
  }

  warn(code: string, area: string, event: string, fields: LogFields = [], src: LogSource = 'desk'): void {
    this.write('WARN', src, area, event, code, fields)
  }

  error(code: string, area: string, event: string, error: unknown, fields: LogFields = [], src: LogSource = 'desk'): void {
    this.write('ERROR', src, area, event, code, [...fields, ...errorFields(error)])
  }

  /** One of the page's entries, checked again (pageEntry). */
  fromPage(raw: unknown): void {
    try {
      const entry = pageEntry(raw, this.now())
      if (entry) this.append(formatLine(entry))
    } catch {
      /* never */
    }
  }

  /** The lines of the last `ms` (yesterday's file too, around midnight), oldest first, for a bug report. */
  tail(ms = TAIL_MS): string[] {
    const now = this.now()
    const since = new Date(now - ms).toISOString()
    const lines: string[] = []
    if (!this.dir) return this.early.filter((l) => l.slice(0, 24) >= since)
    for (const name of new Set([fileName(now - ms), fileName(now)])) {
      for (const line of readTail(path.join(this.dir, name), TAIL_BYTES)) if (line.slice(0, 24) >= since) lines.push(line)
    }
    return lines.slice(-3000)
  }

  /** The retention stairs over the folder. */
  sweep(settings: Retention = RETENTION): ReturnType<typeof runRetention> | null {
    if (!this.dir) return null
    try {
      return runRetention(this.dir, this.now(), settings)
    } catch {
      return null
    }
  }

  private append(line: string): void {
    if (this.echo) console.log(line)
    if (!this.dir) {
      this.early.push(line)
      if (this.early.length > 500) this.early.shift()
      return
    }
    try {
      mkdirSync(this.dir, { recursive: true })
      // Opened per line: nothing held open, a crash loses at most the line being written.
      appendFileSync(path.join(this.dir, fileName(this.now())), `${line}\n`)
    } catch {
      /* the log is a convenience: never let it break the app */
    }
  }
}

/** The last `max` bytes of a file as whole lines (none if it isn't there). */
function readTail(file: string, max: number): string[] {
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    const length = fstatSync(fd).size
    const start = Math.max(0, length - max)
    const buffer = Buffer.alloc(length - start)
    readSync(fd, buffer, 0, buffer.length, start)
    const lines = buffer.toString('utf8').split('\n')
    if (start > 0) lines.shift() // a partial first line
    return lines.filter(Boolean)
  } catch {
    return []
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/** The app's one log (main.ts opens it in userData/logs). */
export const deskLog = new DeskLog({ echo: !!process.env.ISKRA_DEV_URL })
