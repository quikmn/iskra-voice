import { describe, expect, it } from 'vitest'
import type { Channel, Member, Role, ServerRole } from '../core/protocol'
import { canDeleteMessage, canPingGroups, canSendIn, channelAccess, has, hoistedRole, isAbove, nameColor, outranks } from './permissions'

const role = (id: number, position: number, extra: Partial<ServerRole> = {}): ServerRole =>
  ({ id, name: `r${id}`, color: null, icon: null, hoist: false, position, permissions: [], ...extra })
const roles = [
  role(3, 3, { permissions: ['kickMembers', 'manageMessages'], color: '#ff0000', hoist: true }),
  role(2, 2, { color: '#00ff00', icon: '⭐' }),
  role(1, 1),
]
const member = (level: Role, ids: number[] = [], key = `k${level}${ids.join('')}`): Member =>
  ({ accountKey: key, name: key, role: level, online: true, roles: ids })
const channel = (extra: Partial<Channel> = {}): Channel =>
  ({ id: 1, name: 'c', kind: 'text', position: 0, readRole: 'member', writeRole: 'member', ...extra })

describe('permissions', () => {
  it('follows the hierarchy: owner, admins, custom roles, then levels', () => {
    expect(outranks(member('owner'), member('admin'), roles)).toBe(true)
    expect(outranks(member('admin'), member('member', [3]), roles)).toBe(true)
    expect(outranks(member('member', [3]), member('member', [2, 1]), roles)).toBe(true)
    expect(outranks(member('guest', [1]), member('trusted'), roles)).toBe(true)
    expect(outranks(member('member', [3]), member('trusted', [3]), roles)).toBe(false)
    expect(isAbove(member('member', [2]), 1, roles)).toBe(true)
    expect(isAbove(member('member', [2]), 2, roles)).toBe(false)
  })

  it('grants permissions from roles, and everything to admins', () => {
    expect(has(member('member', [3]), roles, 'kickMembers')).toBe(true)
    expect(has(member('member', [2]), roles, 'kickMembers')).toBe(false)
    expect(has(member('admin'), roles, 'banMembers')).toBe(true)
    const mod = member('member', [3])
    const message = { id: 1, channelId: 1, author: 'x', text: '', createdAt: 0, editedAt: null, attachments: [], reactions: [], replyTo: null }
    expect(canDeleteMessage(mod, message, member('member', [], 'x'), roles)).toBe(true)
    expect(canDeleteMessage(mod, message, member('admin', [], 'x'), roles)).toBe(false)
  })

  it('applies channel overrides: denies, then allows', () => {
    const c = channel({ overrides: [{ roleId: 1, allow: [], deny: ['send'] }, { roleId: 2, allow: ['send'], deny: [] }] })
    expect(canSendIn(member('member', [1]), c, roles)).toBe(false)
    expect(canSendIn(member('member', [1, 2]), c, roles)).toBe(true)
    const hidden = channel({ readRole: 'admin', writeRole: 'admin', overrides: [{ roleId: 3, allow: ['view'], deny: [] }] })
    expect([...channelAccess(member('member', [3]), hidden, roles)].sort()).toEqual(['view'])
    expect(channelAccess(member('member'), hidden, roles).size).toBe(0)
    const voice = channel({ kind: 'voice', overrides: [{ roleId: 1, allow: [], deny: ['connect'] }] })
    expect(channelAccess(member('member', [1]), voice, roles).has('speak')).toBe(false)
  })

  it('colours names and groups people by their highest roles', () => {
    expect(nameColor(member('member', [1, 2, 3]), roles)).toBe('#ff0000')
    expect(nameColor(member('member', [1, 2]), roles)).toBe('#00ff00')
    expect(nameColor(member('member', [1]), roles)).toBeNull()
    expect(hoistedRole(member('member', [3]), roles)?.id).toBe(3)
    expect(canPingGroups(member('member'), [role(9, 1, { permissions: ['mentionEveryone'] })], false)).toBe(false)
    expect(canPingGroups(member('member', [9]), [role(9, 1, { permissions: ['mentionEveryone'] })], false)).toBe(true)
  })
})
