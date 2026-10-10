// Desktop notifications, the unread count in the window title, and small sounds.
// Notifications fire for mentions and DMs when you aren't already looking at them.
import { create } from 'zustand'
import { canPingGroups, mentions, plainText } from '../ui/markdown'
import { activeChannelId, onServerEvent, useApp } from './store'
import { conversationLabel, isViewingThread } from './threads'
import { jumpToMessage } from './jump'
import { b64u } from '../core/crypto'
import type { Events, WireDm } from '../core/protocol'
import { useAudio } from './audio'

interface NotifySettings {
  desktop: boolean
  sounds: boolean
  /** Push notifications on this device while Iskra is closed (state/push.ts). */
  push: boolean
}

const KEY = 'iskra.notify'

function load(): NotifySettings {
  try {
    return { desktop: true, sounds: true, push: false, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }
  } catch {
    return { desktop: true, sounds: true, push: false }
  }
}

export const useNotify = create<NotifySettings>(load)

export function updateNotify(patch: Partial<NotifySettings>): void {
  useNotify.setState(patch)
  try {
    localStorage.setItem(KEY, JSON.stringify(useNotify.getState()))
  } catch {
    /* private mode */
  }
}

export const notificationsSupported = () => typeof Notification !== 'undefined'

export async function enableDesktopNotifications(): Promise<boolean> {
  if (!notificationsSupported()) return false
  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
  updateNotify({ desktop: permission === 'granted' })
  return permission === 'granted'
}

// ── Sounds: tiny synthesized tones, no audio files to load ──────────────────

let audio: AudioContext | null = null
let audioSink = ''

export type Tone = 'message' | 'join' | 'leave' | 'mute' | 'unmute' | 'deafen' | 'undeafen'

const TONES: Record<Tone, number[]> = {
  message: [880, 1320],
  join: [523, 784],
  leave: [784, 523],
  mute: [660, 440],
  unmute: [440, 660],
  deafen: [587, 392, 294],
  undeafen: [294, 392, 587],
}

/** Message sounds follow Notifications; voice sounds (join, leave, mute, deafen) follow Voice & audio. */
export function playTone(kind: Tone): void {
  if (kind === 'message' ? !useNotify.getState().sounds : !useAudio.getState().voiceSounds) return
  try {
    audio ??= new AudioContext()
    // Play on the chosen output device where the browser allows it.
    const sink = useAudio.getState().outputDevice
    const ctx = audio as AudioContext & { setSinkId?: (id: string) => Promise<void> }
    if (sink !== audioSink && ctx.setSinkId) {
      audioSink = sink
      void ctx.setSinkId(sink).catch(() => undefined)
    }
    const notes = TONES[kind]
    notes.forEach((frequency, i) => {
      const osc = audio!.createOscillator()
      const gain = audio!.createGain()
      const start = audio!.currentTime + i * 0.09
      osc.frequency.value = frequency
      osc.type = 'sine'
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(0.12, start + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16)
      osc.connect(gain).connect(audio!.destination)
      osc.start(start)
      osc.stop(start + 0.18)
    })
  } catch {
    /* audio not allowed yet (no user gesture) */
  }
}

/** Servers that push to this device: while the page is in the background, their pushes do the notifying. */
export const pushActive = new Set<string>()

function show(serverKey: string, title: string, body: string, onClick: () => void): void {
  if (pushActive.has(serverKey) && !document.hasFocus()) return
  playTone('message')
  if (!useNotify.getState().desktop || !notificationsSupported() || Notification.permission !== 'granted') return
  const notification = new Notification(title, { body: body.slice(0, 200), silent: true })
  notification.onclick = () => {
    window.focus()
    onClick()
    notification.close()
  }
}

const me = () => {
  const identity = useApp.getState().identity
  return identity ? b64u(identity.account.publicKey) : ''
}

const lastVoice = new Map<string, Set<string>>()

onServerEvent((serverKey, type, body) => {
  const state = useApp.getState()
  const server = state.servers[serverKey]
  if (!server) return

  if (type === 'chat.message') {
    const { message } = body as Events['chat.message']
    const myKey = me()
    const groupPings = canPingGroups(server.members[message.author]?.role, !!message.webhook)
    if (message.author === myKey || !mentions(message.text, myKey, groupPings)) return
    const viewing = document.hasFocus() && state.activeServer === serverKey && activeChannelId(state) === message.channelId
    if (viewing || isViewingThread(serverKey, message.channelId)) return
    const author = message.webhook?.name ?? server.members[message.author]?.name ?? 'Someone'
    show(serverKey, `${author} in ${conversationLabel(server, message.channelId)}`, plainText(message.text, { nameOf: (k) => server.members[k]?.name ?? null }), () => {
      void jumpToMessage(serverKey, message.channelId, message.id)
    })
  }

  if (type === 'voice.state') {
    // Little chimes when people join or leave the voice channel you're in.
    const { channelId, participants } = body as Events['voice.state']
    const tag = `${serverKey}:${channelId}`
    const now = new Set(participants.map((p) => p.accountKey))
    const before = lastVoice.get(tag)
    lastVoice.set(tag, now)
    void import('./voice').then(({ useVoice }) => {
      const session = useVoice.getState().session
      if (!before || session?.serverKey !== serverKey || session.channelId !== channelId || session.state !== 'connected') return
      const myKey = me()
      const joined = [...now].some((k) => !before.has(k) && k !== myKey)
      const left = [...before].some((k) => !now.has(k) && k !== myKey)
      if (joined) playTone('join')
      else if (left) playTone('leave')
    })
  }

  if (type === 'dm.message') {
    const { message } = body as { message: WireDm }
    const myKey = me()
    if (message.from === myKey) return
    void import('./dms').then(({ useDms, nameOf, openConversation }) => {
      const open = useDms.getState().open
      const viewing = document.hasFocus() && useApp.getState().activeServer === null && open.kind === 'dm' && open.peer === message.from
      if (viewing) return
      // The text is end-to-end encrypted; read it from the decrypted conversation.
      const latest = useDms.getState().conversations[message.from]?.messages.at(-1)
      show(serverKey, nameOf(message.from), latest?.error ? 'New message' : (latest?.text ?? 'New message'), () => openConversation(message.from))
    })
  }
})

/** Keeps "(3) Iskra" in the title for unread mentions and DMs. */
export function startTitleBadge(): () => void {
  const update = async () => {
    const { useDms } = await import('./dms')
    const servers = Object.values(useApp.getState().servers)
    const mentionCount = servers.reduce((n, s) => n + Object.values(s.mentions).reduce((a, b) => a + b, 0), 0)
    const dmCount = Object.values(useDms.getState().conversations).reduce((n, c) => n + c.unread, 0)
    const total = mentionCount + dmCount
    document.title = total > 0 ? `(${total}) Iskra` : 'Iskra'
  }
  const unsubscribe = useApp.subscribe(() => void update())
  let unsubscribeDms = () => {}
  void import('./dms').then(({ useDms }) => (unsubscribeDms = useDms.subscribe(() => void update())))
  return () => {
    unsubscribe()
    unsubscribeDms()
  }
}
