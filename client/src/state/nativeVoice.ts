// Phone app (mobile/): voice keeps going with the screen locked (iOS audio session and CallKit, Android's foreground
// service with an "In voice" notification). Nothing happens in a browser or the desktop app.
import { create } from 'zustand'
import { native } from '../platform/native'
import { nameOf } from './dms'
import { nativeVoiceInfo } from './nativeVoiceInfo'
import { useApp } from './store'
import { leaveVoice, toggleMute, useVoice } from './voice'

/** Android: a call plays on the speaker (`on`) or the earpiece. The button shows in voice while no headset is in. */
export const useSpeaker = create<{ shown: boolean; on: boolean }>(() => ({ shown: false, on: true }))

function routeTo(on: boolean) {
  const speaker = native?.voice.speaker
  if (!speaker) return
  void speaker(on)
    .then(({ headset }) => { if (useVoice.getState().session) useSpeaker.setState({ shown: !headset }) })
    .catch(() => undefined)
}

export function toggleSpeaker() {
  const on = !useSpeaker.getState().on
  useSpeaker.setState({ on })
  routeTo(on)
}

export function startNativeVoice(): () => void {
  if (!native) return () => {}
  const bridge = native

  let active: string | null = null
  let lastTitle = ''
  let routed: object | null = null
  const sync = () => {
    const session = useVoice.getState().session
    const id = session ? `${session.serverKey}:${session.channelId}:${session.call?.id ?? session.group?.callId ?? ''}` : null
    if (!session || !id) {
      if (active) void bridge.voice.stop().catch(() => undefined)
      active = null
      useSpeaker.setState({ shown: false })
      return
    }
    const server = useApp.getState().servers[session.serverKey]
    const channel = server?.channels.find((c) => c.id === session.channelId)?.name
    const info = nativeVoiceInfo(session, { channel, peer: session.call ? nameOf(session.call.peer) : undefined })
    const video = useVoice.getState().camera
    if (active !== id) {
      active = id
      lastTitle = info.title
      // Each call starts on the speaker, as on the iPhone.
      useSpeaker.setState({ on: true })
      void bridge.voice.start({ ...info, video }).catch(() => undefined)
    } else if (info.title !== lastTitle) {
      lastTitle = info.title
      void bridge.voice.update({ title: info.title }).catch(() => undefined)
    }
    // Once connected (and again after a reconnect), the call's audio is running: the choice is applied to it.
    if (session.state === 'connected' && routed !== session) {
      routed = session
      routeTo(useSpeaker.getState().on)
    }
  }
  sync()
  // A locked phone stops the camera: the screen stays on while yours is on in a call.
  let awake = false
  const stayAwake = () => {
    const want = !!useVoice.getState().session && useVoice.getState().camera
    if (want === awake) return
    awake = want
    void bridge.voice.keepAwake(want).catch(() => undefined)
  }
  const stopVoice = useVoice.subscribe((s, prev) => {
    if (s.session !== prev.session) sync()
    if (s.session !== prev.session || s.camera !== prev.camera) stayAwake()
  })
  const stopEnd = bridge.voice.onEnd(() => {
    if (useVoice.getState().session) void leaveVoice('system')
  })
  const stopMute = bridge.voice.onMute((muted) => {
    if (useVoice.getState().session && useVoice.getState().muted !== muted) void toggleMute()
  })

  const stopRoute = bridge.voice.onRoute?.((headset) => {
    if (useVoice.getState().session) useSpeaker.setState({ shown: !headset })
  })

  return () => {
    stopVoice()
    stopEnd()
    stopMute()
    stopRoute?.()
    useSpeaker.setState({ shown: false })
    if (awake) void bridge.voice.keepAwake(false).catch(() => undefined)
    if (active) void bridge.voice.stop().catch(() => undefined)
  }
}
