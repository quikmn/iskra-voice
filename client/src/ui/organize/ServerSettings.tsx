// "This server" pieces for settings: your notification level and mute here, and nicknames.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import { roleRank, type Member, type NotifyLevel } from '../../core/protocol'
import type { ServerState } from '../../state/store'
import { muteFor, setNickname, setNotifyLevel, useNotifyFor, useOrganize } from '../../state/organize'
import { levelLabel, MUTE_CHOICES, muteChoiceLabel, muteLabel } from '../../state/organizeLogic'
import './organize.css'

/** Level and mute for a whole server. Channels can override the level from their own menu. */
export function ServerNotifySettings({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const notify = useNotifyFor(server.key, null)
  const own = useOrganize((s) => s.notify[server.key]?.server)
  const [error, setError] = useState<string | null>(null)
  const clock = useOrganize((s) => s.clock)
  const muted = muteLabel(own?.mutedUntil ?? null, clock)
  const run = (action: () => Promise<unknown>) => {
    setError(null)
    action().catch((e: unknown) => setError(errorMessage(e)))
  }
  return (
    <div className="org-notify" role="group" aria-label={t('organize.notify.groupLabel', { server: server.name })}>
      <h4>{t('organize.notify.heading', { server: server.name })}</h4>
      <div className="segmented" role="radiogroup" aria-label={t('organize.notify.label')}>
        {(['all', 'mentions', 'none'] as NotifyLevel[]).map((level) => (
          <button key={level} role="radio" aria-checked={notify.chosen === level} className={notify.chosen === level ? 'on' : ''}
            onClick={() => run(() => setNotifyLevel(server.key, null, level))}>
            {levelLabel(level)}
          </button>
        ))}
      </div>
      <div className="org-notify-row">
        {muted ? (
          <>
            <span className="muted">{muted}</span>
            <button className="button" onClick={() => run(() => muteFor(server.key, null, 0))}>{t('organize.notify.unmuteServer')}</button>
          </>
        ) : (
          <label className="field inline">
            <span>{t('organize.notify.muteServer')}</span>
            <select value="" aria-label={t('organize.notify.muteServer')} onChange={(e) => e.target.value && run(() => muteFor(server.key, null, Number(e.target.value)))}>
              <option value="">{t('organize.notify.notMuted')}</option>
              {MUTE_CHOICES.map((c) => <option key={c.minutes} value={c.minutes}>{muteChoiceLabel(c)}</option>)}
            </select>
          </label>
        )}
      </div>
      <p className="muted">{t('organize.notify.hint')}</p>
      {error && <p className="error-text">{error}</p>}
    </div>
  )
}

/** Your nickname on a server, or (admins, for members ranked below them) someone else's. */
export function NicknameField({ server, member: given }: { server: ServerState; member: Member }) {
  const { t } = useTranslation()
  const member = server.members[given.accountKey] ?? given // the latest copy
  const me = server.me
  const isSelf = me?.accountKey === member.accountKey
  const canEdit = !!me && (isSelf || (roleRank(me.role) >= roleRank('admin') && roleRank(me.role) > roleRank(member.role)))
  const [value, setValue] = useState(member.nick ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  if (!canEdit) return null
  const trimmed = value.trim()
  const changed = trimmed !== (member.nick ?? '')

  async function save(nick: string) {
    setError(null)
    setSaved(false)
    try {
      await setNickname(server.key, nick, isSelf ? undefined : member.accountKey)
      setValue(nick)
      setSaved(true)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <div className="org-nick">
      <div className="org-nick-row">
        <label className="field">
          <span>{isSelf ? t('organize.nick.yours') : t('organize.nick.theirs')}</span>
          <input value={value} maxLength={32} placeholder={member.profileName ?? member.name}
            onChange={(e) => { setValue(e.target.value); setSaved(false) }}
            onKeyDown={(e) => e.key === 'Enter' && changed && void save(trimmed)} />
        </label>
        <button className="button primary" disabled={!changed} onClick={() => void save(trimmed)}>{t('common.save')}</button>
        {member.nick && <button className="button" onClick={() => void save('')}>{t('common.reset')}</button>}
      </div>
      <p className="muted">
        {saved ? t('organize.nick.saved') : t(isSelf ? 'organize.nick.hintYours' : 'organize.nick.hintTheirs', { server: server.name })}
      </p>
      {error && <p className="error-text">{error}</p>}
    </div>
  )
}
