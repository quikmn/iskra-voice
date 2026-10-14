// Server settings → Bug inbox (owner): take bug reports from Iskra apps into a channel you pick.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { roleRank, type BugInboxSettings } from '../../core/protocol'
import { errorMessage } from '../../i18n/errors'
import { connectionFor, type ServerState } from '../../state/store'
import { Spinner } from '../bits'

export function BugInboxSection({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const [settings, setSettings] = useState<BugInboxSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const channels = server.channels.filter((c) => c.kind === 'text')
  const chosen = channels.find((c) => c.id === settings?.channelId) ?? null

  useEffect(() => {
    connectionFor(server.key)?.request('buginbox.get', {}).then(setSettings).catch((e: Error) => setError(errorMessage(e)))
  }, [server.key])

  async function change(patch: { enabled: boolean; channelId?: number }) {
    setError(null)
    try {
      const next = await connectionFor(server.key)?.request('buginbox.set', patch)
      if (next) setSettings(next)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const url = `${server.publicUrl ?? server.directUrl}`.replace(/\/+$/, '') + '/bug-reports'
  return (
    <section className="settings-section bug-inbox" data-testid="bug-inbox-section">
      <h2>{t('settings.sections.bugInbox')}</h2>
      <p className="muted">{t('bugReport.inbox.intro')}</p>
      <p className="muted">{t('bugReport.inbox.anonymous')}</p>
      {!settings ? (
        error ? <p className="error-text">{error}</p> : <Spinner />
      ) : (
        <>
          <label className="field">
            <span>{t('bugReport.inbox.channel')}</span>
            <select value={settings.channelId ?? ''} onChange={(e) => e.target.value && void change({ enabled: settings.enabled, channelId: Number(e.target.value) })}>
              {settings.channelId === null && <option value="">{t('bugReport.inbox.pickChannel')}</option>}
              {channels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
            </select>
          </label>
          {chosen && roleRank(chosen.readRole) <= roleRank('member') && (
            <p className="warning-text" role="note">{t('bugReport.inbox.publicWarning', { channel: chosen.name })}</p>
          )}
          <div className="internet-head">
            <div>
              <strong>{t('bugReport.inbox.enabled')}</strong>
              <p className="muted">{t('bugReport.inbox.limits')}</p>
            </div>
            <button className={`switch ${settings.enabled ? 'on' : ''}`} role="switch" aria-checked={settings.enabled}
              aria-label={t('bugReport.inbox.enabled')} disabled={settings.channelId === null}
              onClick={() => void change({ enabled: !settings.enabled })}>
              <span />
            </button>
          </div>
          {settings.enabled && <p className="muted">{t('bugReport.inbox.endpoint', { url })}</p>}
          {error && <p className="error-text" role="alert">{error}</p>}
        </>
      )}
    </section>
  )
}
