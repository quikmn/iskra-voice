// The built-in base roles (Owner … Guest) as the role list and the channel "who can" pickers show them: one list, one set
// of names. What they can do comes from the server (`role.list` → `baseRoles`, the table its own checks use).
import { create } from 'zustand'
import { ROLES, roleRank, type BaseAbility, type BaseRoleInfo, type Member, type Permission, type Role, type ServerRole } from '../core/protocol'
import { connectionFor } from './store'
import { has, PERMISSIONS, BASE_ABILITIES } from './permissions'
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

/** Powers: the whole sets the role should have. */
export async function updateBaseRolePowers(serverKey: string, role: Role, abilities: BaseAbility[], permissions: Permission[]) {
  const c = connectionFor(serverKey)
  if (!c) throw new Error(t('errors.codes.disconnected'))
  return (await c.request('role.base.update', { role, abilities, permissions })).baseRole
}

/** Back to the role's default powers. */
export async function resetBaseRole(serverKey: string, role: Role) {
  const c = connectionFor(serverKey)
  if (!c) throw new Error(t('errors.codes.disconnected'))
  return (await c.request('role.base.update', { role, reset: true })).baseRole
}

/** Mirrors the server: role managers style base roles below admin; the owner any. */
export const canStyleBaseRole = (me: Member | null | undefined, roles: ServerRole[], role: Role, base?: BaseRoleInfo[]) =>
  !!me && has(me, roles, 'manageRoles', base) && (me.role === 'owner' || roleRank(role) < roleRank('admin'))

/** Mirrors the server: never the owner's role; role managers, for roles below their own. */
export const canAdjustBaseRole = (me: Member | null | undefined, roles: ServerRole[], role: Role, base?: BaseRoleInfo[]) =>
  !!me && role !== 'owner' && has(me, roles, 'manageRoles', base) && roleRank(role) < roleRank(me.role)

/** The powers a role may get, in the order they're shown (older servers: none). */
export function adjustablePowers(info: BaseRoleInfo | undefined): { abilities: BaseAbility[]; permissions: Permission[] } {
  const a = info?.adjustable
  return {
    abilities: BASE_ABILITIES.filter((x) => a?.abilities.includes(x)),
    // @everyone is already an ability here: one tick for it, not two.
    permissions: PERMISSIONS.filter((x) => x !== 'mentionEveryone' && a?.permissions.includes(x)),
  }
}

/** What the role can do now and the change from its defaults, for the "changed" summary. */
export function powerChanges(info: BaseRoleInfo | undefined): { added: string[]; removed: string[] } {
  if (!info?.defaults) return { added: [], removed: [] }
  const now = [...info.abilities, ...info.permissions] as string[]
  const was = [...info.defaults.abilities, ...info.defaults.permissions] as string[]
  return { added: now.filter((x) => !was.includes(x)), removed: was.filter((x) => !now.includes(x)) }
}

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
