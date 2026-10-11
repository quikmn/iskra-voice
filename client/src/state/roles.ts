// Custom roles per server, and the actions that manage them (roles, members' roles, channel overrides, voice moderation).
import { create } from 'zustand'
import type { ChannelPermission, Events, Permission, ServerRole } from '../core/protocol'
import { connectionFor, onServerEvent, onWelcomeHook, useApp } from './store'
import { senderRules } from './senderRules'
import { canPingGroups, mentionsMyRole } from './permissions'
import { mentions } from '../ui/markdown'
import { t } from '../i18n'

export const useRoles = create<Record<string, ServerRole[]>>(() => ({}))

const NONE: ServerRole[] = []
/** A server's roles, highest first. */
export const useServerRoles = (serverKey: string | undefined) => useRoles((s) => (serverKey ? s[serverKey] ?? NONE : NONE))
export const rolesFor = (serverKey: string) => useRoles.getState()[serverKey] ?? NONE

const sorted = (roles: ServerRole[]) => [...roles].sort((a, b) => b.position - a.position)

function connection(serverKey: string) {
  const c = connectionFor(serverKey)
  if (!c) throw new Error(t('errors.codes.disconnected'))
  return c
}

export async function createRole(serverKey: string, role: { name: string; color?: string; icon?: string; hoist?: boolean; permissions?: Permission[] }) {
  return (await connection(serverKey).request('role.create', role)).role
}

export async function updateRole(serverKey: string, id: number, patch: { name?: string; color?: string; icon?: string; hoist?: boolean; mentionable?: boolean; permissions?: Permission[] }) {
  return (await connection(serverKey).request('role.update', { id, ...patch })).role
}

export async function deleteRole(serverKey: string, id: number) {
  await connection(serverKey).request('role.delete', { id })
}

/** `ids`: every role, highest first. Shows the new order at once; the server's `roles` event confirms it. */
export async function reorderRoles(serverKey: string, ids: number[]) {
  const before = rolesFor(serverKey)
  useRoles.setState({ [serverKey]: ids.map((id, i) => ({ ...before.find((r) => r.id === id)!, position: ids.length - i })) })
  try {
    await connection(serverKey).request('role.reorder', { ids })
  } catch (e) {
    useRoles.setState({ [serverKey]: before })
    throw e
  }
}

export async function setMemberRoles(serverKey: string, accountKey: string, roles: number[]) {
  await connection(serverKey).request('member.roles.set', { accountKey, roles })
}

export async function setOverride(serverKey: string, channelId: number, roleId: number, allow: ChannelPermission[], deny: ChannelPermission[]) {
  await connection(serverKey).request('channel.overrides.set', { id: channelId, roleId, allow, deny })
}

export async function serverMute(serverKey: string, accountKey: string, muted: boolean) {
  await connection(serverKey).request('voice.mute', { accountKey, muted })
}

export async function moveToChannel(serverKey: string, accountKey: string, channelId: number) {
  await connection(serverKey).request('voice.move', { accountKey, channelId })
}

onWelcomeHook((serverKey) => {
  connectionFor(serverKey)?.request('role.list', {})
    .then(({ roles }) => useRoles.setState({ [serverKey]: sorted(roles) }))
    .catch(() => undefined) // an older server: no custom roles
})

onServerEvent((serverKey, type, body) => {
  if (type === 'roles') useRoles.setState({ [serverKey]: sorted((body as Events['roles']).roles) })
  if (type === 'voice.moved') {
    // A moderator moved us: follow into the new channel if we're in voice on that server.
    const { channelId } = body as Events['voice.moved']
    void import('./voice').then(({ joinVoice, useVoice }) => {
      const session = useVoice.getState().session
      if (session?.serverKey === serverKey && !session.call) void joinVoice(serverKey, channelId)
    })
  }
})

senderRules.canPingGroups = (server, message) =>
  canPingGroups(server.members[message.author], rolesFor(server.key), !!message.webhook)
senderRules.mentionsMe = (server, message) =>
  !!server.me && (mentions(message.text, server.me.accountKey, senderRules.canPingGroups(server, message), senderRules.hereCounts())
    || mentionsMyRole(message.text, server.me, server.members[message.author], rolesFor(server.key), !!message.webhook))

/** For rendering: a role mention's name, colour, and whether I have it. */
export function useRoleLookup(serverKey: string, me: { roles?: number[] } | null | undefined) {
  const roles = useServerRoles(serverKey)
  return (id: number) => {
    const role = roles.find((r) => r.id === id)
    return role ? { name: role.name, color: role.color, mine: !!me?.roles?.includes(id) } : null
  }
}

/** For components outside a server context. */
export const activeRoles = () => {
  const key = useApp.getState().activeServer
  return key ? rolesFor(key) : NONE
}
