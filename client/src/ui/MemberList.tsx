import type { MouseEvent } from 'react'
import { ROLES, roleRank, type Member, type Role } from '../core/protocol'
import type { ServerState } from '../state/store'
import { Avatar } from './bits'
import { BotBadge } from './chat/BotBits'
import { openProfileCard } from '../state/profile'
import { TimeoutBadge } from './moderation/Moderation'
import { useServerRoles } from '../state/roles'
import { hoistedRole, nameColor, rolesOf } from '../state/permissions'

const ROLE_TITLES: Record<Role, string> = { owner: 'Owner', admin: 'Admins', trusted: 'Trusted', member: 'Members', guest: 'Guests' }

export function MemberList({ server }: { server: ServerState }) {
  const roles = useServerRoles(server.key)
  const members = Object.values(server.members).sort((a, b) => a.name.localeCompare(b.name))
  const online = members.filter((m) => m.online)
  const offline = members.filter((m) => !m.online)
  // Online people with a hoisted role are grouped under their highest one; the rest by level.
  const hoisted = new Map(online.map((m) => [m.accountKey, hoistedRole(m, roles)]))
  const row = (m: Member) => (
    <MemberRow key={m.accountKey} member={m} color={nameColor(m, roles)} icon={rolesOf(m, roles).find((r) => r.icon)?.icon ?? null}
      onClick={(e) => openProfileCard(server.key, m.accountKey, e.currentTarget)} />
  )

  return (
    <div className="member-list">
      {roles.filter((r) => r.hoist).map((role) => {
        const group = online.filter((m) => hoisted.get(m.accountKey)?.id === role.id)
        if (group.length === 0) return null
        return (
          <section key={`role-${role.id}`}>
            <h3>{role.name} — {group.length}</h3>
            {group.map(row)}
          </section>
        )
      })}
      {[...ROLES].reverse().map((role) => {
        const group = online.filter((m) => m.role === role && !hoisted.get(m.accountKey))
        if (group.length === 0) return null
        return (
          <section key={role}>
            <h3>
              {ROLE_TITLES[role]} — {group.length}
            </h3>
            {group.map(row)}
          </section>
        )
      })}
      {offline.length > 0 && (
        <section className="offline">
          <h3>Offline — {offline.length}</h3>
          {offline.sort((a, b) => roleRank(b.role) - roleRank(a.role)).map(row)}
        </section>
      )}
    </div>
  )
}

function MemberRow({ member, color, icon, onClick }: {
  member: Member
  color: string | null
  icon: string | null
  onClick: (e: MouseEvent<HTMLElement>) => void
}) {
  return (
    <button className="member" onClick={onClick}>
      <Avatar name={member.name} accountKey={member.accountKey} size={32} online={member.online} />
      <span className="member-text">
        <span className="member-name" style={color ? { color } : undefined}>{member.name}</span>
        {member.pronouns && <span className="member-pronouns">{member.pronouns}</span>}
      </span>
      {icon && <span className="member-role-icon" aria-hidden>{icon}</span>}
      <TimeoutBadge member={member} />
      {member.bot && <BotBadge />}
    </button>
  )
}
