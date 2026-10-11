// Clips: the pure parts (settings, the data-channel messages of DM and group calls, who has clips on, file names).
import type { VoiceParticipant } from '../core/protocol'
import { clampSeconds, DEFAULT_CLIP_SECONDS } from './clips/ring'

export interface ClipSettings {
  /** Off by default: nothing is buffered, and nobody sees a "clips on" mark, until you turn it on. */
  enabled: boolean
  /** How much a clip keeps (15–120 s). */
  seconds: number
}

export const DEFAULT_CLIP_SETTINGS: ClipSettings = { enabled: false, seconds: DEFAULT_CLIP_SECONDS }

export function parseClipSettings(raw: string | null): ClipSettings {
  try {
    const data = JSON.parse(raw ?? '{}') as Partial<ClipSettings> | null
    return {
      enabled: data?.enabled === true,
      seconds: typeof data?.seconds === 'number' ? clampSeconds(data.seconds) : DEFAULT_CLIP_SECONDS,
    }
  } catch {
    return { ...DEFAULT_CLIP_SETTINGS }
  }
}

/** The LiveKit data topic DM and group calls use to say who has clips on and when one was saved. */
export const CLIP_TOPIC = 'iskra.clips'
const MAX_DATA_BYTES = 256

export type ClipData = { clips: boolean } | { saved: true }

export const encodeClipData = (data: ClipData): Uint8Array<ArrayBuffer> => new TextEncoder().encode(JSON.stringify({ v: 1, ...data }))

/** A message from someone in the call; anything malformed is ignored (null). */
export function parseClipData(payload: Uint8Array): ClipData | null {
  if (payload.length > MAX_DATA_BYTES) return null
  try {
    const data = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>
    if (!data || data.v !== 1) return null
    if (typeof data.clips === 'boolean') return { clips: data.clips }
    if (data.saved === true) return { saved: true }
    return null
  } catch {
    return null
  }
}

/** Where a call happens: a voice or stage channel (the server carries the flag and the notice), or a DM or group call. */
export type CallPlace =
  | { kind: 'channel'; serverKey: string; channelId: number }
  | { kind: 'dm'; serverKey: string; peer: string }
  | { kind: 'group'; serverKey: string; groupKey: string }

export function callPlace(session: { serverKey: string; channelId: number; call?: { peer: string }; group?: { key: string } }): CallPlace {
  if (session.call) return { kind: 'dm', serverKey: session.serverKey, peer: session.call.peer }
  if (session.group) return { kind: 'group', serverKey: session.serverKey, groupKey: session.group.key }
  return { kind: 'channel', serverKey: session.serverKey, channelId: session.channelId }
}

/**
 * Everyone in the call who has clips on: in a channel from the server's voice state, in DM and group calls from what
 * people said on the data channel (and yourself, from your setting).
 */
export function clipsOnIn(place: CallPlace, participants: VoiceParticipant[], fromRoom: Record<string, true>, me: string | null, mine: boolean): string[] {
  const keys = place.kind === 'channel' ? participants.filter((p) => p.clips).map((p) => p.accountKey) : Object.keys(fromRoom)
  if (me && mine && !keys.includes(me)) keys.push(me)
  if (me && !mine) return keys.filter((k) => k !== me)
  return keys
}

/** In a channel: whether the server still has to hear our flag (we're listed there, with the other value). */
export function flagToSend(participants: VoiceParticipant[], me: string | null, wanted: boolean): boolean {
  const mine = me ? participants.find((p) => p.accountKey === me) : undefined
  return !!mine && !!mine.clips !== wanted
}

/** "iskra-clip-2026-10-11-213005.webm" (local time). */
export function clipFileName(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `iskra-clip-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}.webm`
}

/** "0:07", "1:30". */
export function clipTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
