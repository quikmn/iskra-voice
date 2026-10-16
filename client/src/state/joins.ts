// Join gating: who is waiting to be let in (moderators), whether invites are paused right now (everyone, from the
// welcome and `invites.paused`), and the join settings admins change (pause, newcomer slowmode). See "Join gating and
// raid controls" in PROTOCOL.md. The waiting joiner's own side is the connection's `pending` status.
import { create } from 'zustand'
import type { Events, JoinRequest, JoinSettings } from '../core/protocol'
import { t } from '../i18n'
import { connectionFor, onServerEvent, onWelcomeHook } from './store'

interface JoinsState {
  /** serverKey → people waiting (0 unless you moderate). */
  pending: Record<string, number>
  /** serverKey → invites are paused there. */
  paused: Record<string, boolean>
  /** serverKey → the join settings, once an admin's screen loaded them. */
  settings: Record<string, JoinSettings | undefined>
}

export const useJoins = create<JoinsState>(() => ({ pending: {}, paused: {}, settings: {} }))

const setPending = (serverKey: string, pending: number) => useJoins.setState((s) => ({ pending: { ...s.pending, [serverKey]: pending } }))
const setPaused = (serverKey: string, paused: boolean) => useJoins.setState((s) => ({ paused: { ...s.paused, [serverKey]: paused } }))
const putSettings = (serverKey: string, settings: JoinSettings) => {
  useJoins.setState((s) => ({ settings: { ...s.settings, [serverKey]: settings } }))
  setPaused(serverKey, settings.invitesPaused)
}

onWelcomeHook((serverKey, welcome) => {
  setPaused(serverKey, !!welcome.server.invitesPaused)
  connectionFor(serverKey)?.request('join.count', {}).then((r) => setPending(serverKey, r.pending), () => undefined)
})

onServerEvent((serverKey, type, body) => {
  if (type === 'join.count') setPending(serverKey, (body as Events['join.count']).pending)
  if (type === 'invites.paused') setPaused(serverKey, (body as Events['invites.paused']).paused)
  if (type === 'join.settings') putSettings(serverKey, (body as Events['join.settings']).settings)
})

function connection(serverKey: string) {
  const c = connectionFor(serverKey)
  if (!c) throw new Error(t('errors.codes.disconnected'))
  return c
}

export const usePendingJoins = (serverKey: string) => useJoins((s) => s.pending[serverKey] ?? 0)
export const useInvitesPaused = (serverKey: string) => useJoins((s) => !!s.paused[serverKey])

export async function listJoinRequests(serverKey: string): Promise<JoinRequest[]> {
  return (await connection(serverKey).request('join.list', {})).requests
}

/** The queue updates when the server's `join.count` arrives, not here. */
export async function approveJoin(serverKey: string, accountKey: string): Promise<void> {
  await connection(serverKey).request('join.approve', { accountKey })
}

export async function declineJoin(serverKey: string, accountKey: string): Promise<void> {
  await connection(serverKey).request('join.decline', { accountKey })
}

export async function loadJoinSettings(serverKey: string): Promise<JoinSettings> {
  const { settings } = await connection(serverKey).request('join.settings.get', {})
  putSettings(serverKey, settings)
  return settings
}

export async function updateJoinSettings(serverKey: string, patch: { invitesPaused?: boolean; newcomerHours?: number; newcomerSlowmode?: number }): Promise<JoinSettings> {
  const { settings } = await connection(serverKey).request('join.settings.update', patch)
  putSettings(serverKey, settings)
  return settings
}
