// The member list's order (owner decision 2026-11-22, like Discord): online people with a role that's shown separately
// sit under their highest such role, in role order, at the top; everyone else online follows by level; offline last.
// One function, so the desktop column and the phone drawer can't drift apart.
import { ROLES, roleRank, type Member, type Role, type ServerRole } from '../core/protocol'
import { hoistedRole } from './permissions'

export type MemberGroup =
  | { kind: 'role'; role: ServerRole; members: Member[] }
  | { kind: 'level'; level: Role; members: Member[] }
  | { kind: 'offline'; members: Member[] }

const byName = (a: Member, b: Member) => a.name.localeCompare(b.name) || (a.accountKey < b.accountKey ? -1 : a.accountKey > b.accountKey ? 1 : 0)

/** The groups in the order they're shown; empty groups are left out. The owner goes under a hoisted role like anyone else. */
export function memberGroups(members: Member[], roles: ServerRole[]): MemberGroup[] {
  const sorted = [...members].sort(byName)
  const online = sorted.filter((m) => m.online)
  const offline = sorted.filter((m) => !m.online)
  const under = new Map(online.map((m) => [m.accountKey, hoistedRole(m, roles)?.id ?? null]))
  const groups: MemberGroup[] = []
  const hoisted = roles.filter((r) => r.hoist).sort((a, b) => b.position - a.position || a.id - b.id)
  for (const role of hoisted) {
    const group = online.filter((m) => under.get(m.accountKey) === role.id)
    if (group.length > 0) groups.push({ kind: 'role', role, members: group })
  }
  for (const level of [...ROLES].reverse()) {
    const group = online.filter((m) => m.role === level && under.get(m.accountKey) === null)
    if (group.length > 0) groups.push({ kind: 'level', level, members: group })
  }
  // Offline: one group, the higher levels first (roles aren't shown apart there).
  if (offline.length > 0) groups.push({ kind: 'offline', members: offline.sort((a, b) => roleRank(b.role) - roleRank(a.role)) })
  return groups
}
