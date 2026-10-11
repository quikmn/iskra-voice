// Server rules and the welcome screen: kept per server from welcome and the `rules` event.
import { create } from 'zustand'
import type { Events, Requests, ServerRules } from '../core/protocol'
import { connectionFor, onServerEvent, onWelcomeHook } from './store'

interface RulesState {
  /** serverKey → the rules as you see them there. */
  rules: Record<string, ServerRules | undefined>
  /** The rules screen, when open. */
  open: string | null
  /** serverKey → the rules version whose welcome screen you closed without agreeing (not shown by itself again). */
  dismissed: Record<string, number | undefined>
}

export const useRules = create<RulesState>(() => ({ rules: {}, open: null, dismissed: {} }))

function put(serverKey: string, rules: ServerRules): void {
  useRules.setState((s) => {
    // Admin counts only come with rules.get / rules.update; keep them across events.
    const old = s.rules[serverKey]
    const merged = rules.agreed == null && old?.agreed != null ? { ...rules, agreed: old.agreed, members: old.members } : rules
    return { rules: { ...s.rules, [serverKey]: merged } }
  })
}

onWelcomeHook((serverKey, welcome) => {
  if (welcome.rules) put(serverKey, welcome.rules)
})

onServerEvent((serverKey, type, body) => {
  if (type === 'rules') put(serverKey, (body as Events['rules']).rules)
})

function connection(serverKey: string) {
  const c = connectionFor(serverKey)
  if (!c) throw new Error('Not connected to this server.')
  return c
}

export const useServerRules = (serverKey: string) => useRules((s) => s.rules[serverKey])
/** True while you still have to agree to this server's rules. */
export const useMustAgree = (serverKey: string) => useRules((s) => !!s.rules[serverKey]?.mustAgree)

export function showRules(serverKey: string): void {
  useRules.setState({ open: serverKey })
}

/** Closes the rules screen; if you hadn't agreed yet, it won't open by itself again for this version. */
export function closeRules(): void {
  useRules.setState((s) => {
    const key = s.open
    const rules = key ? s.rules[key] : undefined
    return { open: null, dismissed: key && rules?.mustAgree ? { ...s.dismissed, [key]: rules.version } : s.dismissed }
  })
}

export async function acceptRules(serverKey: string): Promise<void> {
  const version = useRules.getState().rules[serverKey]?.version ?? 0
  try {
    const { rules } = await connection(serverKey).request('rules.accept', { version })
    put(serverKey, rules)
  } catch (e) {
    // The rules changed while you were reading: show the new ones.
    if ((e as { code?: string }).code === 'conflict') await loadRules(serverKey).catch(() => undefined)
    throw e
  }
}

export async function loadRules(serverKey: string): Promise<ServerRules> {
  const { rules } = await connection(serverKey).request('rules.get', {})
  put(serverKey, rules)
  return rules
}

export async function updateRules(serverKey: string, body: Requests['rules.update'][0]): Promise<ServerRules> {
  const { rules } = await connection(serverKey).request('rules.update', body)
  put(serverKey, rules)
  return rules
}
