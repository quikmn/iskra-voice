// Server settings → Activities (admins): who may start them, which are on, the server's own (add a zip, turn off,
// remove), and voice channels without them.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Role, ServerActivity } from '../../core/protocol'
import { uploadFile, type ServerState } from '../../state/store'
import { addActivity, configureActivities, loadCatalog, removeActivity, setActivityEnabled, useActivities } from '../../state/activities'
import { errorMessage } from '../../i18n/errors'
import { formatBytes } from '../../i18n/format'
import { Modal, Spinner } from '../bits'
import { ActivityIcon, BuiltinIcon } from './icons'
import './activities.css'

const START_ROLES = ['guest', 'member', 'trusted', 'admin'] as const

export function ActivitiesSection({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const catalog = useActivities((s) => s.catalogs[server.key])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [removing, setRemoving] = useState<ServerActivity | null>(null)

  useEffect(() => {
    if (!catalog) loadCatalog(server.key).catch((e) => setError(errorMessage(e)))
  }, [server.key, catalog])

  async function run(action: () => Promise<unknown>) {
    setError(null)
    setNotice(null)
    try {
      await action()
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  async function upload(file: File) {
    await run(async () => {
      try {
        const info = await uploadFile(server.key, file, setProgress)
        setProgress(null)
        const activity = await addActivity(server.key, info.id)
        setNotice(t('activities.settings.added', { name: activity.name }))
      } finally {
        setProgress(null)
      }
    })
  }

  const voice = server.channels.filter((c) => c.kind === 'voice')
  return (
    <section className="settings-section">
      <h2>{t('settings.sections.activities')}</h2>
      <p className="muted">{t('activities.settings.intro')}</p>
      {!catalog ? (error ? <p className="error-text" role="alert">{error}</p> : <Spinner />) : (
        <>
          <label className="field">
            <span>{t('activities.settings.whoStarts')}</span>
            <select value={catalog.startRole} onChange={(e) => void run(() => configureActivities(server.key, { startRole: e.target.value as Role }))}>
              {START_ROLES.map((role) => <option key={role} value={role}>{t(`activities.settings.roles.${role}`)}</option>)}
            </select>
          </label>

          <h3>{t('activities.settings.builtIns')}</h3>
          <ul className="activity-settings-list">
            {catalog.builtins.map((b) => {
              const name = t(`activities.builtins.${b.id}.name`)
              return (
                <li key={b.id}>
                  <span className="activity-choice-icon"><BuiltinIcon id={b.id} /></span>
                  <span className="activity-choice-text"><strong>{name}</strong><span className="muted">{t(`activities.builtins.${b.id}.description`)}</span></span>
                  <Switch on={b.enabled} label={t('activities.settings.on', { name })} onChange={(on) => void run(() => setActivityEnabled(server.key, b.id, on))} />
                </li>
              )
            })}
          </ul>

          <h3>{t('activities.settings.serverAdded')}</h3>
          <p className="muted small-print">{t('activities.settings.sandboxNote')}</p>
          {catalog.activities.length === 0 ? <p className="muted">{t('activities.settings.none')}</p> : (
            <ul className="activity-settings-list" data-testid="activity-settings-list">
              {catalog.activities.map((a) => (
                <li key={a.id}>
                  <span className="activity-choice-icon"><ActivityIcon size={24} /></span>
                  <span className="activity-choice-text">
                    <strong>{a.name}</strong>
                    {a.description && <span className="muted">{a.description}</span>}
                    <span className="muted small-text">{a.version
                      ? t('activities.settings.details', { size: formatBytes(a.size), version: a.version })
                      : t('activities.settings.detailsNoVersion', { size: formatBytes(a.size) })}</span>
                  </span>
                  <Switch on={a.enabled} label={t('activities.settings.on', { name: a.name })} onChange={(on) => void run(() => setActivityEnabled(server.key, a.id, on))} />
                  <button className="button small danger" onClick={() => setRemoving(a)}>{t('activities.settings.remove')}</button>
                </li>
              ))}
            </ul>
          )}
          <label className={`button activity-upload ${progress !== null ? 'disabled' : ''}`}>
            {progress !== null ? t('activities.settings.uploading', { percent: Math.round(progress * 100) }) : t('activities.settings.add')}
            <input type="file" accept=".zip,application/zip" hidden disabled={progress !== null} data-testid="activity-upload"
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file) void upload(file)
              }} />
          </label>
          <p className="muted small-print">{t('activities.settings.addHint')}</p>
          {notice && <p className="success-text" role="status">{notice}</p>}
          {error && <p className="error-text" role="alert">{error}</p>}

          <h3>{t('activities.settings.channels')}</h3>
          <p className="muted small-print">{t('activities.settings.channelsHint')}</p>
          {voice.length === 0 ? <p className="muted">{t('activities.settings.noVoice')}</p> : (
            <ul className="activity-channels">
              {voice.map((c) => (
                <li key={c.id}>
                  <label className="checkbox">
                    <input type="checkbox" checked={catalog.off.includes(c.id) || !!c.e2ee} disabled={!!c.e2ee}
                      onChange={(e) => void run(() => configureActivities(server.key, { channelId: c.id, off: e.target.checked }))} />
                    {c.name}{c.e2ee ? ` (${t('activities.settings.encrypted')})` : ''}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {removing && (
        <Modal title={t('activities.settings.remove')} onClose={() => setRemoving(null)}
          footer={<>
            <button className="button" onClick={() => setRemoving(null)}>{t('common.cancel')}</button>
            <button className="button danger" onClick={() => {
              const id = removing.id
              setRemoving(null)
              void run(() => removeActivity(server.key, id))
            }}>{t('activities.settings.remove')}</button>
          </>}>
          <p>{t('activities.settings.removeConfirm', { name: removing.name })}</p>
        </Modal>
      )}
    </section>
  )
}

function Switch({ on, label, onChange }: { on: boolean; label: string; onChange: (on: boolean) => void }) {
  return (
    <button className={`switch ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}>
      <span />
    </button>
  )
}
