import type { MouseEvent } from 'react'
import { ROLES, roleRank, type Member, type Role } from '../core/protocol'
import type { ServerState } from '../state/store'
import { Avatar } from './bits'
import { BotBadge } from './chat/BotBits'
import { openProfileCard } from '../state/profile'
import { useMemberPresence } from '../state/presence'
import { STATUS_LABELS } from '../state/presenceRules'
import { CustomStatusLine } from './presence/Presence'

const ROLE_TITLES: Record<Role, string> = { owner: 'Owner', admin: 'Admins', trusted: 'Trusted', member: 'Members', guest: 'Guests' }

export function MemberList({ server }: { server: ServerState }) {
  const members = Object.values(server.members).sort((a, b) => a.name.localeCompare(b.name))
  const online = members.filter((m) => m.online)
  const offline = members.filter((m) => !m.online)

  return (
    <div className="member-list">
      {[...ROLES].reverse().map((role) => {
        const group = online.filter((m) => m.role === role)
        if (group.length === 0) return null
        return (
          <section key={role}>
            <h3>
              {ROLE_TITLES[role]} — {group.length}
            </h3>
            {group.map((m) => <MemberRow key={m.accountKey} member={m} onClick={(e) => openProfileCard(server.key, m.accountKey, e.currentTarget)} />)}
          </section>
        )
      })}
      {offline.length > 0 && (
        <section className="offline">
          <h3>Offline — {offline.length}</h3>
          {offline
            .sort((a, b) => roleRank(b.role) - roleRank(a.role))
            .map((m) => <MemberRow key={m.accountKey} member={m} onClick={(e) => openProfileCard(server.key, m.accountKey, e.currentTarget)} />)}
        </section>
      )}
    </div>
  )
}

function MemberRow({ member, onClick }: { member: Member; onClick: (e: MouseEvent<HTMLElement>) => void }) {
  const { status, custom } = useMemberPresence(member)
  return (
    <button className="member" onClick={onClick} aria-label={`${member.name}, ${STATUS_LABELS[status]}`}>
      <Avatar name={member.name} accountKey={member.accountKey} size={32} status={status} />
      <span className="member-text">
        <span className="member-name">{member.name}</span>
        {custom ? <CustomStatusLine custom={custom} className="member-status" />
          : member.pronouns && <span className="member-pronouns">{member.pronouns}</span>}
      </span>
      {member.bot && <BotBadge />}
    </button>
  )
}
