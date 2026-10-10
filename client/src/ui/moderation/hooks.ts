// Hooks for the moderation UI: a ticking clock, your timeout, and the slowmode countdown.
import { useSyncExternalStore } from 'react'
import { roleRank } from '../../core/protocol'
import { lastSentKey, useLastSent } from '../../state/moderation'
import { slowmodeWait, timeoutActive } from '../../state/moderationRules'
import type { ServerState } from '../../state/store'

// One shared once-a-second clock, running only while something is counting down.
let clock = Date.now()
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!timer) {
    clock = Date.now()
    timer = setInterval(() => {
      clock = Date.now()
      for (const l of listeners) l()
    }, 1000)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      clearInterval(timer)
      timer = undefined
    }
  }
}
const idle = () => () => undefined

/** The time, updated every second while `active` (not meaningful otherwise). */
export function useNow(active: boolean): number {
  return useSyncExternalStore(active ? subscribe : idle, () => clock)
}

export function useTimedOut(server: ServerState): boolean {
  useNow(timeoutActive(server.me))
  return timeoutActive(server.me)
}

/** Milliseconds until you may send in this channel again (admins never wait). */
export function useSlowmodeWait(server: ServerState, channelId: number): { seconds: number; wait: number } {
  const channel = server.channels.find((c) => c.id === channelId)
  const exempt = !server.me || roleRank(server.me.role) >= roleRank('admin')
  const seconds = exempt ? 0 : channel?.slowmode ?? 0
  const recorded = useLastSent((s) => s[lastSentKey(server.key, channelId)])
  const me = server.me?.accountKey
  const latest = seconds
    ? (server.messages[channelId] ?? []).reduce((max, m) => (m.author === me && !m.tempId ? Math.max(max, m.createdAt) : max), 0)
    : 0
  const last = Math.max(recorded ?? 0, latest)
  const waiting = slowmodeWait(seconds, last) > 0
  const now = useNow(waiting)
  return { seconds, wait: waiting ? Math.max(1, slowmodeWait(seconds, last, now)) : 0 }
}
