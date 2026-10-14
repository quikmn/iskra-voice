import { describe, expect, it } from 'vitest'
import { ROLES, type BaseRoleInfo, type Member, type Role, type ServerRole } from '../core/protocol'
import { adjustablePowers, BASE_ROLES, baseRoleCounts, baseRoleName, baseRolesFor, canAdjustBaseRole, canStyleBaseRole, describeBaseRole, powerChanges, setBaseRoles } from './baseRoles'
import { baseAllows, basePermissions, has, nameColor, PERMISSIONS } from './permissions'
import { en } from '../i18n/en'

const member = (role: Role, roles: number[] = [], key = `k${role}${roles.join('')}`): Member =>
  ({ accountKey: key, name: key, role, online: true, roles })
const custom = (id: number, position: number, extra: Partial<ServerRole> = {}): ServerRole =>
  ({ id, name: `r${id}`, color: null, icon: null, hoist: false, position, permissions: [], ...extra })

// As the server sends it: each role has its own abilities and those below.
const list: BaseRoleInfo[] = [
  { id: 'owner', color: '#c27ce0', abilities: ['invite', 'events', 'pin', 'bots', 'runServer'], permissions: [...PERMISSIONS] },
  { id: 'admin', color: '#e5534b', abilities: ['invite', 'events', 'pin', 'bots'], permissions: [...PERMISSIONS] },
  { id: 'trusted', color: '#5b9bd5', abilities: ['invite', 'events', 'pin'], permissions: [] },
  { id: 'member', color: null, abilities: ['invite', 'events'], permissions: [] },
  { id: 'guest', color: null, abilities: [], permissions: [] },
]

describe('built-in roles', () => {
  it('lists every base role, highest first, with a name in each language', () => {
    expect(BASE_ROLES).toEqual([...ROLES].reverse())
    for (const r of ROLES) expect(baseRoleName(r)).toBe(en.roles.base.names[r])
  })

  it('describes what each role adds over the one below it', () => {
    expect(describeBaseRole(list, 'trusted')).toEqual({ below: 'member', abilities: ['pin'], permissions: [] })
    expect(describeBaseRole(list, 'admin')).toEqual({ below: 'trusted', abilities: ['bots'], permissions: PERMISSIONS })
    expect(describeBaseRole(list, 'owner')).toEqual({ below: 'admin', abilities: ['runServer'], permissions: [] })
    expect(describeBaseRole(list, 'guest')).toEqual({ below: null, abilities: [], permissions: [] })
  })

  it('keeps them in order and falls back for servers that send none', () => {
    setBaseRoles('s1', [...list].reverse())
    expect(baseRolesFor('s1').map((b) => b.id)).toEqual(BASE_ROLES)
    expect(baseRolesFor('unknown').map((b) => b.id)).toEqual(BASE_ROLES)
    expect(baseRolesFor('unknown').every((b) => b.color === null && b.abilities.length === 0)).toBe(true)
  })

  it('colours names by the hierarchy: owner and admin, then custom roles, then the lower base roles', () => {
    const roles = [custom(1, 1, { color: '#00ff00' })]
    expect(nameColor(member('admin', [1]), roles, list)).toBe('#e5534b')
    expect(nameColor(member('trusted', [1]), roles, list)).toBe('#00ff00')
    expect(nameColor(member('trusted'), roles, list)).toBe('#5b9bd5')
    expect(nameColor(member('member'), roles, list)).toBeNull()
    expect(nameColor(member('admin', [1]), roles)).toBe('#00ff00') // no base colours known
  })

  it('lets the owner style any, other role managers only below admin', () => {
    const roles = [custom(1, 1, { permissions: ['manageRoles'] })]
    expect(BASE_ROLES.every((r) => canStyleBaseRole(member('owner'), roles, r))).toBe(true)
    expect(canStyleBaseRole(member('admin'), roles, 'admin')).toBe(false)
    expect(canStyleBaseRole(member('admin'), roles, 'trusted')).toBe(true)
    expect(canStyleBaseRole(member('member', [1]), roles, 'guest')).toBe(true)
    expect(canStyleBaseRole(member('member', [1]), roles, 'owner')).toBe(false)
    expect(canStyleBaseRole(member('trusted'), roles, 'guest')).toBe(false)
  })

  it('counts members per role', () => {
    const counts = baseRoleCounts({ a: member('owner'), b: member('member', [], 'b'), c: member('member', [], 'c') })
    expect(counts).toEqual({ guest: 0, member: 2, trusted: 0, admin: 0, owner: 1 })
  })

  it('follows changed powers: members who can pin, admins who cannot kick, the owner who can always do everything', () => {
    const changed: BaseRoleInfo[] = list.map((b) => ({ ...b, defaults: { abilities: b.abilities, permissions: b.permissions }, adjustable: { abilities: [], permissions: [] } }))
    changed[1] = { ...changed[1], permissions: PERMISSIONS.filter((p) => p !== 'kickMembers'), changed: true }
    changed[3] = { ...changed[3], abilities: ['invite', 'events', 'pin'], changed: true }
    changed[0] = { ...changed[0], abilities: [], permissions: [] } // whatever a server sends, the owner keeps everything
    expect(baseAllows(changed, member('member'), 'pin')).toBe(true)
    expect(baseAllows(list, member('member'), 'pin')).toBe(false) // an older server: the defaults
    expect(baseAllows(undefined, member('trusted'), 'pin')).toBe(true)
    expect(baseAllows(changed, member('owner'), 'runServer')).toBe(true)
    expect(has(member('admin'), [], 'kickMembers', changed)).toBe(false)
    expect(has(member('admin'), [], 'kickMembers')).toBe(true)
    expect(has(member('admin', [1]), [custom(1, 1, { permissions: ['kickMembers'] })], 'kickMembers', changed)).toBe(true)
    expect(basePermissions(changed, member('owner'))).toEqual(PERMISSIONS)
    expect(powerChanges(changed[3])).toEqual({ added: ['pin'], removed: [] })
    expect(powerChanges(changed[1])).toEqual({ added: [], removed: ['kickMembers'] })
  })

  it('only offers to adjust roles below your own, never the owner, and lists what may change', () => {
    expect(canAdjustBaseRole(member('owner'), [], 'admin')).toBe(true)
    expect(canAdjustBaseRole(member('owner'), [], 'owner')).toBe(false)
    expect(canAdjustBaseRole(member('admin'), [], 'admin')).toBe(false)
    expect(canAdjustBaseRole(member('admin'), [], 'trusted')).toBe(true)
    expect(canAdjustBaseRole(member('member', [1]), [custom(1, 1, { permissions: ['manageRoles'] })], 'guest')).toBe(true)
    expect(canAdjustBaseRole(member('member', [1]), [custom(1, 1, { permissions: ['manageRoles'] })], 'member')).toBe(false)
    expect(canAdjustBaseRole(member('trusted'), [], 'guest')).toBe(false)
    const info: BaseRoleInfo = { id: 'member', color: null, abilities: [], permissions: [], adjustable: { abilities: ['pin', 'invite'], permissions: ['mentionEveryone'] } }
    expect(adjustablePowers(info)).toEqual({ abilities: ['invite', 'pin'], permissions: [] }) // in table order; @everyone once
    expect(adjustablePowers(list[3])).toEqual({ abilities: [], permissions: [] })
  })
})
