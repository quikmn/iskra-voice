// Join sounds: the rules that need no connection (state/joinSounds.ts does the rest).
import type { Sound } from '../core/protocol'

/** The longest sound that can be a join sound, when the server doesn't say (it does, in joinsound.get). */
export const JOIN_SOUND_MAX_MS = 5000
/** Measured lengths can be a little over the nominal one; the server allows the same. */
const SLACK_MS = 150

export const fitsJoinSound = (sound: Pick<Sound, 'durationMs'>, maxMs = JOIN_SOUND_MAX_MS): boolean => sound.durationMs <= maxMs + SLACK_MS

export interface JoinSoundListener {
  /** "Play other people's join sounds" (My settings → Voice & audio). */
  hear: boolean
  /** The soundboard's own switch and volume: a join sound is a soundboard sound. */
  soundboardMuted: boolean
  soundboardVolume: number
  deafened: boolean
  /** Your volume for the person who joined (1 unless changed; 0 is muted). */
  personal: number
  blocked: boolean
}

/** How loud a join sound plays for you, 0–1; 0 means it doesn't play. */
export function joinSoundVolume(l: JoinSoundListener): number {
  if (!l.hear || l.soundboardMuted || l.deafened || l.blocked) return 0
  const v = l.soundboardVolume * Math.min(1, Math.max(0, Number.isFinite(l.personal) ? l.personal : 1))
  return Math.min(1, Math.max(0, v))
}

/** How long after a join sound the app's own join tone for the same person is left out. */
export const JOIN_TONE_QUIET_MS = 4000

/** Whether the join tone should play: not when everyone who joined just had their join sound played. */
export function joinToneNeeded(joined: string[], soundAt: (accountKey: string) => number | undefined, now: number): boolean {
  return joined.some((key) => {
    const at = soundAt(key)
    return at === undefined || now - at > JOIN_TONE_QUIET_MS
  })
}
