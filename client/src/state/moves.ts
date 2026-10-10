// Following a server that moved to another address: a notice signed with its key (in welcome, as an event, or
// fetched from the old address while it can't be reached) moves the saved address once the signature checks out.
import { create } from 'zustand'
import { sameServerUrl, verifyMoveNotice } from '../core/move'
import type { Events, MoveNotice } from '../core/protocol'
import { moveServer, onServerEvent, onWelcomeHook, useApp } from './store'

interface MoveState {
  /** serverKey → the address it was followed from, shown once in the server's overview. */
  followed: Record<string, { from: string; to: string; at: number }>
}

export const useMoves = create<MoveState>(() => ({ followed: {} }))

/** Follows a notice if it's valid for this server and points somewhere new. Returns whether it moved. */
export function followNotice(serverKey: string, notice: unknown): boolean {
  const server = useApp.getState().servers[serverKey]
  if (!server || !verifyMoveNotice(notice, serverKey)) return false
  const { url } = notice as MoveNotice
  if (sameServerUrl(url, server.url)) return false
  useMoves.setState((s) => ({ followed: { ...s.followed, [serverKey]: { from: server.url, to: url, at: Date.now() } } }))
  moveServer(serverKey, url)
  return true
}

const CHECK_EVERY_MS = 60_000
const lastCheck = new Map<string, number>()

/** While a server can't be reached, ask its old address (at most once a minute) whether it left a notice. */
async function checkUnreachable(serverKey: string, url: string): Promise<void> {
  const now = Date.now()
  if (now - (lastCheck.get(serverKey) ?? 0) < CHECK_EVERY_MS) return
  lastCheck.set(serverKey, now)
  try {
    const response = await fetch(`${url}/.well-known/iskra-moved`, { signal: AbortSignal.timeout(5000), cache: 'no-store' })
    if (!response.ok) return
    const notice: unknown = await response.json()
    if (useApp.getState().servers[serverKey]?.url === url) followNotice(serverKey, notice)
  } catch {
    /* not there either */
  }
}

onWelcomeHook((serverKey, welcome) => {
  if (welcome.server.moved) followNotice(serverKey, welcome.server.moved)
})

onServerEvent((serverKey, type, body) => {
  if (type !== 'server.moved') return
  const { notice } = body as Events['server.moved']
  if (notice) followNotice(serverKey, notice)
})

useApp.subscribe((state, previous) => {
  for (const [key, server] of Object.entries(state.servers)) {
    const before = previous.servers[key]
    if (server.status.state === 'offline' && before?.status.state !== 'offline' && server.me) void checkUnreachable(key, server.url)
  }
})
