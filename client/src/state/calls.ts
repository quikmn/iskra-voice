// Voice and video calls in DMs. The server that carries the DM rings the other person and hands out LiveKit
// tokens for a private room; the media key is random per call and travels inside an encrypted DM envelope,
// so the server (and LiveKit) only ever see encrypted media.
import { create } from 'zustand'
import { b64u, fromB64u, randomBytes } from '../core/crypto'
import { decryptDm } from '../core/dm'
import { RequestError, type CallRing, type Events } from '../core/protocol'
import { desktop } from '../platform/desktop'
import { callLog, callLogText, checkInvite, isBusy, reduce, type CallEvent, type CallInfo, type EndReason } from './callMachine'
import { encryptFor, nameOf, openConversation, sendDm, sharedServers } from './dms'
import { useNotify } from './notify'
import { isDoNotDisturb } from './presence'
import { connectionFor, onServerEvent, onWelcomeHook, useApp } from './store'
import { joinCall, leaveVoice, useVoice } from './voice'
import { t } from '../i18n'
import { errorMessage } from '../i18n/errors'

interface CallsState {
  call: CallInfo | null
  /** Who LiveKit says is in the call's room (from the server's call.state events). */
  inRoom: string[]
}

export const useCalls = create<CallsState>(() => ({ call: null, inRoom: [] }))

/** Media keys by call id. Memory only, dropped when the call ends. */
const keys = new Map<string, Uint8Array>()
const OUTGOING_WATCHDOG_MS = 60_000
/** How long a ringing call waits for the server's reason after the room drops (see the voice subscription below). */
const ROOM_DROP_GRACE_MS = 2_000

const me = () => {
  const identity = useApp.getState().identity
  return identity ? b64u(identity.account.publicKey) : ''
}

function dispatch(event: CallEvent): void {
  const before = useCalls.getState().call
  const after = reduce(before, event)
  if (after === before) return
  useCalls.setState({ call: after, inRoom: after?.id === before?.id ? useCalls.getState().inRoom : [] })
  if (after?.phase === 'ended' && before?.phase !== 'ended') onEnded(after)
}

function onEnded(call: CallInfo): void {
  keys.delete(call.id)
  if (useVoice.getState().session?.call?.id === call.id) void leaveVoice('call_ended')
  const log = callLog(call)
  if (log) {
    void sendDm(call.peer, callLogText(call.video, log.outcome, log.duration), {
      call: { kind: 'log', id: call.id, video: call.video, ...log },
    })
  }
  // The caller sees why it ended for a moment ("No answer"); then the call UI goes away.
  const linger = call.direction === 'out' && call.answeredAt === undefined ? 4000 : 1500
  setTimeout(() => {
    if (useCalls.getState().call === call) dispatch({ type: 'clear' })
  }, linger)
}

/** Servers we could call someone through: both members, voice available; ones where they're online first. */
export function callServers(peer: string): string[] {
  if (peer === me()) return []
  const { servers } = useApp.getState()
  return sharedServers(peer)
    .filter((key) => servers[key].voiceAvailable)
    .sort((a, b) => Number(!!servers[b].members[peer]?.online) - Number(!!servers[a].members[peer]?.online))
}

export async function startCall(peer: string, video: boolean): Promise<void> {
  if (isBusy(useCalls.getState().call)) return
  const identity = useApp.getState().identity
  const serverKey = callServers(peer)[0]
  const id = b64u(randomBytes(16))
  dispatch({ type: 'dial', id, peer, serverKey: serverKey ?? '', video, at: Date.now() })
  if (!identity || !serverKey) {
    dispatch({ type: 'ended', id, reason: 'failed', at: Date.now(), error: t('calls.noServerWith', { name: nameOf(peer) }) })
    return
  }
  setTimeout(() => {
    const call = useCalls.getState().call
    if (call?.id === id && call.phase === 'outgoing') void hangUp()
  }, OUTGOING_WATCHDOG_MS)

  const key = randomBytes(32)
  try {
    const envelope = await encryptFor(serverKey, peer, {
      text: video ? t('calls.incomingVideo') : t('calls.incomingVoice'),
      call: { kind: 'invite', id, key: b64u(key), video },
    })
    const media = await connectionFor(serverKey)!.request('call.start', { accountKey: peer, callId: id, video, envelope })
    if (useCalls.getState().call?.id !== id || useCalls.getState().call?.phase === 'ended') {
      // Hung up while it was starting.
      connectionFor(serverKey)?.request('call.end', { callId: id }).catch(() => undefined)
      return
    }
    keys.set(id, key)
    const joined = await joinCall(serverKey, { id, peer }, media, key, video)
    if (!joined && useCalls.getState().call?.id === id) await hangUp(t('calls.couldNotConnect'))
  } catch (e) {
    const busy = e instanceof RequestError && e.code === 'busy'
    dispatch({ type: 'ended', id, reason: busy ? 'busy' : 'failed', at: Date.now(), error: errorMessage(e) })
  }
}

