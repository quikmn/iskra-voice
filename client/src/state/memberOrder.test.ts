import { describe, expect, it } from 'vitest'
import type { Member, Role, ServerRole } from '../core/protocol'
import { memberGroups, type MemberGroup } from './memberOrder'

const role = (id: number, position: number, hoist: boolean): ServerRole =>
  ({ id, name: `r${id}`, color: null, icon: null, hoist, position, permissions: [] })
const member = (name: string, level: Role, roles: number[] = [], online = true): Member =>
  ({ accountKey: `k-${name}`, name, role: level, online, roles })

/** "r3: Ann, Bo | owner: Cy | offline: Di" */
const shape = (groups: MemberGroup[]) =>
  groups.map((g) => `${g.kind === 'role' ? g.role.name : g.kind === 'level' ? g.level : 'offline'}: ${g.members.map((m) => m.name).join(', ')}`).join(' | ')

// Given out of order on purpose: the list sorts by position, highest first.
const roles = [role(1, 1, true), role(3, 3, true), role(2, 2, false)]

describe('member list order', () => {
  it('puts hoisted roles first in role order, then the levels', () => {
    const groups = memberGroups([
      member('Mia', 'member'), member('Otto', 'owner'), member('Ada', 'admin'), member('Tess', 'trusted'), member('Gus', 'guest'),
      member('Low', 'member', [1]), member('High', 'member', [3]),
    ], roles)
    expect(shape(groups)).toBe('r3: High | r1: Low | owner: Otto | admin: Ada | trusted: Tess | member: Mia | guest: Gus')
  })

  it('shows someone under their highest hoisted role only', () => {
    expect(shape(memberGroups([member('Both', 'member', [1, 3]), member('One', 'member', [1])], roles))).toBe('r3: Both | r1: One')
  })

  it('ignores roles that are not shown separately, and roles that are gone', () => {
    expect(shape(memberGroups([member('Plain', 'member', [2]), member('Stale', 'admin', [99])], roles))).toBe('admin: Stale | member: Plain')
    // A higher role that isn't hoisted doesn't hide a lower one that is.
    expect(shape(memberGroups([member('Mix', 'member', [2, 1])], roles))).toBe('r1: Mix')
  })

  it('shows the owner and admins under their hoisted role when they have one', () => {
    const groups = memberGroups([member('Otto', 'owner', [1]), member('Ada', 'admin', [3]), member('Bea', 'admin')], roles)
    expect(shape(groups)).toBe('r3: Ada | r1: Otto | admin: Bea')
    expect(groups.some((g) => g.kind === 'level' && g.level === 'owner')).toBe(false)
  })

  it('puts offline people last in one group, whatever their roles', () => {
    const groups = memberGroups([
      member('Zed', 'member', [3], false), member('Amy', 'member', [], false), member('Otto', 'owner', [], false), member('On', 'member'),
    ], roles)
    expect(shape(groups)).toBe('member: On | offline: Otto, Amy, Zed')
  })

  it('sorts by name inside a group and leaves empty groups out', () => {
    expect(shape(memberGroups([member('bo', 'member'), member('Åsa', 'member'), member('Al', 'member'), member('cy', 'member', [3])], roles)))
      .toBe('r3: cy | member: Al, Åsa, bo')
    expect(memberGroups([], roles)).toEqual([])
  })

  it('keeps people with the same name in a steady order, and does not change its input', () => {
    const list = [member('Sam', 'member'), { ...member('Sam', 'member'), accountKey: 'a-first' }]
    const before = list.map((m) => m.accountKey)
    expect(memberGroups(list, roles)[0].members.map((m) => m.accountKey)).toEqual(['a-first', 'k-Sam'])
    expect(memberGroups([...list].reverse(), roles)[0].members.map((m) => m.accountKey)).toEqual(['a-first', 'k-Sam'])
    expect(list.map((m) => m.accountKey)).toEqual(before)
  })

  it('breaks a tie in role position by id', () => {
    const tied = [role(8, 5, true), role(7, 5, true)]
    expect(shape(memberGroups([member('A', 'member', [8]), member('B', 'member', [7])], tied))).toBe('r7: B | r8: A')
  })
})
