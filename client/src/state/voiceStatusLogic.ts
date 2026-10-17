// Pure rules for voice channel status (unit-tested; no React or sockets): the text limits the server checks too, and
// who may set or clear a status (the server decides; this only picks what the app offers).
import type { BaseRoleInfo, Channel, Member, ServerRole } from '../core/protocol'
import { channelAccess, has } from './permissions'

export const VOICE_STATUS_MAX = 60
const MAX_UNITS = 240

/** User-perceived characters: an emoji (even a family or a flag) counts once, like on the server. */
export function statusLength(text: string): number {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter
  if (!Segmenter) return [...text].length
  let n = 0
  for (const _ of new Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) n++
  return n
}

// Control and invisible formatting characters (the emoji joiner U+200D is fine).
const INVISIBLE = /[\p{Cc}\p{Zl}\p{Zp}]|(?!‍)\p{Cf}/u

export type StatusCheck = { ok: true; text: string | null } | { ok: false; reason: 'tooLong' | 'invalid' }

/** What the server will take: null clears; too long or with line breaks and invisible characters is refused. */
export function checkStatusText(raw: string): StatusCheck {
  const text = raw.trim().normalize('NFC')
  if (text.length === 0) return { ok: true, text: null }
  if (INVISIBLE.test(text)) return { ok: false, reason: 'invalid' }
  if (text.length > MAX_UNITS || statusLength(text) > VOICE_STATUS_MAX) return { ok: false, reason: 'tooLong' }
  return { ok: true, text }
}

/** Setting it: you're in the call and have `setVoiceStatus` there (with speaking rights by default). */
export const maySetStatus = (me: Member | null | undefined, channel: Channel, roles: ServerRole[], inCall: boolean) =>
  inCall && channel.kind === 'voice' && channelAccess(me, channel, roles).has('setVoiceStatus')

/** Clearing it from outside the call: voice moderators. */
export const mayClearAsModerator = (me: Member | null | undefined, roles: ServerRole[], baseRoles?: BaseRoleInfo[]) =>
  has(me, roles, 'manageChannels', baseRoles) || has(me, roles, 'muteMembers', baseRoles) || has(me, roles, 'moveMembers', baseRoles)
