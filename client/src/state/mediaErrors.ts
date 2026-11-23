// Why the microphone or camera didn't start in a call, and the words for it. Only a refusal is called a permission
// problem; a missing or busy device, or a call whose media can't reach the voice server, says so.
import { t } from '../i18n'

export type MediaErrorKind = 'blocked' | 'missing' | 'busy' | 'connection' | 'failed'

const NAMES: Record<string, MediaErrorKind> = {
  NotAllowedError: 'blocked', SecurityError: 'blocked', PermissionDeniedError: 'blocked',
  NotFoundError: 'missing', DevicesNotFoundError: 'missing', OverconstrainedError: 'missing',
  NotReadableError: 'busy', TrackStartError: 'busy', AbortError: 'busy',
  // LiveKit: the track was captured, publishing it didn't get through.
  PublishTrackError: 'connection', NegotiationError: 'connection', ConnectionError: 'connection',
  SignalRequestError: 'connection', UnexpectedConnectionState: 'connection', SignalReconnectError: 'connection',
}

export function mediaErrorKind(error: unknown): MediaErrorKind {
  const e = error as { name?: unknown; message?: unknown } | null
  const name = typeof e?.name === 'string' ? e.name : ''
  if (NAMES[name]) return NAMES[name]
  const message = typeof e?.message === 'string' ? e.message : ''
  return /timed? ?out|not connected|disconnected|engine|negotiat|peer ?connection/i.test(message) ? 'connection' : 'failed'
}

/** A short, safe label for an error we have no words for (its name, else the start of its message). */
export function mediaErrorReason(error: unknown): string {
  const e = error as { name?: unknown; message?: unknown } | null
  const name = typeof e?.name === 'string' && e.name !== 'Error' ? e.name : ''
  const message = typeof e?.message === 'string' ? e.message : ''
  return (name || message || 'unknown').replace(/\s+/g, ' ').slice(0, 60)
}

/** `inApp`: the phone app, where the permission is the app's (in the phone's settings), not a browser's. */
export function mediaErrorText(device: 'mic' | 'camera', error: unknown, inApp: boolean): string {
  switch (mediaErrorKind(error)) {
    case 'blocked': return t(inApp ? `voice.errors.${device}App` : `voice.errors.${device}`)
    case 'missing': return t(`voice.errors.${device}Missing`)
    case 'busy': return t(`voice.errors.${device}Busy`)
    case 'connection': return t(`voice.errors.${device}Connection`)
    default: return t(`voice.errors.${device}Failed`, { reason: mediaErrorReason(error) })
  }
}
