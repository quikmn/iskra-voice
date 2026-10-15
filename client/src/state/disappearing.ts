// Disappearing messages (PROTOCOL.md "Disappearing messages"). Keeps the timers servers report (channels, DMs, groups),
// works out which timer a conversation sends with, changes it, and deletes this device's copies of messages whose time
// has come: on screen, in storage (DMs, groups, encrypted channels) and notifications. The deadline is stored with each
// copy, so a device that was off deletes them as soon as it starts.
import { create } from 'zustand'
import { effectiveTimer, isTimer } from '../core/disappear'
import type { DisappearTimer, Events } from '../core/protocol'
import { t } from '../i18n'
import { purgeExpiredDms, setDmExpiry, sendDm, sharedServers, useDms, type Dm } from './dms'
import { purgeExpiredE2ee, setE2eeExpiry } from './e2eeChannels'
import { groupKey, purgeExpiredGroups, sendGroupMessage, setGroupExpiry, useGroups } from './groups'
import type { GroupMsg } from './groupLogic'
import { resolveKey } from './keyMap'
import { knownThread } from './threads'
import { connectionFor, onServerEvent, onWelcomeHook, patchServer, useApp } from './store'

interface Timers {
  /** serverKey → channel id → timer. */
  channels: Record<string, Record<number, DisappearTimer>>
  /** The other person → serverKey → timer (a DM can run over several servers). */
  dms: Record<string, Record<string, DisappearTimer>>
  /** "<serverKey>/<groupId>" → timer. */
  groups: Record<string, DisappearTimer>
}

export const useDisappear = create<Timers>(() => ({ channels: {}, dms: {}, groups: {} }))

function remember(serverKey: string, timer: DisappearTimer): void {
  if (!isTimer(timer.seconds)) return
  useDisappear.setState((s) => {
    if (timer.scope === 'channel') return { channels: { ...s.channels, [serverKey]: { ...s.channels[serverKey], [timer.channelId]: timer } } }
    if (timer.scope === 'group') return { groups: { ...s.groups, [groupKey(serverKey, timer.groupId)]: timer } }
    const peer = resolveKey(timer.accountKey)
    return { dms: { ...s.dms, [peer]: { ...s.dms[peer], [serverKey]: timer } } }
  })
}

async function loadTimers(serverKey: string): Promise<void> {
  try {
    const { timers } = await connectionFor(serverKey)!.request('disappear.list', {})
    // A server's list replaces what it said before (channels you can no longer read drop out).
    useDisappear.setState((s) => ({ channels: { ...s.channels, [serverKey]: {} } }))
    for (const timer of timers) remember(serverKey, timer)
  } catch {
    /* an older server, or busy: no timers from it */
  }
}

onWelcomeHook((serverKey) => void loadTimers(serverKey))
onServerEvent((serverKey, type, body) => {
  if (type === 'disappear.changed') remember(serverKey, (body as Events['disappear.changed']).timer)
  // Channels you can read changed: their timers may have too.
  if (type === 'channels') void loadTimers(serverKey)
})

// ── Which timer a conversation sends with ──────────────────────────────────

/** The newest timer change line this device read in a conversation (signed by whoever changed it), if any. */
export function inBandTimer(messages: (Pick<Dm, 'disappear' | 'error' | 'pending' | 'sentAt'>)[]): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.disappear && !m.error && !m.pending && isTimer(m.disappear.seconds)) return m.disappear.seconds
  }
  return undefined
}

/** A channel's (or a thread's parent's) timer, in seconds; 0 = off. */
export function channelSeconds(state: Timers, serverKey: string, channelId: number): number {
  const parent = knownThread(serverKey, channelId)?.channelId ?? channelId
  return state.channels[serverKey]?.[parent]?.seconds ?? 0
}

/**
 * A DM's timer: the stricter of what the servers we share with the person say and the newest change line in the
 * conversation, so neither a server nor a missed event turns it off quietly.
 */
export function dmSeconds(state: Timers, peer: string, messages: Dm[] = useDms.getState().conversations[peer]?.messages ?? []): number {
  return effectiveTimer(Object.values(state.dms[peer] ?? {}).map((x) => x.seconds), inBandTimer(messages))
}

