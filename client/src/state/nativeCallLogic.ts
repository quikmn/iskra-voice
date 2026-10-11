// The decisions behind nativeCalls.ts, kept free of LiveKit and the stores so they can be tested.
import { t } from '../i18n'
import type { NativeCallAction } from '../platform/native'
import type { VoiceSession } from './voice'

/** What the phone shows while you're in voice: the notification / call screen title, and whether it's a call. */
export function nativeVoiceInfo(session: VoiceSession, names: { channel?: string; peer?: string }): { title: string; call: boolean } {
  if (session.call) return { title: t('calls.native.callWith', { name: names.peer ?? '' }), call: true }
  if (session.group) return { title: t('calls.native.groupCall'), call: true }
  return { title: t('calls.native.inVoice', { channel: names.channel ?? '' }), call: false }
}

export type CallMove = 'accept' | 'decline' | 'join-group' | 'decline-group'

/**
 * Answer/decline pressed on the phone's call screen, matched to the call once it shows up here (the app may only just
 * be connecting). Null while there's nothing to match yet.
 */
export function callMove(
  action: NativeCallAction,
  /** The group's key in groups.ts (groupKey(action.server, action.group)), for group calls. */
  key: string | null,
  dm: { phase: string; peer: string; serverKey: string } | null,
  groupRinging: { key: string } | null,
  groupCalls: Record<string, unknown>,
): CallMove | null {
  if (action.peer) {
    if (dm?.phase !== 'incoming' || dm.peer !== action.peer) return null
    return action.action === 'answer' ? 'accept' : 'decline'
  }
  if (!action.group || !key) return null
  if (action.action === 'decline') return groupRinging?.key === key ? 'decline-group' : null
  return groupRinging?.key === key || key in groupCalls ? 'join-group' : null
}
