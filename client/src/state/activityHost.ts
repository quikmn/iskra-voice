// The app's side of the activity SDK (docs/activities.md): what an activity's frame may ask, checked here before
// anything reaches the server, and the messages the app sends it. Pure functions: no DOM, no React.
import type { ActivityMessage } from '../core/protocol'

export const SDK_VERSION = 1
/** Same limits as the server's (PROTOCOL.md → Activities). */
export const MAX_DATA_BYTES = 8 * 1024
export const MAX_STATE_BYTES = 48 * 1024
/** In the desktop app's walled view an activity has no parent frame: it writes console lines starting with this. */
export const WALL_LINE = '\u2063iskra-activity:'

export const BUILTIN_ACTIVITIES = ['draw', 'trivia', 'four'] as const
export type BuiltinActivity = (typeof BUILTIN_ACTIVITIES)[number]
export const isBuiltin = (id: string): id is BuiltinActivity => (BUILTIN_ACTIVITIES as readonly string[]).includes(id)

/** What a frame may ask the app. */
export type FrameRequest =
  | { type: 'ready' }
  | { type: 'send'; data: unknown }
  | { type: 'state'; seq: number; state: unknown }
  | { type: 'end' }

const encoder = new TextEncoder()

/** The value as plain JSON (what the server will relay) and its size in UTF-8 bytes; null if it isn't JSON. */
export function asJson(value: unknown): { value: unknown; bytes: number } | null {
  let text: string | undefined
  try {
    text = JSON.stringify(value)
  } catch {
    return null // cycles, BigInt
  }
  if (text === undefined) return null // undefined, functions, symbols
  return { value: JSON.parse(text), bytes: encoder.encode(text).length }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Checks a message from a frame: the SDK version, a known type, JSON payloads within the limits. Anything else is null. */
export function parseFrameRequest(raw: unknown): FrameRequest | null {
  if (!isObject(raw) || raw.iskra !== SDK_VERSION || typeof raw.type !== 'string') return null
  switch (raw.type) {
    case 'ready':
    case 'end':
      return { type: raw.type }
    case 'send': {
      const data = asJson(raw.data)
      return data && data.bytes <= MAX_DATA_BYTES ? { type: 'send', data: data.value } : null
    }
    case 'state': {
      const state = asJson(raw.state)
      const seq = raw.seq
      if (!state || state.bytes > MAX_STATE_BYTES || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return null
      return { type: 'state', seq, state: state.value }
    }
    default:
      return null
  }
}

/** What a frame may send: well under the server's act.send limit (20/s, burst 40). */
export const SEND_PER_SECOND = 10
export const SEND_BURST = 20
/** Console lines a walled view may write (only the SDK's count, checked by prefix and length first). */
export const WALL_LINES_PER_SECOND = 30
export const WALL_LINE_BURST = 60
/** The longest line the SDK can write: a 48 KB snapshot in its envelope. */
export const MAX_WALL_LINE = MAX_STATE_BYTES + 512

/** A line that could be the SDK's: its prefix, not too long. Cheap: no parsing. */
export const isWallLine = (line: string): boolean => line.length <= MAX_WALL_LINE && line.startsWith(WALL_LINE)

/** A console line from the desktop app's walled view, or null if it isn't one of the SDK's. */
export function parseWallLine(line: unknown): FrameRequest | null {
  if (typeof line !== 'string' || !isWallLine(line)) return null
  try {
    return parseFrameRequest(JSON.parse(line.slice(WALL_LINE.length)))
  } catch {
    return null
  }
}

/** A token bucket, so an activity can't use up the connection's own limits (the server has the same ones). */
export class TokenBucket {
  private tokens: number
  private at: number
  private readonly burst: number
  private readonly perSecond: number
  private readonly now: () => number
  constructor(burst: number, perSecond: number, now: () => number = Date.now) {
    this.burst = burst
    this.perSecond = perSecond
    this.now = now
    this.tokens = burst
    this.at = now()
  }

  take(): boolean {
    const now = this.now()
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.perSecond)
    this.at = now
    if (this.tokens < 1) return false
    this.tokens -= 1
    return true
  }
}

/**
 * The messages to hand the frame next, in order: those after `after` from both lists, each seq once. A join's answer
 * and live messages can overlap (or the first live one can come before the answer), so both go through here.
 */
export function nextMessages(after: number, ...lists: ActivityMessage[][]): ActivityMessage[] {
  const bySeq = new Map<number, ActivityMessage>()
  for (const list of lists) for (const m of list) if (m.seq > after && !bySeq.has(m.seq)) bySeq.set(m.seq, m)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

export interface FramePlayer {
  id: string
  name: string
}

export interface FrameTheme {
  scheme: 'dark' | 'light'
  colors: Record<string, string>
}

/** Theme colours an activity gets: only plain colour values (the app's CSS variables), never anything else. */
export function frameTheme(read: (variable: string) => string, scheme: 'dark' | 'light'): FrameTheme {
  const colors: Record<string, string> = {}
  for (const [name, variable] of Object.entries(THEME_VARIABLES)) {
    const value = read(variable).trim()
    if (/^(#[0-9a-fA-F]{3,8}|rgba?\([0-9.,\s%]+\))$/.test(value)) colors[name] = value
  }
  return { scheme, colors }
}

const THEME_VARIABLES = {
  bg: '--stage', surface: '--surface', surface2: '--surface-2', border: '--border', text: '--text', muted: '--muted',
  accent: '--accent', green: '--green', red: '--red', amber: '--amber',
} as const

/** The frame's first message: who you are, who's playing, the snapshot, language and colours. */
export function initMessage(init: {
  me: FramePlayer
  players: FramePlayer[]
  state: unknown
  stateSeq: number
  locale: string
  theme: FrameTheme
  activity: { id: string; name: string }
}) {
  return { iskra: SDK_VERSION, type: 'init' as const, ...init }
}

export const playersMessage = (players: FramePlayer[]) => ({ iskra: SDK_VERSION, type: 'players' as const, players })
export const messageMessage = (m: ActivityMessage) => ({ iskra: SDK_VERSION, type: 'message' as const, seq: m.seq, from: m.from, data: m.data })
export const endedMessage = () => ({ iskra: SDK_VERSION, type: 'ended' as const })

/** Code the desktop app runs in a walled view to hand it a message (the JSON is a safe JS literal). */
export const wallScript = (message: object) => `window.postMessage(${JSON.stringify(message).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')}, '*')`
