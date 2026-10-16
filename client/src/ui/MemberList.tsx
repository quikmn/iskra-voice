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
import { useServerBaseRoles } from '../state/baseRoles'
import { hoistedRole, nameColor, rolesOf } from '../state/permissions'
import { userMenuProps } from './people/userMenuProps'
import { useReadableColor } from '../theme/useReadable'
import { useApp } from '../state/store'
import { channelHere, setFollowing, useFollowing } from '../state/alerts'
import { MenuItem, MenuTitle, OrgMenu } from './organize/OrgMenu'
import { useState, type MouseEvent as ReactMouseEvent } from 'react'

export function MemberList({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const roleTitle = (role: Role) => t(`app.members.roleTitles.${role}`)
  const roles = useServerRoles(server.key)
  const baseRoles = useServerBaseRoles(server.key)
  const members = Object.values(server.members).sort((a, b) => a.name.localeCompare(b.name))
  const online = members.filter((m) => m.online)
  const offline = members.filter((m) => !m.online)
  // Online people with a hoisted role are grouped under their highest one; the rest by level.
  const hoisted = new Map(online.map((m) => [m.accountKey, hoistedRole(m, roles)]))
  const row = (m: Member) => (
    <MemberRow key={m.accountKey} serverKey={server.key} member={m} color={nameColor(m, roles, baseRoles)} icon={rolesOf(m, roles).find((r) => r.icon)?.icon ?? null}
      onClick={(e) => openProfileCard(server.key, m.accountKey, e.currentTarget)} />
  )

  return (
    <div className="member-list">
      {roles.filter((r) => r.hoist).map((role) => {
        const group = online.filter((m) => hoisted.get(m.accountKey)?.id === role.id)
        if (group.length === 0) return null
        return (
          <section key={`role-${role.id}`}>
            <RoleHeading server={server} role={role} count={group.length} />
            {group.map(row)}
          </section>
        )
      })}
      {[...ROLES].reverse().map((role) => {
        const group = online.filter((m) => m.role === role && !hoisted.get(m.accountKey))
        if (group.length === 0) return null
        return (
          <section key={role}>
            <h2>
              {roleTitle(role)} — {group.length}
            </h2>
            {group.map(row)}
          </section>
        )
      })}
      {offline.length > 0 && (
        <section className="offline">
          <h2>{t('presence.status.offline')} — {offline.length}</h2>
          {offline.sort((a, b) => roleRank(b.role) - roleRank(a.role)).map(row)}
        </section>
      )}
    </div>
  )
}

/** A hoisted role's heading: click (or right-click) it to follow the role, in the channel you're in or everywhere here. */
function RoleHeading({ server, role, count }: { server: ServerState; role: { id: number; name: string }; count: number }) {
  const { t } = useTranslation()
  const [menu, setMenu] = useState<{ x: number; y: number } | null | false>(false)
  const hereId = useApp((s) => s.activeChannel[server.key])
  const here = channelHere(server, hereId)
  const inHere = useFollowing({ server: server.key, role: role.id, channel: here?.id })
  const everywhere = useFollowing({ server: server.key, role: role.id })
  const open = (e: ReactMouseEvent<HTMLElement>) => {
    e.preventDefault()
    setMenu(e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : null)
  }
  const toggle = (channel: number | undefined, on: boolean) => () => {
    setFollowing({ server: server.key, role: role.id, channel }, on)
    setMenu(false)
  }
  return (
    <>
      <h2>
        <button className="member-group-head" onClick={open} onContextMenu={open} aria-haspopup="menu" aria-label={t('alerts.follow.roleMenu', { role: role.name })}>
          {role.name} — {count}
        </button>
      </h2>
      {menu !== false && (
        <OrgMenu anchor={menu} label={t('alerts.follow.roleMenu', { role: role.name })} onClose={() => setMenu(false)}>
          <MenuTitle>{t('alerts.follow.role', { role: role.name })}</MenuTitle>
          <div className="org-list" role="menu">
            {here && (
              <MenuItem onClick={toggle(here.id, !inHere)}>
                {inHere ? t('alerts.follow.unfollowHere', { channel: here.name }) : t('alerts.follow.followHere', { channel: here.name })}
              </MenuItem>
            )}
            <MenuItem onClick={toggle(undefined, !everywhere)}>{everywhere ? t('alerts.follow.unfollowEverywhere') : t('alerts.follow.followEverywhere')}</MenuItem>
          </div>
        </OrgMenu>
      )}
    </>
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
  const shown = useReadableColor(color)
  const { status, custom } = useMemberPresence(member)
  return (
    <button className="member" onClick={onClick} {...userMenuProps(member.accountKey, serverKey)} aria-label={`${member.name}, ${STATUS_LABELS[status]}`}>
      <Avatar name={member.name} accountKey={member.accountKey} size={32} status={status} />
      <span className="member-text">
        <span className="member-name" style={shown ? { color: shown } : undefined}>{member.name}</span>
        {member.activity ? <ActivityLine activity={member.activity} withTime={false} />
          : custom ? <CustomStatusLine custom={custom} className="member-status" />
          : member.pronouns && <span className="member-pronouns">{member.pronouns}</span>}
      </span>
      {icon && <span className="member-role-icon" aria-hidden>{icon}</span>}
      <TimeoutBadge member={member} />
      {member.bot && <BotBadge builtin={!!member.builtin} />}
    </button>
  )
}