/** A call.ring from a server (or call.pending after connecting). */
async function onRing(serverKey: string, ring: CallRing): Promise<void> {
  const identity = useApp.getState().identity
  const { call } = ring
  if (!identity || call.to !== me() || call.from === me()) return
  const current = useCalls.getState().call
  if (current?.id === call.id) return // already ringing (pending + live event)
  const connection = connectionFor(serverKey)
  if (isBusy(current)) {
    connection?.request('call.decline', { callId: call.id, reason: 'busy' }).catch(() => undefined)
    return
  }

  let key: Uint8Array | null = null
  try {
    const { header, call: content } = decryptDm(identity, ring.envelope, call.from, call.to)
    const invite = checkInvite(content, call.id, call.video, header.sentAt, Date.now())
    if (invite) key = fromB64u(invite.key)
  } catch {
    /* not readable on this device: treated like a bad invite */
  }
  // Without a key there's no encrypted call, and never an unencrypted one. Stay quiet rather than decline:
  // another of your devices may have the key (this one may be newer than the caller's device list).
  if (!key) return
  keys.set(call.id, key)
  dispatch({ type: 'ring', id: call.id, peer: call.from, serverKey, video: call.video, at: Date.now() })
}

export async function acceptCall(): Promise<void> {
  const call = useCalls.getState().call
  const key = call && keys.get(call.id)
  if (!call || call.phase !== 'incoming' || !key) return
  try {
    const media = await connectionFor(call.serverKey)!.request('call.accept', { callId: call.id })
    dispatch({ type: 'accepted', id: call.id, at: Date.now() })
    openConversation(call.peer)
    const joined = await joinCall(call.serverKey, { id: call.id, peer: call.peer }, media, key, call.video)
    if (!joined && useCalls.getState().call?.id === call.id) await hangUp(t('calls.couldNotConnect'))
  } catch {
    dispatch({ type: 'ended', id: call.id, reason: 'failed', at: Date.now(), error: t('calls.noLongerAvailable') })
  }
}

export function declineCall(): void {
  const call = useCalls.getState().call
  if (!call || call.phase !== 'incoming') return
  connectionFor(call.serverKey)?.request('call.decline', { callId: call.id }).catch(() => undefined)
  dispatch({ type: 'ended', id: call.id, reason: 'declined', at: Date.now() })
}

/** Hangs up (or cancels a call that's still ringing). */
export async function hangUp(error?: string): Promise<void> {
  const call = useCalls.getState().call
  if (!call || call.phase === 'ended') return
  if (call.phase === 'incoming') return declineCall()
  const reason: EndReason = error ? 'failed' : call.phase === 'active' ? 'ended' : 'cancelled'
  dispatch({ type: 'ended', id: call.id, reason, at: Date.now(), error })
  await connectionFor(call.serverKey)?.request('call.end', { callId: call.id }).catch(() => undefined)
}

