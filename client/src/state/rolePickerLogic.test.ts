import { describe, expect, it } from 'vitest'
import type { RoleGroup, ServerRole } from '../core/protocol'
import { askableGroups } from './rolePickerLogic'

const role = (id: number, selfAssign: boolean): ServerRole => ({ id, name: `r${id}`, color: null, icon: null, hoist: false, position: id, permissions: [], selfAssign })
const group = (id: number, roles: number[]): RoleGroup => ({ id, title: `g${id}`, question: '', multi: false, roles })
const roles = [role(1, true), role(2, false), role(3, true)]

describe('role picker', () => {
  it('asks only with groups that still offer a pickable role (older servers: each role is an answer)', () => {
    expect(askableGroups([group(1, [1]), group(2, [2]), group(3, [9]), group(4, [])], roles).map((g) => g.id)).toEqual([1])
  })
})
