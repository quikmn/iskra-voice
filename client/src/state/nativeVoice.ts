// Phone app (mobile/): voice keeps going with the screen locked (iOS audio session and CallKit, Android's foreground
// service with an "In voice" notification). Nothing happens in a browser or the desktop app.
import { native } from '../platform/native'
import { nameOf } from './dms'
import { nativeVoiceInfo } from './nativeVoiceInfo'
import { useApp } from './store'
import { leaveVoice, toggleMute, useVoice } from './voice'

export function startNativeVoice(): () => void {
  if (!native) return () => {}
  const bridge = native

  let active: string | null = null
  let lastTitle = ''
  const sync = () => {
    const session = useVoice.getState().session
    const id = session ? `${session.serverKey}:${session.channelId}:${session.call?.id ?? session.group?.callId ?? ''}` : null
    if (!session || !id) {
      if (active) void bridge.voice.stop().catch(() => undefined)
      active = null
      return
    }
    const server = useApp.getState().servers[session.serverKey]
    const channel = server?.channels.find((c) => c.id === session.channelId)?.name
    const info = nativeVoiceInfo(session, { channel, peer: session.call ? nameOf(session.call.peer) : undefined })
    const video = useVoice.getState().camera
    if (active !== id) {
      active = id
      lastTitle = info.title
      void bridge.voice.start({ ...info, video }).catch(() => undefined)
    } else if (info.title !== lastTitle) {
      lastTitle = info.title
      void bridge.voice.update({ title: info.title }).catch(() => undefined)
    }
  }
  sync()
  const stopVoice = useVoice.subscribe((s, prev) => {
    if (s.session !== prev.session) sync()
  })
  const stopEnd = bridge.voice.onEnd(() => {
    if (useVoice.getState().session) void leaveVoice()
  })
  const stopMute = bridge.voice.onMute((muted) => {
    if (useVoice.getState().session && useVoice.getState().muted !== muted) void toggleMute()
  })

  return () => {
    stopVoice()
    stopEnd()
    stopMute()
    if (active) void bridge.voice.stop().catch(() => undefined)
  }
}
