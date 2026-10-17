// Activities: shared mini-apps in a voice call (PROTOCOL.md → Activities). The server keeps one session per voice
// channel and relays what the activity sends; the frame that runs it lives in ui/activities/ActivityFrame.tsx and
// talks to this file. Built-ins ship with the app; server-added ones come from the server they were added to.
import { create } from 'zustand'
import { roleRank, type ActivityCatalog, type ActivityJoin, type ActivityMessage, type ActivitySession, type Channel, type Events, type Role } from '../core/protocol'
import { connectionFor, onChannelsGone, onServerEvent, onWelcomeHook, type ServerState } from './store'
import { withoutChannels } from './channelGone'
import { t } from '../i18n'

interface ActivityStore {
  /** `${serverKey}:${channelId}` → the session running there. */
  sessions: Record<string, ActivitySession>
  /** `${serverKey}:${channelId}` → what joining answered, while this app is in that session. */
  joined: Record<string, ActivityJoin>
  /** Per server, once asked for (act.catalog makes it stale). */
  catalogs: Record<string, ActivityCatalog>
}

export const useActivities = create<ActivityStore>(() => ({ sessions: {}, joined: {}, catalogs: {} }))

export const activityKey = (serverKey: string, channelId: number) => `${serverKey}:${channelId}`
export const sessionFor = (serverKey: string, channelId: number) => (s: ActivityStore) =>
  s.sessions[activityKey(serverKey, channelId)] as ActivitySession | undefined
export const joinedFor = (serverKey: string, channelId: number) => (s: ActivityStore) =>
  s.joined[activityKey(serverKey, channelId)] as ActivityJoin | undefined

type MessageListener = (message: ActivityMessage) => void
const listeners = new Map<string, Set<MessageListener>>()

/** Live messages of the session in this channel (for the frame showing it). Returns the unsubscribe. */
export function onActivityMessage(serverKey: string, channelId: number, listener: MessageListener): () => void {
  const key = activityKey(serverKey, channelId)
  let set = listeners.get(key)
  if (!set) listeners.set(key, (set = new Set()))
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(key)
  }
}

function dropJoined(key: string) {
  useActivities.setState((s) => {
    if (!s.joined[key]) return s
    const joined = { ...s.joined }
    delete joined[key]
    return { joined }
  })
}

onWelcomeHook((serverKey, welcome) => {
  useActivities.setState((s) => {
    const mine = (k: string) => k.startsWith(`${serverKey}:`)
    const sessions = Object.fromEntries(Object.entries(s.sessions).filter(([k]) => !mine(k)))
    for (const session of welcome.activities ?? []) sessions[activityKey(serverKey, session.channelId)] = session
    // A new connection hasn't joined anything yet.
    const joined = Object.fromEntries(Object.entries(s.joined).filter(([k]) => !mine(k)))
    const catalogs = { ...s.catalogs }
    delete catalogs[serverKey]
    return { sessions, joined, catalogs }
  })
})

onServerEvent((serverKey, type, body) => {
  if (type === 'act.session') {
    const { channelId, session } = body as Events['act.session']
    const key = activityKey(serverKey, channelId)
    useActivities.setState((s) => {
      const sessions = { ...s.sessions }
      if (session) sessions[key] = session
      else delete sessions[key]
      // Joined a session that ended (or was replaced): not any more.
      let joined = s.joined
      if (joined[key] && joined[key].session.id !== session?.id) {
        joined = { ...joined }
        delete joined[key]
      }
      return { sessions, joined }
    })
  } else if (type === 'act.msg') {
    const { channelId, sessionId, seq, from, data } = body as Events['act.msg']
    const key = activityKey(serverKey, channelId)
    const current = useActivities.getState().sessions[key]
    if (current && current.id !== sessionId) return
    for (const listener of listeners.get(key) ?? []) listener({ seq, from, data })
  } else if (type === 'act.catalog') {
    const had = !!useActivities.getState().catalogs[serverKey]
    useActivities.setState((s) => {
      const catalogs = { ...s.catalogs }
      delete catalogs[serverKey]
      return { catalogs }
    })
    if (had) void loadCatalog(serverKey).catch(() => undefined)
  }
})

