// Your status (online, idle, do not disturb, invisible) and custom status. Chosen once on this device and sent to
// every server you're on; a newer choice from another device (presence.self, welcome) is adopted and passed on.
// Idle is also automatic: no input for 10 minutes marks this device idle on every server.
import { create } from 'zustand'
import { b64u } from '../core/crypto'
import type { ChosenStatus, CustomStatus, Member, Presence } from '../core/protocol'
import { activeCustom, bestStatus, isNewer, statusOf, type ShownStatus } from './presenceRules'
import { connectionFor, onServerEvent, onWelcomeHook, setAuthPresence, setInvisibleCheck, useApp } from './store'

const KEY = 'iskra.presence'
export const IDLE_AFTER_MS = 10 * 60_000

interface PresenceState {
  mine: Presence
  /** No input on this device for a while. */
  idle: boolean
  /** Bumped every minute so expiring custom statuses disappear on time. */
  tick: number
}

const DEFAULT: Presence = { status: 'online', custom: null, updatedAt: 0 }
const STATUSES: ChosenStatus[] = ['online', 'idle', 'dnd', 'invisible']

function load(): Presence {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Presence | null
    if (saved && STATUSES.includes(saved.status) && typeof saved.updatedAt === 'number') return { ...DEFAULT, ...saved }
  } catch {
    /* private mode or junk */
  }
  return DEFAULT
}

export const usePresence = create<PresenceState>(() => ({ mine: load(), idle: false, tick: 0 }))

function save(mine: Presence): void {
  usePresence.setState({ mine })
  try {
    localStorage.setItem(KEY, JSON.stringify(mine))
  } catch {
    /* private mode */
  }
}

/** Never-chosen presence isn't sent: servers treat that as online. */
const wire = (p: Presence): Presence | undefined => (p.updatedAt > 0 ? { ...p, custom: activeCustom(p.custom) } : undefined)
setAuthPresence(() => wire(usePresence.getState().mine))

const onlineServers = () => useApp.getState().order.filter((key) => connectionFor(key)?.isOnline)

function sendTo(serverKey: string, presence: Presence): void {
  const connection = connectionFor(serverKey)
  if (!connection?.isOnline) return
  connection.request('presence.set', presence)
    .then(({ presence: kept }) => adopt(kept, serverKey))
    .catch(() => undefined) // older servers don't know presence
}

/** Takes a newer choice made elsewhere and passes it on to the other servers. */
function adopt(theirs: Presence | null | undefined, from: string): void {
  const mine = usePresence.getState().mine
  if (!isNewer(theirs, mine) || !STATUSES.includes(theirs.status)) return
  save({ status: theirs.status, custom: theirs.custom ?? null, updatedAt: theirs.updatedAt })
  for (const key of onlineServers()) if (key !== from) sendTo(key, theirs)
}

function choose(patch: Partial<Presence>): void {
  const next = { ...usePresence.getState().mine, ...patch, updatedAt: Math.max(Date.now(), usePresence.getState().mine.updatedAt + 1) }
  save(next)
  for (const key of onlineServers()) sendTo(key, next)
}

export const setStatus = (status: ChosenStatus) => choose({ status })
export const setCustomStatus = (custom: CustomStatus | null) => choose({ custom })

export const isDoNotDisturb = () => usePresence.getState().mine.status === 'dnd'
export const isInvisible = () => usePresence.getState().mine.status === 'invisible'
setInvisibleCheck(isInvisible)

// ── Showing it ──────────────────────────────────────────────────────────────

const myKey = () => {
  const identity = useApp.getState().identity
  return identity ? b64u(identity.account.publicKey) : ''
}

/** Your own status as you see it (invisible included). */
export function myShownStatus(state: PresenceState = usePresence.getState()): ShownStatus {
  const { status } = state.mine
  return status === 'online' && state.idle ? 'idle' : status
}

/** A member's status and custom status; for yourself, what you chose on this device. */
export function useMemberPresence(member: Member | undefined): { status: ShownStatus; custom: CustomStatus | null } {
  const state = usePresence()
  if (member && member.accountKey === myKey()) return { status: myShownStatus(state), custom: activeCustom(state.mine.custom) }
  return { status: statusOf(member), custom: statusOf(member) === 'offline' ? null : activeCustom(member?.customStatus) }
}

/** Someone you may meet on several servers (DMs, friends): their most present status there. */
export function useAccountPresence(accountKey: string): { status: ShownStatus; custom: CustomStatus | null } {
  const state = usePresence()
  const servers = useApp((s) => s.servers)
  if (accountKey === myKey()) return { status: myShownStatus(state), custom: activeCustom(state.mine.custom) }
  const members = Object.values(servers).map((s) => s.members[accountKey]).filter((m): m is Member => !!m)
  const status = bestStatus(members.map(statusOf))
  const custom = status === 'offline' ? null : members.map((m) => activeCustom(m.customStatus)).find((c) => c) ?? null
  return { status, custom }
}

// ── Keeping servers in step ─────────────────────────────────────────────────

onWelcomeHook((serverKey, welcome) => {
  adopt(welcome.presence, serverKey)
  if (usePresence.getState().idle) connectionFor(serverKey)?.request('presence.idle', { idle: true }).catch(() => undefined)
})

onServerEvent((serverKey, type, body) => {
  if (type === 'presence.self') adopt((body as { presence: Presence }).presence, serverKey)
})

function setIdle(idle: boolean): void {
  if (usePresence.getState().idle === idle) return
  usePresence.setState({ idle })
  for (const key of onlineServers()) connectionFor(key)?.request('presence.idle', { idle }).catch(() => undefined)
}

/** Watches for input (idle after 10 minutes without) and clears your custom status when it expires. */
export function startPresenceWatch(): () => void {
  let last = Date.now()
  const active = () => {
    last = Date.now()
    if (usePresence.getState().idle) setIdle(false)
  }
  const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'focus'] as const
  for (const e of events) window.addEventListener(e, active, { passive: true })
  const timer = setInterval(() => {
    if (Date.now() - last >= IDLE_AFTER_MS) setIdle(true)
    const { custom } = usePresence.getState().mine
    if (custom && !activeCustom(custom)) setCustomStatus(null)
    usePresence.setState((s) => ({ tick: s.tick + 1 }))
  }, 30_000)
  return () => {
    for (const e of events) window.removeEventListener(e, active)
    clearInterval(timer)
  }
}
