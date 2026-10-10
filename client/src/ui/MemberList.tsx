import { useState } from 'react'
import { ROLES, roleRank, type Member, type Role } from '../core/protocol'
import type { ServerState } from '../state/store'
import { Avatar } from './bits'
import { BotBadge } from './chat/BotBits'
import { MemberDialog } from './dialogs/MemberDialog'

const ROLE_TITLES: Record<Role, string> = { owner: 'Owner', admin: 'Admins', trusted: 'Trusted', member: 'Members', guest: 'Guests' }

export function MemberList({ server }: { server: ServerState }) {
  const [selected, setSelected] = useState<Member | null>(null)
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
            {group.map((m) => <MemberRow key={m.accountKey} member={m} onClick={() => setSelected(m)} />)}
          </section>
        )
      })}
      {offline.length > 0 && (
        <section className="offline">
          <h3>Offline — {offline.length}</h3>
          {offline
            .sort((a, b) => roleRank(b.role) - roleRank(a.role))
            .map((m) => <MemberRow key={m.accountKey} member={m} onClick={() => setSelected(m)} />)}
        </section>
      )}
      {selected && <MemberDialog server={server} member={server.members[selected.accountKey] ?? selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

function MemberRow({ member, onClick }: { member: Member; onClick: () => void }) {
  return (
    <button className="member" onClick={onClick}>
      <Avatar name={member.name} accountKey={member.accountKey} size={32} online={member.online} />
      <span className="member-name">{member.name}</span>
      {member.bot && <BotBadge />}
    </button>
  )
}
