// The DM call state machine, kept pure so it can be tested without sockets or media.
// One call at a time: outgoing (ringing them) → active → ended, or incoming (ringing us) → active → ended.

export type EndReason = 'ended' | 'cancelled' | 'declined' | 'busy' | 'no_answer' | 'failed' | 'answered_elsewhere'

export interface CallInfo {
  id: string
  peer: string
  serverKey: string
  video: boolean
  direction: 'out' | 'in'
  phase: 'outgoing' | 'incoming' | 'active' | 'ended'
  startedAt: number
  answeredAt?: number
  endedAt?: number
  endReason?: EndReason
  /** A short message for 'failed' (e.g. why the call couldn't start). */
  error?: string
}

export type CallEvent =
  | { type: 'dial'; id: string; peer: string; serverKey: string; video: boolean; at: number }
  | { type: 'ring'; id: string; peer: string; serverKey: string; video: boolean; at: number }
  /** They answered (outgoing) or we did (incoming). */
  | { type: 'accepted'; id: string; at: number }
  | { type: 'ended'; id: string; reason: EndReason; at: number; error?: string }
  | { type: 'clear' }

/** Whether a new incoming call should be turned away as busy. */
export const isBusy = (call: CallInfo | null): boolean => !!call && call.phase !== 'ended'

export function reduce(call: CallInfo | null, event: CallEvent): CallInfo | null {
  switch (event.type) {
    case 'dial':
      if (isBusy(call)) return call
      return { id: event.id, peer: event.peer, serverKey: event.serverKey, video: event.video, direction: 'out', phase: 'outgoing', startedAt: event.at }
    case 'ring':
      if (isBusy(call)) return call
      return { id: event.id, peer: event.peer, serverKey: event.serverKey, video: event.video, direction: 'in', phase: 'incoming', startedAt: event.at }
    case 'accepted':
      if (!call || call.id !== event.id || (call.phase !== 'outgoing' && call.phase !== 'incoming')) return call
      return { ...call, phase: 'active', answeredAt: event.at }
    case 'ended':
      if (!call || call.id !== event.id || call.phase === 'ended') return call
      return { ...call, phase: 'ended', endedAt: event.at, endReason: event.reason, error: event.error }
    case 'clear':
      return call?.phase === 'ended' ? null : call
  }
}

/** What the caller records in the DM thread once a call is over. Only the caller writes it, so it appears once. */
export function callLog(call: CallInfo): { outcome: 'missed' | 'declined' | 'ended'; duration?: number } | null {
  if (call.direction !== 'out' || call.phase !== 'ended') return null
  if (call.endReason === 'failed') return null
  if (call.answeredAt !== undefined) return { outcome: 'ended', duration: Math.max(0, (call.endedAt ?? call.answeredAt) - call.answeredAt) }
  return { outcome: call.endReason === 'declined' ? 'declined' : 'missed' }
}

/** The fallback text of a call log entry (what apps without call support show). */
export function callLogText(video: boolean, outcome: 'missed' | 'declined' | 'ended', duration?: number): string {
  const kind = video ? 'video call' : 'voice call'
  if (outcome === 'missed') return `Missed ${kind}`
  if (outcome === 'declined') return `Declined ${kind}`
  return `${kind[0].toUpperCase()}${kind.slice(1)} · ${formatDuration(duration ?? 0)}`
}

export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** What the caller sees when a call ends before or after it was answered. */
export function endMessage(call: CallInfo): string {
  switch (call.endReason) {
    case 'no_answer': return 'No answer'
    case 'declined': return 'Declined'
    case 'busy': return 'Busy'
    case 'cancelled': return 'Cancelled'
    case 'failed': return call.error ?? "Couldn't connect the call"
    default: return 'Call ended'
  }
}

export interface InviteContent {
  kind: 'invite'
  id: string
  key: string
  video: boolean
}

export interface LogContent {
  kind: 'log'
  id: string
  video: boolean
  outcome: 'missed' | 'declined' | 'ended'
  duration?: number
}

const B64U = /^[A-Za-z0-9_-]+$/
const RING_MAX_AGE_MS = 2 * 60_000

/**
 * Checks a decrypted call invite against what the server says about the call (it relayed it):
 * the same call id and kind, a 32-byte key, sent recently (so an old invite can't be replayed).
 */
export function checkInvite(call: unknown, callId: string, video: boolean, sentAt: number, now: number): InviteContent | null {
  if (!call || typeof call !== 'object') return null
  const c = call as Partial<InviteContent>
  if (c.kind !== 'invite' || c.id !== callId || typeof c.key !== 'string' || c.key.length !== 43 || !B64U.test(c.key)) return null
  if (typeof c.video !== 'boolean' || c.video !== video) return null
  if (Math.abs(now - sentAt) > RING_MAX_AGE_MS) return null
  return { kind: 'invite', id: c.id, key: c.key, video: c.video }
}

/** A call log entry from a DM, or null if it isn't a well-formed one. */
export function asLog(call: unknown): LogContent | null {
  if (!call || typeof call !== 'object') return null
  const c = call as Partial<LogContent>
  if (c.kind !== 'log' || typeof c.id !== 'string' || typeof c.video !== 'boolean') return null
  if (c.outcome !== 'missed' && c.outcome !== 'declined' && c.outcome !== 'ended') return null
  const duration = typeof c.duration === 'number' && Number.isFinite(c.duration) && c.duration >= 0 ? c.duration : undefined
  return { kind: 'log', id: c.id, video: c.video, outcome: c.outcome, duration }
}
