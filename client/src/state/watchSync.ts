// Watch party sync math: where the shared clock says playback is, how far off this player is, and what to do about it.
// No DOM here (unit-tested).
import type { WatchParty, WatchSourceInput } from '../core/protocol'

export const WATCH_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]

/** Where the party is at `serverNow` (ms, server clock). Never goes backwards past the last update. */
export function positionAt(party: Pick<WatchParty, 'playing' | 'position' | 'rate' | 'updatedAt'>, serverNow: number): number {
  if (!party.playing) return party.position
  return party.position + (Math.max(0, serverNow - party.updatedAt) / 1000) * party.rate
}

export interface ClockSample {
  /** Server clock minus ours, in ms. */
  offset: number
  /** Round trip, in ms. */
  rtt: number
}

/** One request/response round: the server answered `serverNow` somewhere between `sentAt` and `receivedAt` (our clock). */
export function clockSample(sentAt: number, serverNow: number, receivedAt: number): ClockSample {
  return { offset: serverNow - (sentAt + receivedAt) / 2, rtt: Math.max(0, receivedAt - sentAt) }
}

/** The sample with the shortest round trip is the most accurate. */
export function bestOffset(samples: ClockSample[]): number {
  if (samples.length === 0) return 0
  return samples.reduce((best, s) => (s.rtt < best.rtt ? s : best)).offset
}

export type Correction =
  | { kind: 'none' }
  /** Jump to this position (seconds). */
  | { kind: 'seek'; to: number }
  /** Play slightly faster or slower than the party's rate until caught up. */
  | { kind: 'nudge'; rate: number }

/** Drift (seconds) we let go; above it we nudge the speed, and far off we jump. */
export const DRIFT_OK = 0.15
export const DRIFT_SEEK = 1.0
/** Players that can't change speed smoothly (YouTube's are coarse steps) only ever jump, a bit later. */
export const DRIFT_SEEK_COARSE = 1.5

/** What this player should do to match the party. `actual` and `expected` are seconds. */
export function correction(actual: number, expected: number, rate: number, playing: boolean, canNudge: boolean): Correction {
  const drift = actual - expected
  const distance = Math.abs(drift)
  if (!playing) return distance > 0.25 ? { kind: 'seek', to: expected } : { kind: 'none' }
  if (distance > (canNudge ? DRIFT_SEEK : DRIFT_SEEK_COARSE)) return { kind: 'seek', to: expected }
  if (canNudge && distance > DRIFT_OK) return { kind: 'nudge', rate: rate * (drift > 0 ? 0.95 : 1.05) }
  return { kind: 'none' }
}

const YOUTUBE_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com']
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/

/** A YouTube link's video id, or null. */
export function youTubeId(input: string): string | null {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const host = url.hostname.toLowerCase()
  let id: string | null = null
  if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0]
  else if (YOUTUBE_HOSTS.includes(host)) {
    const [first, second] = url.pathname.split('/').filter(Boolean)
    if (first === 'watch') id = url.searchParams.get('v')
    else if (first === 'embed' || first === 'shorts' || first === 'live' || first === 'v') id = second ?? null
  }
  return id && VIDEO_ID.test(id) ? id : null
}

/** What someone pasted: a YouTube link, or an https link to a media file. Null if neither. */
export function parseWatchInput(input: string): WatchSourceInput | null {
  const text = input.trim()
  if (!text || text.length > 2048) return null
  const id = youTubeId(text)
  if (id) return { kind: 'youtube', videoId: id }
  try {
    const url = new URL(text)
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return null
    return { kind: 'url', url: url.href }
  } catch {
    return null
  }
}

/** 0:07, 4:05, 1:02:03. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const s = Math.floor(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}
