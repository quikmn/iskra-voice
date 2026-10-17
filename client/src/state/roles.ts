// Custom roles per server, and the actions that manage them (roles, members' roles, channel overrides, voice moderation),
// plus the pick groups of self-assignable roles and the "Pick your roles" screen.
import { create } from 'zustand'
import type { ChannelPermission, Events, Permission, RoleGroup, ServerRole } from '../core/protocol'
import { connectionFor, onServerEvent, onWelcomeHook, useApp } from './store'
import { senderRules } from './senderRules'
import { setBaseRoles } from './baseRoles'
import { canPingGroups, mentionsMyRole } from './permissions'
import { askableGroups, shouldOpenPickerAfterJoin } from './rolePickerLogic'
import { mentions } from '../ui/markdown'
import { t } from '../i18n'
import { useSyncExternalStore } from 'react'
import { getNameSurfaces, onNameSurfaces, readableColor } from '../theme/theme'

export const useRoles = create<Record<string, ServerRole[]>>(() => ({}))

const NONE: ServerRole[] = []
/** A server's roles, highest first. */
export const useServerRoles = (serverKey: string | undefined) => useRoles((s) => (serverKey ? s[serverKey] ?? NONE : NONE))
export const rolesFor = (serverKey: string) => useRoles.getState()[serverKey] ?? NONE

const sorted = (roles: ServerRole[]) => [...roles].sort((a, b) => b.position - a.position)

// ── Pick groups and the picker ──────────────────────────────────────────────

interface GroupsState {
  /** serverKey → the server's pick groups, in order. */
  groups: Record<string, RoleGroup[]>
  /** The "Pick your roles" screen, when open on its own. */
  picker: string | null
}

export const useRoleGroups = create<GroupsState>(() => ({ groups: {}, picker: null }))

const NO_GROUPS: RoleGroup[] = []
/** A server's pick groups (askableGroups filters out the ones with nothing left to pick). */
export const useServerRoleGroups = (serverKey: string | undefined) =>
  useRoleGroups((s) => (serverKey ? s.groups[serverKey] ?? NO_GROUPS : NO_GROUPS))
export const roleGroupsFor = (serverKey: string) => useRoleGroups.getState().groups[serverKey] ?? NO_GROUPS
export { askableGroups }

export const openRolePicker = (serverKey: string) => useRoleGroups.setState({ picker: serverKey })
export const closeRolePicker = () => useRoleGroups.setState({ picker: null })

function put(serverKey: string, roles: ServerRole[], groups: RoleGroup[] | undefined) {
  useRoles.setState({ [serverKey]: sorted(roles) })
  useRoleGroups.setState((s) => ({ groups: { ...s.groups, [serverKey]: groups ?? [] } }))
}

function connection(serverKey: string) {
  const c = connectionFor(serverKey)
  if (!c) throw new Error(t('errors.codes.disconnected'))
  return c
}

export async function createRole(serverKey: string, role: { name: string; color?: string; icon?: string; hoist?: boolean; permissions?: Permission[]; selfAssign?: boolean }) {
  return (await connection(serverKey).request('role.create', role)).role
}

export async function updateRole(serverKey: string, id: number, patch: { name?: string; color?: string; icon?: string; hoist?: boolean; mentionable?: boolean; permissions?: Permission[]; selfAssign?: boolean }) {
  return (await connection(serverKey).request('role.update', { id, ...patch })).role
}

export async function createRoleGroup(serverKey: string, group: { title: string; question?: string; multi?: boolean; roles: number[] }) {
  return (await connection(serverKey).request('role.group.create', group)).group
}

export async function updateRoleGroup(serverKey: string, id: number, patch: { title?: string; question?: string; multi?: boolean; roles?: number[] }) {
  return (await connection(serverKey).request('role.group.update', { id, ...patch })).group
}

export async function deleteRoleGroup(serverKey: string, id: number) {
  await connection(serverKey).request('role.group.delete', { id })
}

/** Gives yourself or drops a self-assignable role. Your roles update when the server's `member.updated` arrives. */
export async function pickRole(serverKey: string, roleId: number, on: boolean) {
  await connection(serverKey).request('roles.self', on ? { add: [roleId] } : { remove: [roleId] })
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

onWelcomeHook((serverKey, welcome, firstJoin) => {
  connectionFor(serverKey)?.request('role.list', {})
    .then(({ roles, baseRoles, groups }) => {
      put(serverKey, roles, groups)
      setBaseRoles(serverKey, baseRoles)
      // Just joined, and the server asks something: the picker opens once (with required rules, the rules screen shows it after agreeing).
      if (shouldOpenPickerAfterJoin(firstJoin, groups ?? [], roles, !!welcome.rules?.mustAgree)) openRolePicker(serverKey)
    })
    .catch(() => undefined) // an older server: no custom roles
})

onServerEvent((serverKey, type, body) => {
  if (type === 'roles') {
    const { roles, baseRoles, groups } = body as Events['roles']
    put(serverKey, roles, groups)
    setBaseRoles(serverKey, baseRoles)
  }
  if (type === 'voice.moved' && !(body as Events['voice.moved']).reason) {
    // A moderator moved us: follow into the new channel if we're in voice on that server (AFK and team moves are
    // followed by afk.ts and teams.ts, at once).
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
  const surfaces = useSyncExternalStore(onNameSurfaces, getNameSurfaces, getNameSurfaces)
  return (id: number) => {
    const role = roles.find((r) => r.id === id)
    return role ? { name: role.name, color: role.color && readableColor(role.color, surfaces), mine: !!me?.roles?.includes(id) } : null
  }
}

/** For components outside a server context. */
export const activeRoles = () => {
  const key = useApp.getState().activeServer
  return key ? rolesFor(key) : NONE
}
