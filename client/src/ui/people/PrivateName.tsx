// Private names: the field in a person's menu, the "Real name" line under a private name, and the list in
// My settings → Privacy & data. Only this account ever sees them (state/privateNames.ts).
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { publicNameOfAccount, useDms } from '../../state/dms'
import { setPrivateName, usePrivateName, usePrivateNames } from '../../state/privateNames'
import { MAX_PRIVATE_NAMES, PRIVATE_NAME_MAX } from '../../state/privateNamesLogic'
import { useApp } from '../../state/store'
import { Avatar } from '../bits'

/** The name everyone sees for this person: on the server it was opened on (nickname included), else their own. */
function usePublicName(accountKey: string, serverKey?: string | null): string {
  const member = useApp((s) => (serverKey ? s.servers[serverKey]?.members[accountKey] : undefined))
  useApp((s) => s.servers) // a person known only from another server
  useDms((s) => s.friends)
  return member ? (member.publicName ?? member.name) : publicNameOfAccount(accountKey)
}

/** Give someone a private name, change it, or go back to their name. */
export function PrivateNameField({ accountKey, serverKey, onDone }: { accountKey: string; serverKey?: string | null; onDone?: () => void }) {
  const { t } = useTranslation()
  const current = usePrivateName(accountKey) ?? ''
  const theirs = usePublicName(accountKey, serverKey)
  const [value, setValue] = useState(current)
  const [error, setError] = useState<string | null>(null)
  const trimmed = value.trim()
  const changed = trimmed !== current

  function save(name: string) {
    if (!setPrivateName(accountKey, name)) {
      setError(t('friends.privateName.full', { max: MAX_PRIVATE_NAMES }))
      return
    }
    setError(null)
    onDone?.()
  }

  return (
    <div className="org-nick" data-testid="private-name-field">
      <div className="org-nick-row">
        <label className="field">
          <span>{t('friends.privateName.label')}</span>
          <input value={value} maxLength={PRIVATE_NAME_MAX} placeholder={theirs} autoFocus
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && changed && save(trimmed)} />
        </label>
        <button className="button primary" disabled={!changed} onClick={() => save(trimmed)}>{t('common.save')}</button>
        {current && <button className="button" onClick={() => save('')}>{t('friends.privateName.useTheirs')}</button>}
      </div>
      <p className="muted">{t('friends.privateName.hint', { name: theirs })}</p>
      {error && <p className="error-text">{error}</p>}
    </div>
  )
}

/** "Real name: X" under a name that is your private one; nothing otherwise. */
export function RealNameLine({ accountKey, serverKey, className = 'profile-realname' }: { accountKey: string; serverKey?: string | null; className?: string }) {
  const { t } = useTranslation()
  const mine = usePrivateName(accountKey)
  const theirs = usePublicName(accountKey, serverKey)
  if (!mine || mine === theirs) return null
  return <div className={className} data-testid="real-name">{t('friends.privateName.realName', { name: theirs })}</div>
}

/** My settings → Privacy & data: every private name, with a way to remove each. */
export function PrivateNamesSection() {
  const { t } = useTranslation()
  const names = usePrivateNames((s) => s.settings.names)
  useApp((s) => s.servers)
  useDms((s) => s.friends)
  const entries = Object.entries(names).sort((a, b) => a[1].localeCompare(b[1]))
  return (
    <section className="settings-section" data-testid="private-names-section">
      <h2>{t('friends.privateName.settingsTitle')}</h2>
      <p className="muted">{t('friends.privateName.settingsIntro')}</p>
      {entries.length === 0 ? (
        <p className="empty-note">{t('friends.privateName.settingsEmpty')}</p>
      ) : (
        <ul className="blocked-list">
          {entries.map(([key, name]) => (
            <li key={key}>
              <Avatar name={name} accountKey={key} size={28} />
              <span className="blocked-name">
                <strong>{name}</strong>
                <span className="muted">{t('friends.privateName.realName', { name: publicNameOfAccount(key) })}</span>
              </span>
              <button className="button small" aria-label={t('friends.privateName.remove', { name })} onClick={() => setPrivateName(key, '')}>
                {t('common.remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