onChannelsGone((serverKey, channelIds) => {
  useActivities.setState((s) => ({ sessions: withoutChannels(s.sessions, serverKey, channelIds), joined: withoutChannels(s.joined, serverKey, channelIds) }))
})

function connection(serverKey: string) {
  const c = connectionFor(serverKey)
  if (!c) throw new Error(t('activities.notConnected'))
  return c
}

export async function loadCatalog(serverKey: string): Promise<ActivityCatalog> {
  const catalog = await connection(serverKey).request('act.list', {})
  useActivities.setState((s) => ({ catalogs: { ...s.catalogs, [serverKey]: catalog } }))
  return catalog
}

/** Starts an activity and joins it (the starter's connection is in it already; joining answers what the frame needs). */
export async function startActivity(serverKey: string, channelId: number, activity: string): Promise<void> {
  const { session } = await connection(serverKey).request('act.start', { channelId, activity })
  useActivities.setState((s) => ({ sessions: { ...s.sessions, [activityKey(serverKey, channelId)]: session } }))
  await joinActivity(serverKey, channelId, session.id)
}

export async function joinActivity(serverKey: string, channelId: number, sessionId: string): Promise<ActivityJoin> {
  const joined = await connection(serverKey).request('act.join', { channelId, sessionId })
  const key = activityKey(serverKey, channelId)
  useActivities.setState((s) => ({ joined: { ...s.joined, [key]: joined }, sessions: { ...s.sessions, [key]: joined.session } }))
  return joined
}

export async function leaveActivity(serverKey: string, channelId: number, sessionId?: string): Promise<void> {
  dropJoined(activityKey(serverKey, channelId))
  await connectionFor(serverKey)?.request('act.leave', { channelId, ...(sessionId ? { sessionId } : {}) }).catch(() => undefined)
}

export async function endActivity(serverKey: string, channelId: number, sessionId: string): Promise<void> {
  await connection(serverKey).request('act.end', { channelId, sessionId })
}

export async function sendToActivity(serverKey: string, channelId: number, sessionId: string, data: unknown): Promise<void> {
  await connection(serverKey).request('act.send', { channelId, sessionId, data })
}

export async function snapshotActivity(serverKey: string, channelId: number, sessionId: string, seq: number, state: unknown): Promise<void> {
  await connection(serverKey).request('act.snapshot', { channelId, sessionId, seq, state })
}

// ── Server settings → Activities ────────────────────────────────────────────

export async function addActivity(serverKey: string, file: string) {
  const { activity } = await connection(serverKey).request('act.add', { file })
  await loadCatalog(serverKey)
  return activity
}

export async function setActivityEnabled(serverKey: string, id: string, enabled: boolean): Promise<void> {
  await connection(serverKey).request('act.update', { id, enabled })
  await loadCatalog(serverKey)
}

export async function removeActivity(serverKey: string, id: string): Promise<void> {
  await connection(serverKey).request('act.remove', { id })
  await loadCatalog(serverKey)
}

export async function configureActivities(serverKey: string, change: { startRole?: Role; channelId?: number; off?: boolean }): Promise<void> {
  await connection(serverKey).request('act.configure', change)
  await loadCatalog(serverKey)
}

// ── Who may do what (mirrors ActivitiesFeature) ─────────────────────────────

/** Why this member can't start an activity in this voice channel, or null if they can. */
export function startRefusal(server: ServerState, channel: Channel, catalog: ActivityCatalog | undefined): 'e2ee' | 'off' | 'listen' | 'role' | 'bot' | null {
  const me = server.me
  if (!me || me.bot) return 'bot'
  if (channel.e2ee) return 'e2ee'
  if (catalog?.off.includes(channel.id)) return 'off'
  if (roleRank(me.role) < roleRank(channel.writeRole)) return 'listen'
  if (catalog && roleRank(me.role) < roleRank(catalog.startRole)) return 'role'
  return null
}

/** The starter, an admin, or any player once the starter has left the call. */
export function mayEnd(server: ServerState, session: ActivitySession, inCall: string[]): boolean {
  const me = server.me
  if (!me) return false
  if (session.startedBy === me.accountKey || roleRank(me.role) >= roleRank('admin')) return true
  return !inCall.includes(session.startedBy) && session.players.some((p) => p.accountKey === me.accountKey)
}
