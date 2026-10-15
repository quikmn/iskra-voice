// Desktop notifications, the unread count in the window title, and small sounds.
// Notifications fire for mentions (every message at "All messages") and DMs when you aren't already looking at them.
import { create } from 'zustand'
import { t } from '../i18n'
import { plainText } from '../ui/markdown'
import { stripMarkdown } from '../ui/plainMarkdown'
import { senderRules } from './senderRules'
import { onServerEvent, railHooks, useApp } from './store'
import { conversationLabel, useThreads } from './threads'
import { jumpToMessage } from './jump'
import { b64u } from '../core/crypto'
import type { Events, Message, WireDm } from '../core/protocol'
import { isDoNotDisturb } from './presence'
import { notifyFor, useOrganize } from './organize'
import { badgeTotal } from './unread'
import { channelConv, dmConv, isOnScreen, useReads } from './readState'
import { shouldNotify } from './organizeLogic'
import { isBlocked, useBlocks } from './moderation'
import { useAudio } from './audio'
import { desktop } from '../platform/desktop'
import { overlayIcon } from '../platform/badge'

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

export type Tone = 'message' | 'join' | 'leave' | 'mute' | 'unmute' | 'deafen' | 'undeafen' | 'whisper'

const TONES: Record<Tone, number[]> = {
  message: [880, 1320],
  join: [523, 784],
  leave: [784, 523],
  mute: [660, 440],
  unmute: [440, 660],
  deafen: [587, 392, 294],
  undeafen: [294, 392, 587],
  whisper: [1175, 1568],
}

/** Message sounds follow Notifications; voice sounds (join, leave, mute, deafen) follow Voice & audio. */
export function playTone(kind: Tone, test = false): void {
  if (kind === 'message' ? !useNotify.getState().sounds : !useAudio.getState().voiceSounds) return
  if (isDoNotDisturb() && !test) return
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

/** A desktop notification (and tone) unless this server's pushes cover it while the page is in the background. */
export function showNotification(serverKey: string, title: string, body: string, onClick: () => void): void {
  show(serverKey, title, body, onClick)
}

export function show(serverKey: string, title: string, body: string, onClick: () => void): void {
  if (pushActive.has(serverKey) && !document.hasFocus()) return
  if (isDoNotDisturb()) return // do not disturb: no sounds or notifications (unread badges still count)
  playTone('message')
  if (!document.hasFocus()) void desktop?.attention?.().catch(() => undefined)
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

/** A desktop notification for a new channel message, if your settings want one. */
export function notifyChannelMessage(serverKey: string, message: Message): void {
  const server = useApp.getState().servers[serverKey]
  if (!server || railHooks.isHidden(serverKey)) return // a hidden server stays quiet
  const myKey = me()
  // Blocked people never notify; then your notification level for the channel decides (all, mentions, nothing).
  if (message.author === myKey || senderRules.ignored(message.author) || isBlocked(useBlocks.getState().entries, message.author)) return
  if (!shouldNotify(notifyFor(serverKey, message.channelId), !message.forwarded && senderRules.mentionsMe(server, message))) return
  if (isOnScreen(channelConv(serverKey, message.channelId))) return
  const author = message.webhook?.name ?? server.members[message.author]?.name ?? t('common.someone')
  show(serverKey, t('app.notify.authorIn', { author, where: conversationLabel(server, message.channelId) }), stripMarkdown(plainText(message.text, { nameOf: (k) => server.members[k]?.name ?? null })), () => {
    void jumpToMessage(serverKey, message.channelId, message.id)
  })
}

onServerEvent((serverKey, type, body) => {
  const state = useApp.getState()
  const server = state.servers[serverKey]
  if (!server) return

  // Encrypted channels notify once decrypted (state/e2eeChannels.ts).
  if (type === 'chat.message' && !(body as Events['chat.message']).message.e2ee) notifyChannelMessage(serverKey, (body as Events['chat.message']).message)

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

  if (type === 'dm.message') dmServer.set((body as { message: WireDm }).message.from, serverKey)
})

// DMs notify once decrypted (friend actions notify from friends.ts, or not at all).
const dmServer = new Map<string, string>()
void import('./dms').then(({ onDmOpened, nameOf, openConversation }) => onDmOpened((peer, dms, live) => {
  const dm = dms.at(-1)
  if (!live || !dm || dm.from === me() || dm.friend || isOnScreen(dmConv(peer))) return
  show(dmServer.get(dm.from) ?? '', nameOf(dm.from), dm.error ? t('app.notify.newMessage') : (dm.text || t('app.notify.newMessage')), () => openConversation(peer))
}))

let lastBadge = -1

/** Keeps "(3) Iskra" in the title for unread mentions and DMs (state/unread.ts counts them). */
export function startTitleBadge(): () => void {
  const update = () => {
    const total = badgeTotal()
    document.title = total > 0 ? `(${total}) Iskra` : 'Iskra'
    // The desktop app also shows it on the taskbar / dock.
    if (desktop?.setBadge && total !== lastBadge) {
      lastBadge = total
      void desktop.setBadge(total, overlayIcon(total)).catch(() => undefined)
    }
  }
  const unsubscribe = [useReads.subscribe(update), useApp.subscribe(update), useOrganize.subscribe(update), useThreads.subscribe(update)]
  update()
  return () => unsubscribe.forEach((u) => u())
}
