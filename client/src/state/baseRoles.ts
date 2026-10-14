// The built-in base roles (Owner … Guest) as the role list and the channel "who can" pickers show them: one list, one set
// of names. What they can do comes from the server (`role.list` → `baseRoles`, the table its own checks use).
import { create } from 'zustand'
import { ROLES, roleRank, type BaseAbility, type BaseRoleInfo, type Member, type Permission, type Role, type ServerRole } from '../core/protocol'
import { connectionFor } from './store'
import { has } from './permissions'
import { t } from '../i18n'

/** Highest first, as listed. */
export const BASE_ROLES: Role[] = [...ROLES].reverse()

export const useBaseRoles = create<Record<string, BaseRoleInfo[]>>(() => ({}))

/** An older server sends no `baseRoles`: list them anyway, without colours or powers. */
const FALLBACK: BaseRoleInfo[] = BASE_ROLES.map((id) => ({ id, color: null, abilities: [], permissions: [] }))

export const useServerBaseRoles = (serverKey: string | undefined) =>
  useBaseRoles((s) => (serverKey ? s[serverKey] ?? FALLBACK : FALLBACK))
export const baseRolesFor = (serverKey: string) => useBaseRoles.getState()[serverKey] ?? FALLBACK

export function setBaseRoles(serverKey: string, list: BaseRoleInfo[] | undefined) {
  if (list) useBaseRoles.setState({ [serverKey]: BASE_ROLES.map((id) => list.find((b) => b.id === id) ?? FALLBACK[BASE_ROLES.indexOf(id)]) })
}

/** "" clears the colour. */
export async function updateBaseRole(serverKey: string, role: Role, color: string) {
  const c = connectionFor(serverKey)
  if (!c) throw new Error(t('errors.codes.disconnected'))
  return (await c.request('role.base.update', { role, color })).baseRole
}

/** The role's name, capitalized ("Member"), the same everywhere it's offered. */
export const baseRoleName = (role: Role) => t(`roles.base.names.${role}`)

/** Mirrors the server: role managers style base roles below admin; the owner any. */
export const canStyleBaseRole = (me: Member | null | undefined, roles: ServerRole[], role: Role) =>
  !!me && has(me, roles, 'manageRoles') && (me.role === 'owner' || roleRank(role) < roleRank('admin'))

/** What a base role adds over the one below it, for a plain-language description. */
export function describeBaseRole(list: BaseRoleInfo[], role: Role): { below: Role | null; abilities: BaseAbility[]; permissions: Permission[] } {
  const info = list.find((b) => b.id === role)
  const belowRole = roleRank(role) > 0 ? ROLES[roleRank(role) - 1] : null
  const below = belowRole ? list.find((b) => b.id === belowRole) : undefined
  return {
    below: belowRole,
    abilities: (info?.abilities ?? []).filter((a) => !below?.abilities.includes(a)),
    permissions: (info?.permissions ?? []).filter((p) => !below?.permissions.includes(p)),
  }
}

/** How many members hold each base role. */
export function baseRoleCounts(members: Record<string, Member>): Record<Role, number> {
  const out = Object.fromEntries(ROLES.map((r) => [r, 0])) as Record<Role, number>
  for (const m of Object.values(members)) out[m.role] = (out[m.role] ?? 0) + 1
  return out
}
