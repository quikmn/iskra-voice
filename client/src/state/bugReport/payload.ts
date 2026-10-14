// What a bug report sends, built from pure parts so tests can check every field. The reporter's own words go as they
// typed them (and they see them in "See what's included"); everything else is structured, allowlisted and netted.
import { finalNet, type DiagEntry } from './diagnostics'

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

const time = (at: number) => new Date(at).toISOString().slice(11, 23)

function line(e: DiagEntry): string {
  switch (e.kind) {
    case 'connection':
      return `connection s${e.server} ${e.state}${e.code ? ` ${e.code}` : ''}${e.retryMs !== undefined ? ` retry ${e.retryMs}ms` : ''}`
    case 'request': return `request ${e.type} failed ${e.code}`
    case 'voice': return `voice ${e.state}${e.call ? ` ${e.call}` : ''}${e.engine ? ` engine ${e.engine}` : ''}`
    case 'error': return `error ${e.source} ${e.name}${e.frame ? ` at ${e.frame}` : ''}`
    case 'update': return `update ${e.state}${e.version ? ` ${e.version}` : ''}`
    case 'app': return `app ${e.event}`
  }
}

const value = (v: string | number | boolean | null) => (v === null ? 'auto' : String(v))
const SETTING_KEY = /^[a-zA-Z]{1,22}$/
const SETTING_VALUE = /^[a-z0-9.-]{1,16}$/i

/** The logs as text, then the final net over all of it. */
export function renderLogs(input: { now: number; env: ReportEnv; settings: SettingsSnapshot; voice: VoiceSnapshot; entries: DiagEntry[] }): string {
  const { env, settings, voice, entries } = input
  const out: string[] = []
  out.push(`Iskra ${env.version} (${env.commit}) on ${env.device}, ${env.os}${env.browser ? `, ${env.browser}` : ''}${env.language ? `, ${env.language}` : ''}`)
  out.push(`report at ${new Date(input.now).toISOString()}`)
  const shown = Object.entries(settings)
    .filter(([k, v]) => SETTING_KEY.test(k) && (typeof v !== 'string' || SETTING_VALUE.test(v)) && (typeof v !== 'number' || Number.isFinite(v)))
    .map(([k, v]) => `${k}=${value(v)}`)
  out.push(`settings: ${shown.join(' ')}`)
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
  out.push(parts.join(', '))
  out.push(`--- ${entries.length} entries, last 30 minutes (UTC) ---`)
  for (const e of entries) out.push(`${time(e.at)} ${line(e)}`)
  return finalNet(out.join('\n')).slice(0, MAX_LOGS)
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
