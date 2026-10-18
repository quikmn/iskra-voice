// Why a voice session ended: shown to you when it wasn't your doing, and kept in the bug report diagnostics.
import type { DisconnectReason } from 'livekit-client'

/**
 * `user`: you left (or went somewhere else). `other_device`: the same account joined this voice channel on another
 * device (LiveKit allows one connection per account and room). `kicked`: a moderator took you out (`voice.disconnected`).
 * `removed`: the server removed you (permissions, a timeout, a full channel). `server`: the room or server went away
 * (a restart). `dropped`: the connection was lost. `failed`: joining didn't work. `switched`: you joined another channel or
 * call. `call_ended`: the call ended. `system`: the phone ended it (another call, the system's call screen).
 * `other_account`: another account signed in on this device joined voice (one device, one microphone).
 */
export type VoiceLeftReason = 'user' | 'other_device' | 'other_account' | 'kicked' | 'removed' | 'server' | 'dropped' | 'failed' | 'switched' | 'call_ended' | 'system'

export const VOICE_LEFT_REASONS: readonly VoiceLeftReason[] = ['user', 'other_device', 'other_account', 'kicked', 'removed', 'server', 'dropped', 'failed', 'switched', 'call_ended', 'system']

/** LiveKit's reason for a room disconnect, in our words. `R` is LiveKit's `DisconnectReason` enum (loaded lazily). */
export function leftReasonOf(reason: DisconnectReason | undefined, R: typeof DisconnectReason): VoiceLeftReason {
  switch (reason) {
    case R.CLIENT_INITIATED: return 'user'
    case R.DUPLICATE_IDENTITY: return 'other_device'
    case R.PARTICIPANT_REMOVED: return 'removed'
    case R.ROOM_DELETED:
    case R.ROOM_CLOSED:
    case R.SERVER_SHUTDOWN: return 'server'
    default: return 'dropped'
  }
}
