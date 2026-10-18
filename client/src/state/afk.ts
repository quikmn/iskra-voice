// The AFK channel: each server's setting, telling servers when this device goes idle (no input, not speaking), and the
// notice when a server moved you there. The server decides who is moved and enforces the mute and deafen itself.
import { create } from 'zustand'
import type { AfkSettings, Events } from '../core/protocol'
import { desktop } from '../platform/desktop'
import { ACCOUNT_INPUT_EVENT } from '../platform/accountLink'
import { connectionFor, onServerEvent, onWelcomeHook, useApp } from './store'
import { idleFor, nextReport, type IdleReport } from './voiceIdleLogic'
import { joinVoice, useVoice } from './voice'

export const AFK_MINUTES = [5, 15, 30, 60, 0] as const

interface AfkState {
  /** Per server; missing until afk.get answers (older servers never do). */
  settings: Record<string, AfkSettings>
  /** "You were moved to the AFK channel" notices, newest last. */
  notices: { serverKey: string; channelId: number; minutes: number; at: number }[]
}

export const useAfk = create<AfkState>(() => ({ settings: {}, notices: [] }))

const keep = (serverKey: string, afk: AfkSettings) => useAfk.setState((s) => ({ settings: { ...s.settings, [serverKey]: afk } }))

export const afkChannelOf = (serverKey: string): number | null => useAfk.getState().settings[serverKey]?.channelId ?? null
export const useAfkChannel = (serverKey: string): number | null => useAfk((s) => s.settings[serverKey]?.channelId ?? null)

function connection(serverKey: string) {
  const c = connectionFor(serverKey)
  if (!c) throw new Error('not connected')
  return c
}

export async function updateAfk(serverKey: string, patch: Partial<AfkSettings>): Promise<AfkSettings> {
  const { afk } = await connection(serverKey).request('afk.update', patch)
  keep(serverKey, afk)
  return afk
}

/** "Create AFK channel": a new voice channel, made the AFK channel (owner and admins can talk there). */
export async function createAfkChannel(serverKey: string, name: string): Promise<AfkSettings> {
  const { channel } = await connection(serverKey).request('channel.create', { name, kind: 'voice' })
  return updateAfk(serverKey, { channelId: channel.id })
}

export function dismissAfkNotice(at: number): void {
  useAfk.setState((s) => ({ notices: s.notices.filter((n) => n.at !== at) }))
}

onWelcomeHook((serverKey) => {
  connectionFor(serverKey)?.request('afk.get', {})
    .then(({ afk }) => keep(serverKey, afk))
    .catch(() => undefined) // an older server: no AFK channel
  if (reported) void send(serverKey, { idle: true, idleMs: currentIdle() })
})

onServerEvent((serverKey, type, body) => {
  if (type === 'afk') keep(serverKey, (body as Events['afk']).afk)
  if (type === 'voice.moved' && (body as Events['voice.moved']).reason === 'afk') {
    const { channelId } = body as Events['voice.moved']
    // Follow at once, before LiveKit's removal from the old room ends the session (roles.ts then finds us joining).
    const session = useVoice.getState().session
    if (session?.serverKey === serverKey && !session.call && !session.group) void joinVoice(serverKey, channelId)
    const minutes = useAfk.getState().settings[serverKey]?.idleMinutes ?? 0
    useAfk.setState((s) => ({ notices: [...s.notices.slice(-2), { serverKey, channelId, minutes, at: Date.now() }] }))
  }
})

// ── Idle: no input and not speaking ─────────────────────────────────────────

let lastInput = Date.now()
let lastSpeaking = 0
let systemIdleMs: number | null = null
let reported = false

const currentIdle = () => idleFor({ now: Date.now(), lastInput, lastSpeaking, systemIdleMs })

function send(serverKey: string, report: IdleReport): Promise<unknown> {
  return connectionFor(serverKey)?.request('voice.idle', report).catch(() => undefined) ?? Promise.resolve()
}

function check(): void {
  const report = nextReport(reported, currentIdle())
  if (!report) return
  reported = report.idle
  for (const key of useApp.getState().order) if (connectionFor(key)?.isOnline) void send(key, report)
}

/** Watches input (and the desktop's system idle time) and your own speaking; tells servers when idle starts and ends. */
export function startVoiceIdleWatch(): () => void {
  const active = () => {
    lastInput = Date.now()
    if (systemIdleMs !== null) systemIdleMs = 0
    if (reported) check()
  }
  const visible = () => document.visibilityState === 'visible' && active()
  // Input on another account's page on this device counts too (state/accounts.ts).
  const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'focus', ACCOUNT_INPUT_EVENT] as const
  for (const e of events) window.addEventListener(e, active, { passive: true })
  document.addEventListener('visibilitychange', visible)
  const stopSpeaking = useVoice.subscribe((s, prev) => {
    if (!s.localSpeaking || prev.localSpeaking) return
    lastSpeaking = Date.now()
    if (reported) check()
  })
  const timer = setInterval(async () => {
    if (useVoice.getState().localSpeaking) lastSpeaking = Date.now()
    const seconds = await desktop?.systemIdleSeconds?.().catch(() => null)
    systemIdleMs = typeof seconds === 'number' ? seconds * 1000 : null
    check()
  }, 10_000)
  return () => {
    for (const e of events) window.removeEventListener(e, active)
    document.removeEventListener('visibilitychange', visible)
    stopSpeaking()
    clearInterval(timer)
  }
}
