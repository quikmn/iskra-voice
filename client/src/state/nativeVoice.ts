// Phone app (mobile/): voice keeps going with the screen locked (iOS audio session and CallKit, Android's foreground
// service with an "In voice" notification). Nothing happens in a browser or the desktop app.
import { create } from 'zustand'
import { native } from '../platform/native'
import { parseRoutes, type NativeRoute } from './deviceChoices'
import { nameOf } from './dms'
import { nativeVoiceInfo } from './nativeVoiceInfo'
import { useApp } from './store'
import { leaveVoice, toggleMute, useVoice } from './voice'

/**
 * Android: a call plays on the speaker (`on`) or the earpiece. The button shows in voice while no headset is in.
 * `routes`: everything the call can play on right now (the list behind the button's arrow), `route` the one it plays
 * on. Both stay empty in an app that can't list them.
 */
export const useSpeaker = create<{ shown: boolean; on: boolean; routes: NativeRoute[]; route: number | null }>(() => ({ shown: false, on: true, routes: [], route: null }))

/** Picked from the list in this call. Null: the button's speaker or earpiece, and a headset when one is in. */
let picked: number | null = null

function gotRoutes(raw: unknown) {
  if (!useVoice.getState().session) return
  const { routes, current } = parseRoutes(raw)
  const kind = routes.find((r) => r.id === current)?.kind
  // The button follows a speaker or earpiece picked from the list.
  useSpeaker.setState((s) => ({ routes, route: current, on: kind === 'speaker' ? true : kind === 'earpiece' ? false : s.on }))
}

export function refreshRoutes() {
  const list = native?.voice.routes
  if (list && useVoice.getState().session) void list().then(gotRoutes).catch(() => undefined)
}

/** Plays the call on one of `routes`. */
export function pickRoute(id: number) {
  const set = native?.voice.route
  if (!set) return
  picked = id
  useSpeaker.setState({ route: id })
  void set(id).then(gotRoutes).catch(() => undefined)
}

function routeTo(on: boolean) {
  const speaker = native?.voice.speaker
  if (!speaker) return
  void speaker(on)
    .then(({ headset }) => {
      if (useVoice.getState().session) useSpeaker.setState({ shown: !headset })
      refreshRoutes()
    })
    .catch(() => undefined)
}

export function toggleSpeaker() {
  const on = !useSpeaker.getState().on
  useSpeaker.setState({ on })
  picked = null
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
      picked = null
      useSpeaker.setState({ shown: false, routes: [], route: null })
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
      picked = null
      useSpeaker.setState({ on: true })
      void bridge.voice.start({ ...info, video }).catch(() => undefined)
    } else if (info.title !== lastTitle) {
      lastTitle = info.title
      void bridge.voice.update({ title: info.title }).catch(() => undefined)
    }
    // Once connected (and again after a reconnect), the call's audio is running: the choice is applied to it.
    if (session.state === 'connected' && routed !== session) {
      routed = session
      if (picked !== null) pickRoute(picked)
      else routeTo(useSpeaker.getState().on)
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
    // Android: the microphone just came on (allowed a moment ago, on a first call). The service becomes a microphone
    // one, and the question about notifications, held back so it couldn't hide the microphone's, comes now.
    if (bridge.platform === 'android' && active && s.micEngine && !prev.micEngine) void bridge.voice.update({ title: lastTitle }).catch(() => undefined)
  })
  const stopEnd = bridge.voice.onEnd(() => {
    if (useVoice.getState().session) void leaveVoice('system')
  })
  const stopMute = bridge.voice.onMute((muted) => {
    if (useVoice.getState().session && useVoice.getState().muted !== muted) void toggleMute()
  })

  const stopRoute = bridge.voice.onRoute?.((headset) => {
    if (useVoice.getState().session) useSpeaker.setState({ shown: !headset })
    refreshRoutes()
  })

  return () => {
    stopVoice()
    stopEnd()
    stopMute()
    stopRoute?.()
    picked = null
    useSpeaker.setState({ shown: false, routes: [], route: null })
    if (awake) void bridge.voice.keepAwake(false).catch(() => undefined)
    if (active) void bridge.voice.stop().catch(() => undefined)
  }
}
