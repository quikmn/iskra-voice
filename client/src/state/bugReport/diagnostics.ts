// Diagnostics for bug reports: a small in-memory ring buffer of structured entries (connection states, request errors,
// voice, crashes, updates). Nothing here is ever free text: every entry is checked against an allowlist of kinds and
// fields with tight patterns, so message text, names, keys, addresses and links can't get in. Lost on reload.

import { VOICE_LEFT_REASONS, type VoiceLeftReason } from '../voiceLeft'

export const MAX_ENTRIES = 500
export const MAX_AGE_MS = 30 * 60_000

export type ConnState = 'connecting' | 'online' | 'offline' | 'restarting' | 'rejected'
export type VoiceState = 'connecting' | 'connected' | 'reconnecting' | 'left'

export type DiagEntry =
  /** `server`: a number per server in this session (1, 2, …), never its key, name or address. */
  | { at: number; kind: 'connection'; server: number; state: ConnState; code?: string; retryMs?: number }
  | { at: number; kind: 'request'; type: string; code: string }
  /** `reason`: why a session ended (`left` only): see VoiceLeftReason. */
  | { at: number; kind: 'voice'; state: VoiceState; call?: 'channel' | 'dm' | 'group'; engine?: string; reason?: VoiceLeftReason }
  /** An error's class name ("TypeError") and where it was thrown (a bundle file and line), never its message. */
  | { at: number; kind: 'error'; source: 'window' | 'promise' | 'render'; name: string; frame?: string }
  | { at: number; kind: 'update'; state: string; version?: string }
  | { at: number; kind: 'app'; event: 'start' | 'online' | 'offline' | 'visible' | 'hidden' }

const CODE = /^[a-z][a-z0-9_]{0,39}$/
const REQUEST_TYPE = /^[a-z][a-zA-Z0-9]{0,23}(\.[a-z][a-zA-Z0-9]{0,23}){0,3}$/
const ERROR_NAME = /^[A-Z][A-Za-z]{0,39}$/
const FRAME = /^[\w.-]{1,60}\.(js|mjs|ts|tsx):\d{1,7}:\d{1,7}$/
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]{1,40})?$/
const ENGINE = /^[a-z]{1,16}$/

const CONN_STATES: readonly ConnState[] = ['connecting', 'online', 'offline', 'restarting', 'rejected']
const VOICE_STATES: readonly VoiceState[] = ['connecting', 'connected', 'reconnecting', 'left']
const CALLS = ['channel', 'dm', 'group'] as const
const SOURCES = ['window', 'promise', 'render'] as const
const UPDATE_STATES = ['none', 'downloading', 'ready', 'available', 'error', 'checking'] as const
const APP_EVENTS = ['start', 'online', 'offline', 'visible', 'hidden'] as const

const isIn = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value)
const matches = (pattern: RegExp, value: unknown): value is string => typeof value === 'string' && pattern.test(value)
const whole = (value: unknown, max: number): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max ? value : undefined

/** The allowlist: an entry exactly as it may be kept, or null. Fields not listed here are dropped. */
export function sanitizeEntry(raw: unknown): DiagEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const at = whole(r.at, 8_640_000_000_000_000)
  if (at === undefined) return null
  switch (r.kind) {
    case 'connection': {
      const server = whole(r.server, 999)
      if (server === undefined || !isIn(CONN_STATES, r.state)) return null
      const entry: DiagEntry = { at, kind: 'connection', server, state: r.state }
      if (matches(CODE, r.code)) entry.code = r.code
      const retry = whole(r.retryMs, 3_600_000)
      if (retry !== undefined) entry.retryMs = retry
      return entry
    }
    case 'request':
      return matches(REQUEST_TYPE, r.type) && matches(CODE, r.code) ? { at, kind: 'request', type: r.type, code: r.code } : null
    case 'voice': {
      if (!isIn(VOICE_STATES, r.state)) return null
      const entry: DiagEntry = { at, kind: 'voice', state: r.state }
      if (isIn(CALLS, r.call)) entry.call = r.call
      if (matches(ENGINE, r.engine)) entry.engine = r.engine
      if (r.state === 'left' && isIn(VOICE_LEFT_REASONS, r.reason)) entry.reason = r.reason
      return entry
    }
    case 'error': {
      if (!isIn(SOURCES, r.source)) return null
      const entry: DiagEntry = { at, kind: 'error', source: r.source, name: matches(ERROR_NAME, r.name) ? r.name : 'Error' }
      if (matches(FRAME, r.frame)) entry.frame = r.frame
      return entry
    }
    case 'update': {
      if (!isIn(UPDATE_STATES, r.state)) return null
      const entry: DiagEntry = { at, kind: 'update', state: r.state }
      if (matches(VERSION, r.version)) entry.version = r.version
      return entry
    }
    case 'app':
      return isIn(APP_EVENTS, r.event) ? { at, kind: 'app', event: r.event } : null
    default:
      return null
  }
}

/** The bundle file and line an error came from ("index-3f2a.js:12:3456"): the first frame of its stack, if any. */
export function errorFrame(stack: unknown): string | undefined {
  if (typeof stack !== 'string') return undefined
  for (const line of stack.split('\n').slice(0, 6)) {
    const m = /([\w.-]+\.(?:js|mjs|ts|tsx)):(\d+):(\d+)\)?\s*$/.exec(line.trim())
    if (m) return `${m[1]}:${m[2]}:${m[3]}`
  }
  return undefined
}

/** A bounded log: the newest MAX_ENTRIES entries from the last MAX_AGE_MS. */
export class DiagnosticsBuffer {
  private items: DiagEntry[] = []
  private readonly max: number
  private readonly maxAgeMs: number

  constructor(max = MAX_ENTRIES, maxAgeMs = MAX_AGE_MS) {
    this.max = max
    this.maxAgeMs = maxAgeMs
  }

  record(raw: unknown): void {
    const entry = sanitizeEntry(raw)
    if (!entry) return
    this.items.push(entry)
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max)
  }

  entries(now = Date.now()): DiagEntry[] {
    const since = now - this.maxAgeMs
    this.items = this.items.filter((e) => e.at >= since)
    return [...this.items]
  }

  clear(): void {
    this.items = []
  }
}

export const diagnostics = new DiagnosticsBuffer()

/** Adds an entry (anything not on the allowlist is dropped). */
export const recordDiagnostic = (entry: Record<string, unknown>): void => diagnostics.record({ at: Date.now(), ...entry })

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
