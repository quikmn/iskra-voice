// What a bug report sends, built from pure parts so tests can check every field. The reporter's own words go as they
// typed them (and they see them in "See what's included"); everything else is structured, allowlisted and netted.
import { cleanLine, duration, formatLine, parseLine, type LogEntry, type ParsedLine } from '../../core/log'
import { finalNet, MAX_AGE_MS } from './diagnostics'

export const MAX_WHAT = 1500
export const MAX_STEPS = 1400
export const MAX_EXPECTED = 600
export const MAX_EMAIL = 254
export const MAX_LOGS = 64 * 1024
export const MAX_IMAGES = 5
export const MAX_IMAGE_BYTES = 1536 * 1024

export type Device = 'desktop' | 'web' | 'ios' | 'android'
export type ImageType = 'image/png' | 'image/jpeg' | 'image/webp'

export interface ReportEnv {
  version: string
  commit: string
  os: string
  browser?: string
  device: Device
  language?: string
}

export interface ReportImage {
  type: ImageType
  /** Base64, already downscaled and re-encoded (no EXIF). */
  data: string
  bytes: number
  width: number
  height: number
}

export interface ReportDraft {
  what: string
  steps: string
  expected: string
  email: string
  includeLogs: boolean
  images: ReportImage[]
}

/** What POST /bug-reports gets (PROTOCOL.md "Bug inbox"). */
export interface ReportPayload {
  v: 1
  what: string
  steps?: string
  expected?: string
  email?: string
  env: ReportEnv
  logs?: string
  images?: { type: ImageType; data: string }[]
}

/** Settings worth knowing about, by allowlist: on/off switches and choices from fixed lists, never ids or names. */
export type SettingsSnapshot = Record<string, string | number | boolean | null>

export interface VoiceSnapshot {
  state: 'none' | 'connecting' | 'connected' | 'reconnecting'
  call?: 'channel' | 'dm' | 'group'
  micEngine?: string | null
  cleanEngine?: string | null
  hifi?: boolean
  codec?: string
  /** Percent of packets lost, sent and received. */
  lossOut?: number
  lossIn?: number
  jitterMs?: number
  rttMs?: number
}

export const STEPS_TEMPLATE = '1. \n2. \n3. '

export const emptyDraft = (): ReportDraft => ({ what: '', steps: STEPS_TEMPLATE, expected: '', email: '', includeLogs: true, images: [] })

const EMAIL = /^[^\s@<>()[\],;:"]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/
export const validEmail = (email: string) => EMAIL.test(email.trim())

/** The steps box starts with "1. 2. 3."; untouched, it says nothing. */
const meaningfulSteps = (steps: string) => steps.replace(/^\s*\d+\.\s*$/gm, '').trim().length > 0

export function canSend(draft: ReportDraft): boolean {
  const email = draft.email.trim()
  return draft.what.trim().length > 0 && draft.what.length <= MAX_WHAT && draft.steps.length <= MAX_STEPS
    && draft.expected.length <= MAX_EXPECTED && (email === '' || validEmail(email)) && draft.images.length <= MAX_IMAGES
}

export function buildPayload(draft: ReportDraft, env: ReportEnv, logs: string | null): ReportPayload {
  const payload: ReportPayload = { v: 1, what: draft.what.trim(), env }
  if (meaningfulSteps(draft.steps)) payload.steps = draft.steps.trim()
  if (draft.expected.trim()) payload.expected = draft.expected.trim()
  if (draft.email.trim()) payload.email = draft.email.trim()
  if (draft.includeLogs && logs) payload.logs = logs.slice(0, MAX_LOGS)
  if (draft.images.length) payload.images = draft.images.slice(0, MAX_IMAGES).map(({ type, data }) => ({ type, data }))
  return payload
}

/** The payload as "See what's included" shows it: exactly what's sent, with each image's bytes summarised. */
export function previewPayload(payload: ReportPayload): string {
  const shown = { ...payload, images: payload.images?.map((image, i) => ({ type: image.type, data: `<image ${i + 1}: ${Math.round(base64Bytes(image.data) / 1024)} KB>` })) }
  if (!shown.images) delete shown.images
  return JSON.stringify(shown, null, 2)
}

export const base64Bytes = (data: string) => Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)

// ── Environment ─────────────────────────────────────────────────────────────

const PLATFORM = /^[A-Za-z0-9 ._()/-]{1,40}$/

