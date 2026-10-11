// Phone app (mobile/): voice keeps going with the screen locked (iOS audio session and CallKit, Android's foreground
// service with an "In voice" notification), and the phone's own call screen answers or declines Iskra calls.
// Nothing happens in a browser or the desktop app.
import { native, type NativeCallAction } from '../platform/native'
import { acceptCall, declineCall, useCalls } from './calls'
import { nameOf } from './dms'
import { declineGroupCall, joinOngoingCall, useGroupCalls } from './groupCalls'
import { groupKey } from './groups'
import { callMove, nativeVoiceInfo } from './nativeCallLogic'
import { useApp } from './store'
import { leaveVoice, toggleMute, useVoice } from './voice'

/** How long an answer from the phone's call screen waits for the call to arrive (ringing lasts 45 s). */
const PENDING_MS = 45_000

export function startNativeCalls(): () => void {
  if (!native) return () => {}
  const bridge = native

  // ── In voice: keep it going in the background ──
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

  // ── Answer / decline from the phone's call screen ──
  let pending: (NativeCallAction & { until: number }) | null = null
  const apply = () => {
    if (!pending) return
    if (Date.now() > pending.until) {
      pending = null
      return
    }
    const groups = useGroupCalls.getState()
    const key = pending.group ? groupKey(pending.server, pending.group) : null
    const move = callMove(pending, key, useCalls.getState().call, groups.ringing, groups.calls)
    if (!move) return
    pending = null
    if (move === 'accept') void acceptCall()
    else if (move === 'decline') declineCall()
    else if (move === 'join-group') void joinOngoingCall(key!)
    else declineGroupCall()
  }
  const stopAction = bridge.push.onCallAction((action) => {
    pending = { ...action, until: Date.now() + PENDING_MS }
    apply()
  })
  const stopCalls = useCalls.subscribe(apply)
  const stopGroups = useGroupCalls.subscribe(apply)

  return () => {
    stopVoice()
    stopEnd()
    stopMute()
    stopAction()
    stopCalls()
    stopGroups()
    if (active) void bridge.voice.stop().catch(() => undefined)
  }
}
