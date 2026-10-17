import { describe, expect, it } from 'vitest'
import type { RoleGroup, ServerRole } from '../core/protocol'
import { askableGroups, shouldOpenPickerAfterJoin } from './rolePickerLogic'

const role = (id: number, selfAssign: boolean): ServerRole => ({ id, name: `r${id}`, color: null, icon: null, hoist: false, position: id, permissions: [], selfAssign })
const group = (id: number, roles: number[]): RoleGroup => ({ id, title: `g${id}`, question: '', multi: false, roles })
const roles = [role(1, true), role(2, false), role(3, true)]

describe('role picker', () => {
  it('asks only with groups that still offer a pickable role', () => {
    expect(askableGroups([group(1, [1]), group(2, [2]), group(3, [9]), group(4, [])], roles).map((g) => g.id)).toEqual([1])
  })

  it('opens by itself right after a join, when the server asks something and no rules screen comes first', () => {
    const asks = [group(1, [1, 3])]
    expect(shouldOpenPickerAfterJoin(true, asks, roles, false)).toBe(true)
    expect(shouldOpenPickerAfterJoin(true, asks, roles, true)).toBe(false) // the rules screen shows it after agreeing
    expect(shouldOpenPickerAfterJoin(false, asks, roles, false)).toBe(false) // a reconnect
    expect(shouldOpenPickerAfterJoin(true, [group(1, [2])], roles, false)).toBe(false) // nothing left to pick
    expect(shouldOpenPickerAfterJoin(true, [], roles, false)).toBe(false)
  })
})