/** "Windows", "macOS", "Linux", "Android 15", "iOS 18.2", "ChromeOS"; and the browser and its major version. */
export function platformInfo(userAgent: string): { os: string; browser?: string } {
  const ua = userAgent
  let os = 'Unknown'
  const android = /Android (\d+(?:\.\d+)?)/.exec(ua)
  const ios = /(?:iPhone|iPad|iPod).*? OS (\d+)[_.](\d+)/.exec(ua)
  if (android) os = `Android ${android[1]}`
  else if (ios) os = `iOS ${ios[1]}.${ios[2]}`
  else if (/CrOS/.test(ua)) os = 'ChromeOS'
  else if (/Windows/.test(ua)) os = 'Windows'
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS'
  else if (/Linux|X11/.test(ua)) os = 'Linux'
  // The first that matches: Electron and Edge also say "Chrome", Chrome also says "Safari".
  const browsers: [string, RegExp][] = [
    ['Electron', /Electron\/(\d+)/], ['Edge', /Edg\/(\d+)/], ['Firefox', /Firefox\/(\d+)/], ['Chrome', /Chrome\/(\d+)/], ['Safari', /Version\/(\d+)[\d.]* .*Safari/],
  ]
  for (const [name, pattern] of browsers) {
    const m = pattern.exec(ua)
    if (m) {
      const browser = `${name} ${m[1]}`
      return PLATFORM.test(browser) ? { os, browser } : { os }
    }
  }
  return { os }
}

// ── Logs ────────────────────────────────────────────────────────────────────

const value = (v: string | number | boolean | null) => (v === null ? 'auto' : String(v))
const SETTING_KEY = /^[a-zA-Z]{1,22}$/
const SETTING_VALUE = /^[a-z0-9.-]{1,16}$/i

export interface LogsInput {
  now: number
  env: ReportEnv
  settings: SettingsSnapshot
  voice: VoiceSnapshot
  /** This app's entries (the diagnostics buffer). */
  entries: LogEntry[]
  /** When this app started (the header's uptime). */
  startedAt?: number
  /** Lines from the desktop app's log (main process, updater, and this page's lines from before a reload). */
  extra?: string[]
}

const clock = (time: string) => time.slice(11, 19)

