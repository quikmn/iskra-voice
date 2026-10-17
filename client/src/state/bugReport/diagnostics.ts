// Diagnostics for bug reports: a small in-memory ring buffer of the app's log entries (core/log.ts: the same line
// format as the server, an allowlist of areas and fields, so message text, names, keys, addresses and links can't
// get in). Debug lines are never kept. Lost on reload (the desktop app also keeps them in its own log file).
import { addLogSink, isCheckedEntry, makeEntry, type LogEntry } from '../../core/log'

export const MAX_ENTRIES = 500
export const MAX_AGE_MS = 30 * 60_000
/** When this page started (the report's uptime). */
export const APP_STARTED_AT = Date.now()

/** A bounded log: the newest MAX_ENTRIES entries from the last MAX_AGE_MS. */
export class DiagnosticsBuffer {
  private items: LogEntry[] = []
  private readonly max: number
  private readonly maxAgeMs: number

  constructor(max = MAX_ENTRIES, maxAgeMs = MAX_AGE_MS) {
    this.max = max
    this.maxAgeMs = maxAgeMs
  }

  /** Anything that isn't an entry the log made is checked again on the way in (and loses any text). */
  add(raw: LogEntry): void {
    if (!raw || typeof raw !== 'object' || raw.level === 'DEBUG') return
    const entry = isCheckedEntry(raw) ? raw : makeEntry(raw.at, raw.level, raw.src, raw.area, raw.event, raw.code, raw.fields)
    if (!entry) return
    this.items.push(entry)
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max)
  }

  entries(now = Date.now()): LogEntry[] {
    const since = now - this.maxAgeMs
    this.items = this.items.filter((e) => e.at >= since)
    return [...this.items]
  }

  clear(): void {
    this.items = []
  }
}

export const diagnostics = new DiagnosticsBuffer()
addLogSink((entry) => diagnostics.add(entry))

// ── The final net ───────────────────────────────────────────────────────────

const NETS: RegExp[] = [
  /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, // any URL (invite links, server addresses, files)
  /\b[\w.+-]+@[\w-]+(\.[\w-]+)+\b/g, // email addresses
  /\b(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g, // IPv4
  // IPv6: all eight groups, or shortened with "::" (times like 12:03:04 have neither).
  /\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b|(?:\b[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}\b(?::[0-9a-f]{1,4}\b)*)?|::(?:[0-9a-f]{1,4}\b(?::[0-9a-f]{1,4}\b)*)/gi,
  /\b[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, // JWT-like tokens
  /[A-Za-z0-9+/_-]{24,}={0,2}/g, // keys, tokens, ids (base64 / base64url / long hex)
]

/** Applied to the logs as a whole after the allowlist: anything shaped like an address, a key or a token goes. */
export function finalNet(text: string): string {
  let out = text
  for (const net of NETS) out = out.replace(net, '[removed]')
  return out
}
