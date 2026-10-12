// What nativeVoice.ts tells the phone, kept free of LiveKit and the stores so it can be tested.
import { t } from '../i18n'
import type { VoiceSession } from './voice'

/** What the phone shows while you're in voice: the notification / call screen title, and whether it's a call. */
export function nativeVoiceInfo(session: VoiceSession, names: { channel?: string; peer?: string }): { title: string; call: boolean } {
  if (session.call) return { title: t('calls.native.callWith', { name: names.peer ?? '' }), call: true }
  if (session.group) return { title: t('calls.native.groupCall'), call: true }
  return { title: t('calls.native.inVoice', { channel: names.channel ?? '' }), call: false }
}