export function groupSeconds(state: Timers, key: string, messages: GroupMsg[] = useGroups.getState().groups[key]?.messages ?? []): number {
  return effectiveTimer([state.groups[key]?.seconds], inBandTimer(messages))
}

export const useChannelTimer = (serverKey: string, channelId: number) => useDisappear((s) => channelSeconds(s, serverKey, channelId))
export const useDmTimer = (peer: string) => {
  const messages = useDms((s) => s.conversations[peer]?.messages)
  return useDisappear((s) => dmSeconds(s, peer, messages ?? []))
}
export const useGroupTimer = (key: string) => {
  const messages = useGroups((s) => s.groups[key]?.messages)
  return useDisappear((s) => groupSeconds(s, key, messages ?? []))
}

setDmExpiry((peer) => dmSeconds(useDisappear.getState(), peer))
setGroupExpiry((key) => groupSeconds(useDisappear.getState(), key))
setE2eeExpiry((serverKey, channelId) => channelSeconds(useDisappear.getState(), serverKey, channelId))

// ── Changing it ────────────────────────────────────────────────────────────

/** What apps from before disappearing messages show for a change line (they don't know `disappear`). */
const fallback = (seconds: number) =>
  seconds === 0 ? t('disappear.fallback.off') : t('disappear.fallback.on', { duration: t(`disappear.timers.${seconds}` as 'disappear.timers.300') })

export async function setChannelTimer(serverKey: string, channelId: number, seconds: number): Promise<void> {
  const { timer } = await connectionFor(serverKey)!.request('disappear.set', { channelId, seconds })
  remember(serverKey, timer)
}

/** Sets the timer on every server you share with the person, then tells them with a (signed, encrypted) change line. */
export async function setDmTimer(peer: string, seconds: number): Promise<void> {
  const servers = sharedServers(peer)
  const results = await Promise.allSettled(servers.map(async (serverKey) => {
    const { timer } = await connectionFor(serverKey)!.request('disappear.set', { accountKey: peer, seconds })
    remember(serverKey, timer)
  }))
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (results.length > 0 && results.every((r) => r.status === 'rejected')) throw failed!.reason
  await sendDm(peer, fallback(seconds), { disappear: { seconds } })
}

export async function setGroupTimer(key: string, seconds: number): Promise<void> {
  const g = useGroups.getState().groups[key]
  if (!g) return
  const { timer } = await connectionFor(g.serverKey)!.request('disappear.set', { groupId: g.id, seconds })
  remember(g.serverKey, timer)
  await sendGroupMessage(key, fallback(seconds), { disappear: { seconds } })
}

// ── Deleting what expired ──────────────────────────────────────────────────

/** Takes expired channel messages (plain and decrypted) off the screen; the server deletes its copies too. */
export function purgeChannels(now = Date.now()): void {
  for (const [serverKey, server] of Object.entries(useApp.getState().servers)) {
    const changed: Record<number, typeof server.messages[number]> = {}
    for (const [id, list] of Object.entries(server.messages)) {
      if (list.some((m) => typeof m.expiresAt === 'number' && m.expiresAt <= now))
        changed[Number(id)] = list.filter((m) => !(typeof m.expiresAt === 'number' && m.expiresAt <= now))
    }
    if (Object.keys(changed).length) patchServer(serverKey, (s) => ({ messages: { ...s.messages, ...changed } }))
  }
}

export function purgeExpired(now = Date.now()): void {
  purgeChannels(now)
  purgeExpiredDms(now)
  purgeExpiredGroups(now)
  purgeExpiredE2ee(now)
}

let ticking: ReturnType<typeof setInterval> | null = null
/** Checks every second while the app runs (and once right away, for what expired while it was closed). */
export function startPurging(): void {
  if (ticking) return
  purgeExpired()
  ticking = setInterval(() => purgeExpired(), 1000)
}

useApp.subscribe((state) => {
  if (state.phase === 'ready') startPurging()
})
