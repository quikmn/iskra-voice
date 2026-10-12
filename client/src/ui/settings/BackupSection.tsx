// Settings → Backup & move (owner): an encrypted backup to download, the daily copies on the server, and moving it.
import { useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import { createBackup, downloadFile, formatBytes, MIN_PASSPHRASE, passphraseStrength, useBackups } from '../../state/backups'
import { connectionFor, type ServerState } from '../../state/store'
import type { BackupStatus } from '../../core/protocol'
import { Spinner } from '../bits'
import { MoveServerDialog } from './MoveServerDialog'
import '../dialogs/InternetSettings.css'
import './backup.css'

const STRENGTH = {
  'too-short': 'settings.backup.strength.tooShort',
  weak: 'settings.backup.strength.weak',
  ok: 'settings.backup.strength.ok',
  strong: 'settings.backup.strength.strong',
} as const satisfies Record<ReturnType<typeof passphraseStrength>, string>

/** Passphrase (twice), then "Make backup": builds it on the server and downloads it. */
export function BackupMaker({ server, onMade }: { server: ServerState; onMade?: () => void }) {
  const { t } = useTranslation()
  const [passphrase, setPassphrase] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [made, setMade] = useState<{ url: string; name: string; size: number } | null>(null)
  const progress = useBackups((s) => s.progress[server.key])
  const strength = passphraseStrength(passphrase)
  const mismatch = again.length > 0 && again !== passphrase
  const ready = strength !== 'too-short' && again === passphrase && !busy

  async function make() {
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      const result = await createBackup(server.key, passphrase)
      setMade(result)
      setPassphrase('')
      setAgain('')
      downloadFile(result.url)
      onMade?.()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  if (made) {
    return (
      <div className="backup-done" role="status">
        <span className="backup-check" aria-hidden>✓</span>
        <div>
          <strong>{t('settings.backup.ready', { name: made.name })}</strong>
          <p className="muted">{t('settings.backup.readyHint', { size: formatBytes(made.size) })}</p>
          <div className="copy-row">
            <button className="button" onClick={() => downloadFile(made.url)}>{t('settings.backup.downloadAgain')}</button>
            <button className="button ghost" onClick={() => setMade(null)}>{t('settings.backup.makeAnother')}</button>
          </div>
        </div>
      </div>
    )
  }

  const fraction = progress && progress.total > 0 ? progress.done / progress.total : null
  return (
    <form className="backup-maker" onSubmit={(e) => { e.preventDefault(); void make() }}>
      <label className="field">
        <span>{t('settings.restore.passphrase')}</span>
        <input type="password" autoComplete="new-password" value={passphrase} maxLength={1024} disabled={busy}
          onChange={(e) => setPassphrase(e.target.value)} aria-describedby={`strength-${server.key}`} />
      </label>
      <p id={`strength-${server.key}`} className={`backup-strength ${strength}`}>{passphrase ? t(STRENGTH[strength], { min: MIN_PASSPHRASE }) : t('settings.backup.passphraseHint')}</p>
      <label className="field">
        <span>{t('settings.backup.again')}</span>
        <input type="password" autoComplete="new-password" value={again} maxLength={1024} disabled={busy}
          onChange={(e) => setAgain(e.target.value)} aria-invalid={mismatch} />
      </label>
      {mismatch && <p className="error-text">{t('keys.appLock.mismatch')}</p>}
      {busy && (
        <div className="backup-progress" aria-live="polite">
          <progress value={fraction ?? undefined} max={1} aria-label={t('settings.backup.making')} />
          <span className="muted">
            {fraction === null ? t('settings.backup.preparing') : t('settings.backup.packing', { done: formatBytes(progress!.done), total: formatBytes(progress!.total) })}
          </span>
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
      <button className="button primary" type="submit" disabled={!ready}>
        {busy ? <Spinner /> : t('settings.backup.make')}
      </button>
    </form>
  )
}

function AutoBackups({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    connectionFor(server.key)?.request('backup.status', {}).then(setStatus).catch((e: Error) => setError(errorMessage(e)))
  }, [server.key])

  async function change(patch: { enabled?: boolean; keep?: number; includeUploads?: boolean }) {
    setError(null)
    try {
      const next = await connectionFor(server.key)?.request('backup.settings', patch)
      if (next) setStatus(next)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  if (!status) return error ? <p className="error-text">{error}</p> : <Spinner />
  return (
    <>
      <div className="internet-head">
        <div>
          <strong>{t('settings.backup.daily')}</strong>
          <p className="muted">{t('settings.backup.dailyHint')}</p>
        </div>
        <button className={`switch ${status.auto.enabled ? 'on' : ''}`} role="switch" aria-checked={status.auto.enabled}
          aria-label={t('settings.backup.daily')} onClick={() => void change({ enabled: !status.auto.enabled })}>
          <span />
        </button>
      </div>
      {status.auto.enabled && (
        <div className="backup-options">
          <label className="field inline">
            <span>{t('settings.backup.keep')}</span>
            <select value={status.auto.keep} onChange={(e) => void change({ keep: Number(e.target.value) })}>
              {[...new Set([3, 7, 14, 30, status.auto.keep])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{t('settings.invite.days', { count: n })}</option>)}
            </select>
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={status.auto.includeUploads} onChange={(e) => void change({ includeUploads: e.target.checked })} />
            {t('settings.backup.includeUploads')}
          </label>
        </div>
      )}
      {status.local.length > 0 ? (
        <ul className="backup-list" aria-label={t('settings.backup.dailyTitle')}>
          {status.local.map((b) => (
            <li key={b.name}><code>{b.name}</code><span className="muted">{formatBytes(b.size)}</span></li>
          ))}
        </ul>
      ) : (
        status.auto.enabled && <p className="muted">{t('settings.backup.firstSoon')}</p>
      )}
      <p className="muted backup-folder"><Trans i18nKey="settings.backup.inFolder" values={{ folder: status.folder }} components={{ code: <code /> }} /></p>
      {error && <p className="error-text">{error}</p>}
    </>
  )
}

export function BackupSection({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const [moving, setMoving] = useState(false)
  return (
    <>
      <section className="settings-section backup" data-testid="backup-section">
        <h2>{t('settings.sections.backup')}</h2>
        <p className="muted">{t('settings.backup.intro')}</p>
        <BackupMaker server={server} />
      </section>
      <section className="settings-section backup">
        <h2>{t('settings.backup.dailyTitle')}</h2>
        <AutoBackups server={server} />
      </section>
      <section className="settings-section backup">
        <h2>{t('settings.backup.moveTitle')}</h2>
        <p className="muted">{t('settings.backup.moveHint')}</p>
        <button className="button" onClick={() => setMoving(true)}>{t('settings.backup.moveButton')}</button>
      </section>
      {moving && <MoveServerDialog server={server} onClose={() => setMoving(false)} />}
    </>
  )
}
