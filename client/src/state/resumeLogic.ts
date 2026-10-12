// After a reconnect: whether to get back into voice, pure so it can be tested (state/resume.ts does it).
import type { VoiceResume } from './voice'

/** A drop older than this isn't resumed: you've moved on. */
export const RESUME_MAX_AGE_MS = 10 * 60_000
/** Failed rejoins in a row before giving up. */
export const RESUME_MAX_TRIES = 3

export type VoicePlan =
  | { kind: 'none' }
  /** Still in voice: just say mute/deafen again. */
  | { kind: 'resync' }
  /** Voice isn't available on the server yet: try when it is. */
  | { kind: 'wait'; where: VoiceResume }
  /** The channel is gone, or isn't a voice or stage channel any more. */
  | { kind: 'gone' }
  | { kind: 'rejoin'; where: VoiceResume }

export interface WelcomeFacts {
  serverKey: string
  /** The room that dropped, if it did. */
  pending: VoiceResume | null
  /** Where you are in voice right now (the room may be reconnecting). */
  live: VoiceResume | null
  liveConnected: boolean
  /** The server said it was restarting before this welcome: its LiveKit restarted too. */
  restarted: boolean
  channels: { id: number; kind: string }[]
  voiceAvailable: boolean
  now: number
}

export function planVoice(f: WelcomeFacts): VoicePlan {
  let where: VoiceResume | null = null
  if (f.pending?.serverKey === f.serverKey && f.now - f.pending.at < RESUME_MAX_AGE_MS) where = f.pending
  else if (f.live?.serverKey === f.serverKey) {
    if (f.liveConnected) return { kind: 'resync' }
    // After a restart the room can't come back by itself; after a network drop LiveKit is still trying (and keeps
    // camera and screen share if it manages), and a drop after that comes back here as `pending`.
    if (!f.restarted) return { kind: 'none' }
    where = f.live
  }
  if (!where) return { kind: 'none' }
  if (!f.channels.some((c) => c.id === where.channelId && (c.kind === 'voice' || c.kind === 'stage'))) return { kind: 'gone' }
  if (!f.voiceAvailable) return { kind: 'wait', where }
  return { kind: 'rejoin', where }
}