function uptime(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

/** One row per server (srv=): its connection id, path, state, how long the last connect took, retries, last close. */
function serverRows(lines: ParsedLine[]): string[] {
  const rows = new Map<string, { conn?: string; path?: string; state: string; took?: string; retries: number; close?: string; code?: string }>()
  for (const l of lines) {
    if (l.src !== 'app' || l.area !== 'conn' || !l.fields.srv) continue
    const row = rows.get(l.fields.srv) ?? { state: '?', retries: 0 }
    row.state = l.event
    if (l.fields.conn) row.conn = l.fields.conn
    if (l.fields.path) row.path = l.fields.path
    if (l.event === 'online') {
      row.took = l.fields.took
      row.retries = 0
    }
    if (l.event === 'offline') row.retries++
    if (l.fields.close) row.close = l.fields.close
    if (l.code) row.code = l.code
    rows.set(l.fields.srv, row)
  }
  return [...rows].map(([srv, r]) =>
    [`srv=${srv}`, r.conn && `conn=${r.conn}`, r.path && `path=${r.path}`, `state=${r.state}`, r.took && `took=${r.took}`,
      r.retries > 0 && `retries=${r.retries}`, r.close && `last-close=${r.close}`, r.code && `last-code=${r.code}`].filter(Boolean).join(' '))
}

/** Each voice session: when it started and ended, where, why it ended (and the code), how long it lasted. */
function voiceRows(lines: ParsedLine[]): string[] {
  const rows: string[] = []
  let open: ParsedLine | null = null
  const where = (l: ParsedLine) => ['srv', 'conn', 'chan', 'call'].filter((k) => l.fields[k]).map((k) => `${k}=${l.fields[k]}`).join(' ')
  for (const l of lines) {
    if (l.src !== 'app' || l.area !== 'voice') continue
    if (l.event === 'connecting') open = l
    else if (l.event === 'joined') open = open ? { ...l, time: open.time } : l
    else if (l.event === 'left') {
      const start = open ? clock(open.time) : '?'
      rows.push(`${start} → ${clock(l.time)} ${where(open ?? l)} reason=${l.fields.reason ?? '?'}${l.code ? ` ${l.code}` : ''}${l.fields.dur ? ` (${l.fields.dur})` : ''}`)
      open = null
    }
  }
  if (open) rows.push(`${clock(open.time)} → now ${where(open)}`)
  return rows
}

/** Codes with how often and when they came (first and last). */
function problemRows(lines: ParsedLine[]): string[] {
  const codes = new Map<string, { count: number; first: string; last: string }>()
  for (const l of lines) {
    if (!l.code) continue
    const c = codes.get(l.code)
    if (c) {
      c.count++
      c.last = l.time
    } else codes.set(l.code, { count: 1, first: l.time, last: l.time })
  }
  return [...codes].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .map(([code, c]) => `${code.padEnd(7)} x${c.count}  ${clock(c.first)}${c.count > 1 ? ` .. ${clock(c.last)}` : ''}`)
}

const stamp = (line: string) => line.slice(0, 24)

/**
 * The logs as text: a header (version, platform, report time, uptime, settings, voice), then sections built from the
 * lines (Servers, Voice, Problems), then the Timeline in the log line format, with a gap marker where more than 5 s
 * passed. Over the size cap the oldest timeline lines go first. Then the final net over all of it.
 */
export function renderLogs(input: LogsInput): string {
  const { env, settings, voice } = input
  const head: string[] = []
  head.push(`Iskra ${env.version} (${env.commit}) ${env.device}, ${env.os}${env.browser ? `, ${env.browser}` : ''}${env.language ? `, ${env.language}` : ''}`)
  head.push(`report at ${new Date(input.now).toISOString()}${input.startedAt ? `, up ${uptime(input.now - input.startedAt)}` : ''}`)
  const shown = Object.entries(settings)
    .filter(([k, v]) => SETTING_KEY.test(k) && (typeof v !== 'string' || SETTING_VALUE.test(v)) && (typeof v !== 'number' || Number.isFinite(v)))
    .map(([k, v]) => `${k}=${value(v)}`)
  head.push(`settings: ${shown.join(' ')}`)
  const v = voice
  const parts = [`voice: ${v.state}`]
  if (v.call) parts.push(v.call)
  if (v.micEngine) parts.push(`mic ${v.micEngine}`)
  if (v.cleanEngine) parts.push(`clean ${v.cleanEngine}`)
  if (v.hifi) parts.push('hifi')
  if (v.codec) parts.push(`codec ${v.codec}`)
  if (v.lossOut !== undefined) parts.push(`loss out ${v.lossOut.toFixed(1)}%`)
  if (v.lossIn !== undefined) parts.push(`loss in ${v.lossIn.toFixed(1)}%`)
  if (v.jitterMs !== undefined) parts.push(`jitter ${Math.round(v.jitterMs)}ms`)
  if (v.rttMs !== undefined) parts.push(`rtt ${Math.round(v.rttMs)}ms`)
  head.push(parts.join(', '))

  // One timeline ordered by time: this app's entries and the desktop app's lines (each checked against the format).
  const since = new Date(input.now - MAX_AGE_MS).toISOString()
  const extra = (input.extra ?? []).flatMap((line) => {
    const clean = cleanLine(line)
    return clean && clean.slice(0, 24) >= since && parseLine(clean)?.level !== 'DEBUG' ? [clean] : []
  })
  const timeline = [...input.entries.map(formatLine), ...extra].sort((a, b) => (stamp(a) < stamp(b) ? -1 : stamp(a) > stamp(b) ? 1 : 0))
  const parsed = timeline.map(parseLine).filter((l): l is ParsedLine => l !== null)

  const section = (title: string, rows: string[]) => (rows.length ? ['', `== ${title} ==`, ...rows] : [])
  head.push(...section('Servers', serverRows(parsed)), ...section('Voice', voiceRows(parsed)), ...section('Problems', problemRows(parsed)))

  // The timeline, the newest lines kept when it doesn't all fit.
  const withGaps: string[] = []
  let previous = 0
  for (const line of timeline) {
    const at = Date.parse(stamp(line))
    if (previous && at - previous > 5000) withGaps.push(`-- +${duration(at - previous)} --`)
    withGaps.push(line)
    previous = at
  }
  const budget = MAX_LOGS - head.join('\n').length - 200
  let used = 0
  let first = withGaps.length
  while (first > 0 && used + withGaps[first - 1].length + 1 <= budget) used += withGaps[--first].length + 1
  const kept = withGaps.slice(first).filter((l) => !l.startsWith('-- ')).length
  const dropped = timeline.length - kept
  head.push('', `== Timeline (UTC, last 30 minutes, ${timeline.length} lines${dropped ? `, the oldest ${dropped} left out` : ''}) ==`)
  return finalNet([...head, ...withGaps.slice(first)].join('\n')).slice(0, MAX_LOGS)
}

// ── Saving instead of sending ───────────────────────────────────────────────

/** report.json (exactly the payload) plus the screenshots as files, for "Save as a file" and "Email it instead". */
export function reportFiles(payload: ReportPayload): { name: string; data: Uint8Array }[] {
  const encoder = new TextEncoder()
  const { images, ...rest } = payload
  const files = [{ name: 'report.json', data: encoder.encode(JSON.stringify(rest, null, 2)) }]
  if (payload.logs) files.push({ name: 'logs.txt', data: encoder.encode(payload.logs) })
  images?.forEach((image, i) => {
    const ext = image.type === 'image/png' ? 'png' : image.type === 'image/jpeg' ? 'jpg' : 'webp'
    files.push({ name: `screenshot-${i + 1}.${ext}`, data: Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0)) })
  })
  return files
}
