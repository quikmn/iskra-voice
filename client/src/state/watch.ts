// Watch parties: the server keeps a shared play/pause/position clock per voice channel; each client plays the
// video itself and follows that clock (see watchSync.ts for the math).
import { create } from 'zustand'
import { roleRank, type Channel, type Events, type StageState, type WatchParty, type WatchSourceInput } from '../core/protocol'
import { connectionFor, onServerEvent, onWelcomeHook, type ServerState } from './store'
import { isStageModerator } from './stages'
import { bestOffset, clockSample, type ClockSample } from './watchSync'
import { t } from '../i18n'

export interface WatchChatLine {
  accountKey: string
  text: string
  at: number
}

interface WatchStore {
  /** `${serverKey}:${channelId}` → the party there. */
  parties: Record<string, WatchParty>
  chat: Record<string, WatchChatLine[]>
  /** Server clock minus ours (ms), per server. */
  offsets: Record<string, number>
}

export const useWatch = create<WatchStore>(() => ({ parties: {}, chat: {}, offsets: {} }))

const MAX_CHAT = 100
export const watchKey = (serverKey: string, channelId: number) => `${serverKey}:${channelId}`
export const partyFor = (serverKey: string, channelId: number) => (s: WatchStore) => s.parties[watchKey(serverKey, channelId)] as WatchParty | undefined

/** Now, on the server's clock. */
export const serverNow = (serverKey: string) => Date.now() + (useWatch.getState().offsets[serverKey] ?? 0)

const calibrating = new Set<string>()

/** Measures the server clock a few times and keeps the most precise answer. */
export async function calibrateClock(serverKey: string): Promise<void> {
  const connection = connectionFor(serverKey)
  if (!connection || calibrating.has(serverKey)) return
  calibrating.add(serverKey)
  try {
    const samples: ClockSample[] = []
    for (let i = 0; i < 4; i++) {
      const sentAt = Date.now()
      const { now } = await connection.request('watch.clock', {})
      samples.push(clockSample(sentAt, now, Date.now()))
    }
    useWatch.setState((s) => ({ offsets: { ...s.offsets, [serverKey]: bestOffset(samples) } }))
  } catch {
    /* keep the rough estimate */
  } finally {
    calibrating.delete(serverKey)
  }
}

onWelcomeHook((serverKey, welcome) => {
  useWatch.setState((s) => {
    const parties = Object.fromEntries(Object.entries(s.parties).filter(([k]) => !k.startsWith(`${serverKey}:`)))
    for (const party of welcome.watch ?? []) parties[watchKey(serverKey, party.channelId)] = party
    return { parties }
  })
  if (welcome.watch?.length) void calibrateClock(serverKey)
})

onServerEvent((serverKey, type, body) => {
  if (type === 'watch.state') {
    const { channelId, party, serverTime } = body as Events['watch.state']
    const key = watchKey(serverKey, channelId)
    useWatch.setState((s) => {
      const parties = { ...s.parties }
      if (party) parties[key] = party
      else delete parties[key]
      // Until we've measured properly, the event's own timestamp is a fair guess.
      const offsets = s.offsets[serverKey] === undefined ? { ...s.offsets, [serverKey]: serverTime - Date.now() } : s.offsets
      const chat = party && s.parties[key]?.id === party.id ? s.chat : { ...s.chat, [key]: [] }
      return { parties, offsets, chat }
    })
    if (party) void calibrateClock(serverKey)
  } else if (type === 'watch.chat') {
    const { channelId, accountKey, text, at } = body as Events['watch.chat']
    const key = watchKey(serverKey, channelId)
    useWatch.setState((s) => ({ chat: { ...s.chat, [key]: [...(s.chat[key] ?? []), { accountKey, text, at }].slice(-MAX_CHAT) } }))
  }
})

/** Who may start or host a party (mirrors WatchRegistry.MayHost). */
export function mayHostWatch(server: ServerState, channel: Channel, stage: StageState | undefined): boolean {
  const me = server.me
  if (!me) return false
  if (channel.kind === 'stage') return !!stage?.speakers.includes(me.accountKey) || isStageModerator(server, stage, me.accountKey)
  return roleRank(me.role) >= roleRank(channel.writeRole)
}

/** Admins in voice channels, moderators on stages (mirrors WatchRegistry.IsModerator). */
export function isWatchModerator(server: ServerState, channel: Channel, stage: StageState | undefined): boolean {
  const me = server.me
  if (!me) return false
  return channel.kind === 'stage' ? isStageModerator(server, stage, me.accountKey) : roleRank(me.role) >= roleRank('admin')
}

export function canControlWatch(server: ServerState, channel: Channel, stage: StageState | undefined, party: WatchParty): boolean {
  if (!mayHostWatch(server, channel, stage)) return false
  return party.host === server.me?.accountKey || party.anyoneControls || isWatchModerator(server, channel, stage)
}

function connection(serverKey: string) {
  const c = connectionFor(serverKey)
  if (!c) throw new Error(t('watch.notConnected'))
  return c
}

export async function startWatch(serverKey: string, channelId: number, source: WatchSourceInput, title?: string): Promise<void> {
  await connection(serverKey).request('watch.start', { channelId, source, ...(title ? { title } : {}) })
}

export async function controlWatch(serverKey: string, party: WatchParty, change: { playing?: boolean; position?: number; rate?: number }): Promise<void> {
  await connection(serverKey).request('watch.control', { channelId: party.channelId, partyId: party.id, ...change })
}

export async function setAnyoneControls(serverKey: string, party: WatchParty, anyoneControls: boolean): Promise<void> {
  await connection(serverKey).request('watch.settings', { channelId: party.channelId, partyId: party.id, anyoneControls })
}

export async function stopWatch(serverKey: string, party: WatchParty): Promise<void> {
  await connection(serverKey).request('watch.stop', { channelId: party.channelId, partyId: party.id })
}

export async function sendWatchChat(serverKey: string, channelId: number, text: string): Promise<void> {
  await connection(serverKey).request('watch.chat', { channelId, text })
}
