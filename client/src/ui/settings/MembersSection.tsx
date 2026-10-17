// Server settings → Members (moderators): everyone on the server with their level and roles, searchable. Picking
// someone opens their member dialog (roles, nickname, timeout, kick, ban), which checks your rights person by person.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { roleRank } from '../../core/protocol'
import { openMemberDetails } from '../../state/profile'
import type { ServerState } from '../../state/store'
import { Avatar } from '../bits'
import { BotBadge } from '../chat/BotBits'
import { TimeoutBadge } from '../moderation/Moderation'
import { RoleChips } from '../roles/RoleSettings'
import { userMenuProps } from '../people/userMenuProps'
import { DepartedList } from '../moderation/ModPack'

export function MembersSection({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const members = Object.values(server.members)
    .filter((m) => !needle || m.name.toLowerCase().includes(needle) || (m.profileName ?? '').toLowerCase().includes(needle))
    .sort((a, b) => roleRank(b.role) - roleRank(a.role) || a.name.localeCompare(b.name))
  return (
    <section className="settings-section">
      <h2>{t('settings.sections.members')}</h2>
      <p className="muted">{t('settings.members.intro', { server: server.name })}</p>
      <label className="field">
        <span>{t('settings.members.search')}</span>
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('settings.members.searchPlaceholder')} />
      </label>
      <ul className="room-members" aria-label={t('settings.sections.members')}>
        {members.map((m) => (
          <li key={m.accountKey}>
            <button className="room-member" onClick={() => openMemberDetails(server.key, m.accountKey)} {...userMenuProps(m.accountKey, server.key)}>
              <Avatar name={m.name} accountKey={m.accountKey} size={32} />
              <span className="room-member-text">
                <span className="room-member-name">{m.name} {m.bot && <BotBadge builtin={!!m.builtin} />} <TimeoutBadge member={m} /></span>
                <span className="muted capitalize">{t(`common.roles.${m.role}`)}</span>
              </span>
              <RoleChips server={server} member={m} />
            </button>
          </li>
        ))}
      </ul>
      {members.length === 0 && <p className="muted">{t('settings.members.none')}</p>}
      <DepartedList server={server} />
    </section>
  )
}