onServerEvent((serverKey, type, body) => {
  switch (type) {
    case 'call.ring':
      void onRing(serverKey, body as Events['call.ring'])
      return
    case 'call.accepted': {
      const { callId } = body as Events['call.accepted']
      const call = useCalls.getState().call
      if (call?.id !== callId) return
      if (call.direction === 'out') dispatch({ type: 'accepted', id: callId, at: Date.now() })
      else if (call.phase === 'incoming') dispatch({ type: 'ended', id: callId, reason: 'answered_elsewhere', at: Date.now() })
      return
    }
    case 'call.ended': {
      const { callId, reason } = body as Events['call.ended']
      dispatch({ type: 'ended', id: callId, reason, at: Date.now() })
      return
    }
    case 'call.state': {
      const { callId, participants } = body as Events['call.state']
      if (useCalls.getState().call?.id === callId) useCalls.setState({ inRoom: participants })
      return
    }
  }
})

// A device that connects while a call rings for it can still answer.
onWelcomeHook((serverKey) => {
  connectionFor(serverKey)?.request('call.pending', {})
    .then(({ calls }) => calls.forEach((ring) => void onRing(serverKey, ring)))
    .catch(() => undefined)
})

// Joining a voice channel (or the room dropping) ends the call.
useVoice.subscribe((state, prev) => {
  const call = useCalls.getState().call
  if (!call || call.phase === 'ended') return
  if (prev.session?.call?.id !== call.id || state.session?.call?.id === call.id) return
  if (call.phase === 'active') return void hangUp()
  // Still ringing: a decline (or "busy") also takes us out of the room, and that can arrive just before the
  // server's call.ended with the real reason. Give it a moment so the caller sees "Declined", not "Cancelled".
  setTimeout(() => {
    const now = useCalls.getState().call
    if (now?.id === call.id && now.phase !== 'ended') void hangUp()
  }, ROOM_DROP_GRACE_MS)
})

// ── Ringing: sound, desktop notification, and the desktop app's attention ───

let ringTimer: ReturnType<typeof setInterval> | null = null
let ringAudio: AudioContext | null = null
let notification: Notification | null = null

function tone(frequencies: number[], start: number, length: number, volume: number): void {
  const audio = ringAudio!
  for (const frequency of frequencies) {
    const osc = audio.createOscillator()
    const gain = audio.createGain()
    osc.frequency.value = frequency
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.02)
    gain.gain.setValueAtTime(volume, start + length - 0.05)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + length)
    osc.connect(gain).connect(audio.destination)
    osc.start(start)
    osc.stop(start + length + 0.05)
  }
}

/** Also used by group calls (groupCalls.ts). */
export function startRinging(kind: 'in' | 'out'): void {
  stopRinging()
  const play = () => {
    try {
      ringAudio ??= new AudioContext()
      void ringAudio.resume()
      const now = ringAudio.currentTime
      if (kind === 'in') {
        tone([660, 880], now, 0.35, 0.08)
        tone([660, 880], now + 0.5, 0.35, 0.08)
      } else {
        tone([440, 480], now, 1.2, 0.03) // a soft ringback while it rings on their side
      }
    } catch {
      /* audio not allowed yet (no user gesture) */
    }
  }
  play()
  ringTimer = setInterval(play, kind === 'in' ? 2500 : 4000)
}

export function stopRinging(): void {
  if (ringTimer) clearInterval(ringTimer)
  ringTimer = null
}

useCalls.subscribe((state, prev) => {
  const phase = state.call?.phase
  if (phase === prev.call?.phase && state.call?.id === prev.call?.id) return
  if (phase === 'incoming') {
    // Do not disturb: the call still shows, silently.
    const quiet = isDoNotDisturb()
    if (!quiet) startRinging('in')
    if (!quiet) void desktop?.callAlert?.(true)
    const call = state.call!
    if (!quiet && !document.hasFocus() && useNotify.getState().desktop && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      notification = new Notification(t('calls.isCalling', { name: nameOf(call.peer) }), {
        body: call.video ? t('calls.notifyVideo') : t('calls.notifyVoice'),
        tag: 'iskra-call',
        requireInteraction: true,
        silent: true,
      })
      notification.onclick = () => {
        window.focus()
        notification?.close()
      }
    }
  } else if (phase === 'outgoing') {
    startRinging('out')
  } else {
    stopRinging()
    notification?.close()
    notification = null
    if (prev.call?.phase === 'incoming') void desktop?.callAlert?.(false)
  }
})
