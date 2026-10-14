// Server settings → Voice (admins): the AFK channel, when idle people are moved there, and who can talk in it.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AfkMinutes, AfkSettings, Role } from '../../core/protocol'
import { errorMessage } from '../../i18n/errors'
import { AFK_MINUTES, createAfkChannel, updateAfk, useAfk } from '../../state/afk'
import { useServerRoles } from '../../state/roles'
import type { ServerState } from '../../state/store'
import { Spinner } from '../bits'
import './afk.css'

const BASE_ROLES: Role[] = ['owner', 'admin', 'trusted', 'member', 'guest']

export function AfkSection({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const afk = useAfk((s) => s.settings[server.key])
  const roles = useServerRoles(server.key)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const voiceChannels = server.channels.filter((c) => c.kind === 'voice')

  async function run(change: () => Promise<AfkSettings>) {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      await change()
      setSaved(true)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const save = (patch: Partial<AfkSettings>) => run(() => updateAfk(server.key, patch))
  const toggle = <T,>(list: T[], item: T, on: boolean) => (on ? [...list, item] : list.filter((x) => x !== item))

  return (
    <section className="settings-section afk-settings" data-testid="afk-section">
      <h2>{t('settings.sections.serverVoice')}</h2>
      <p className="muted">{t('afk.settings.intro')}</p>
      {!afk ? (
        error ? <p className="error-text">{error}</p> : <Spinner />
      ) : (
        <>
          <div className="afk-channel-row">
            <label className="field">
              <span>{t('afk.settings.channel')}</span>
              <select value={afk.channelId ?? ''} disabled={busy} onChange={(e) => void save({ channelId: e.target.value ? Number(e.target.value) : null })}>
                <option value="">{t('afk.settings.none')}</option>
                {voiceChannels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            {afk.channelId === null && (
              <button className="button" disabled={busy} onClick={() => void run(() => createAfkChannel(server.key, t('afk.settings.defaultName')))}>
                {t('afk.settings.create')}
              </button>
            )}
          </div>
          <label className="field">
            <span>{t('afk.settings.idle')}</span>
            <select value={afk.idleMinutes} disabled={busy} onChange={(e) => void save({ idleMinutes: Number(e.target.value) as AfkMinutes })}>
              {AFK_MINUTES.map((m) => <option key={m} value={m}>{m ? t('afk.settings.minutes', { n: m }) : t('afk.settings.never')}</option>)}
            </select>
            <small className="muted">{t('afk.settings.idleHint')}</small>
          </label>
          <fieldset className="afk-talk">
            <legend>{t('afk.settings.canTalk')}</legend>
            <small className="muted">{t('afk.settings.canTalkHint')}</small>
            <div className="afk-talk-group" role="group" aria-label={t('afk.settings.baseRoles')}>
              {BASE_ROLES.map((role) => (
                <label key={role} className="checkbox">
                  <input type="checkbox" disabled={busy} checked={afk.talkLevels.includes(role)}
                    onChange={(e) => void save({ talkLevels: toggle(afk.talkLevels, role, e.target.checked) })} />
                  <span>{t(`app.members.roleTitles.${role}`)}</span>
                </label>
              ))}
            </div>
            {roles.length > 0 && (
              <div className="afk-talk-group" role="group" aria-label={t('afk.settings.customRoles')}>
                {roles.map((role) => (
                  <label key={role.id} className="checkbox">
                    <input type="checkbox" disabled={busy} checked={afk.talkRoles.includes(role.id)}
                      onChange={(e) => void save({ talkRoles: toggle(afk.talkRoles, role.id, e.target.checked) })} />
                    <span style={role.color ? { color: role.color } : undefined}>{role.icon ? `${role.icon} ` : ''}{role.name}</span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>
        </>
      )}
      {saved && <p className="muted" role="status">{t('afk.settings.saved')}</p>}
      {afk && error && <p className="error-text">{error}</p>}
    </section>
  )
}
