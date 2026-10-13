// Outgoing webhooks: the notice when one turned itself off, and where each server sends things ("Who Iskra talks to").
import { create } from 'zustand'
import type { OutHook, OutHookEvent } from '../core/protocol'
import { connectionFor, onServerEvent, useApp } from './store'

interface Notice {
  server: string
  hook: OutHook
}

export const useOuthookNotices = create<{ notices: Notice[] }>(() => ({ notices: [] }))

onServerEvent((server, type, body) => {
  if (type !== 'outhook.disabled') return
  const { hook } = body as { hook: OutHook }
  useOuthookNotices.setState((s) => ({ notices: [...s.notices.filter((n) => n.hook.id !== hook.id), { server, hook }] }))
})

export function dismissOuthookNotice(id: string): void {
  useOuthookNotices.setState((s) => ({ notices: s.notices.filter((n) => n.hook.id !== id) }))
}

export interface ServerHosts {
  server: string
  name: string
  hooks: { name: string; host: string; events: OutHookEvent[] }[]
}

/** Every connected server's outgoing webhooks (servers without any are left out). */
export async function outgoingHosts(): Promise<ServerHosts[]> {
  const { servers, order } = useApp.getState()
  const results = await Promise.all(order.map(async (key) => {
    const connection = connectionFor(key)
    if (!connection || !servers[key]) return null
    try {
      const { hooks } = await connection.request('outhook.hosts', {})
      return hooks.length > 0 ? { server: key, name: servers[key].name, hooks } : null
    } catch {
      return null // an older server, or not connected right now
    }
  }))
  return results.filter((r): r is ServerHosts => r !== null)
}
