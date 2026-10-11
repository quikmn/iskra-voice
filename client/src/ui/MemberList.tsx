import type { MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ROLES, roleRank, type Member, type Role } from '../core/protocol'
import type { ServerState } from '../state/store'
import { Avatar } from './bits'
import { BotBadge } from './chat/BotBits'
import { ActivityLine } from './ActivityLine'
import { openProfileCard } from '../state/profile'
import { useMemberPresence } from '../state/presence'
import { STATUS_LABELS } from '../state/presenceRules'
import { CustomStatusLine } from './presence/Presence'
import { TimeoutBadge } from './moderation/Moderation'
import { useServerRoles } from '../state/roles'
import { hoistedRole, nameColor, rolesOf } from '../state/permissions'
import { userMenuProps } from './people/userMenuProps'

export function MemberList({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const roleTitle = (role: Role) => t(`app.members.roleTitles.${role}`)
  const roles = useServerRoles(server.key)
  const members = Object.values(server.members).sort((a, b) => a.name.localeCompare(b.name))
  const online = members.filter((m) => m.online)
  const offline = members.filter((m) => !m.online)
  // Online people with a hoisted role are grouped under their highest one; the rest by level.
  const hoisted = new Map(online.map((m) => [m.accountKey, hoistedRole(m, roles)]))
  const row = (m: Member) => (
    <MemberRow key={m.accountKey} serverKey={server.key} member={m} color={nameColor(m, roles)} icon={rolesOf(m, roles).find((r) => r.icon)?.icon ?? null}
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
              {roleTitle(role)} — {group.length}
            </h3>
            {group.map(row)}
          </section>
        )
      })}
      {offline.length > 0 && (
        <section className="offline">
          <h3>{t('presence.status.offline')} — {offline.length}</h3>
          {offline.sort((a, b) => roleRank(b.role) - roleRank(a.role)).map(row)}
        </section>
      )}
    </div>
  )
}

function MemberRow({ serverKey, member, color, icon, onClick }: {
  serverKey: string
  member: Member
  color: string | null
  icon: string | null
  onClick: (e: MouseEvent<HTMLElement>) => void
}) {
  useTranslation()
  const { status, custom } = useMemberPresence(member)
  return (
    <button className="member" onClick={onClick} {...userMenuProps(member.accountKey, serverKey)} aria-label={`${member.name}, ${STATUS_LABELS[status]}`}>
      <Avatar name={member.name} accountKey={member.accountKey} size={32} status={status} />
      <span className="member-text">
        <span className="member-name" style={color ? { color } : undefined}>{member.name}</span>
        {member.activity ? <ActivityLine activity={member.activity} withTime={false} />
          : custom ? <CustomStatusLine custom={custom} className="member-status" />
          : member.pronouns && <span className="member-pronouns">{member.pronouns}</span>}
      </span>
      {icon && <span className="member-role-icon" aria-hidden>{icon}</span>}
      <TimeoutBadge member={member} />
      {member.bot && <BotBadge />}
    </button>
  )
}
