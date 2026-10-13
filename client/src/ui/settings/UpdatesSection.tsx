// Settings → Updates (owner): which version runs, whether a newer one is out, and how updates happen.
import { useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import type { ServerUpdateStatus, UpdateMode } from '../../core/protocol'
import { errorMessage } from '../../i18n/errors'
import { formatDate } from '../../i18n/format'
import {
  autoBlockText, changeUpdateSettings, checkForUpdates, installUpdate, normalizeWindow, progressPercent, stateText, updateErrorText, useServerUpdates,
} from '../../state/serverUpdates'
import { connectionFor, type ServerState } from '../../state/store'
import { Spinner } from '../bits'
import './updates.css'

const MODES: UpdateMode[] = ['off', 'notify', 'auto']
const MODE_KEYS = {
  off: { label: 'updates.modes.off', hint: 'updates.modes.offHint' },
  notify: { label: 'updates.modes.notify', hint: 'updates.modes.notifyHint' },
  auto: { label: 'updates.modes.auto', hint: 'updates.modes.autoHint' },
} as const satisfies Record<UpdateMode, { label: string; hint: string }>

type SettingsPatch = Parameters<typeof changeUpdateSettings>[1]

export function UpdatesSection({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const status = useServerUpdates((s) => s.status[server.key])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'check' | 'install' | null>(null)

  useEffect(() => {
    connectionFor(server.key)
      ?.request('update.status', {})
      .then(({ status }) => useServerUpdates.setState((s) => ({ status: { ...s.status, [server.key]: status } })))
      .catch((e: Error) => setError(errorMessage(e)))
  }, [server.key])

  async function run(kind: 'check' | 'install', action: () => Promise<unknown>) {
    setBusy(kind)
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  async function change(patch: SettingsPatch) {
    setError(null)
    try {
      await changeUpdateSettings(server.key, patch)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <section className="settings-section updates" data-testid="updates-section">
      <h2>{t('updates.title')}</h2>
      {!status ? (
        error ? <p className="error-text">{error}</p> : <Spinner />
      ) : (
        <>
          <VersionCard status={status} busy={busy} onCheck={() => void run('check', () => checkForUpdates(server.key))}
            onInstall={() => void run('install', () => installUpdate(server.key))} />
          {status.managed === 'desktop' ? (
            <p className="muted">{t('updates.desktopManaged')}</p>
          ) : status.canCheck ? (
            <UpdateSettings status={status} onChange={(patch) => void change(patch)} />
          ) : (
            <p className="muted">{autoBlockText(status.auto.reason)}</p>
          )}
          {error && <p className="error-text" role="alert">{error}</p>}
        </>
      )}
    </section>
  )
}

function VersionCard({ status, busy, onCheck, onInstall }: { status: ServerUpdateStatus; busy: 'check' | 'install' | null; onCheck: () => void; onInstall: () => void }) {
  const { t } = useTranslation()
  const running = stateText(status)
  const percent = progressPercent(status)
  const working = !['idle', 'failed', 'checking'].includes(status.state)
  const error = updateErrorText(status)
  return (
    <div className={`update-card ${status.latest ? 'has-update' : ''}`}>
      <div className="update-card-row">
        <div className="update-card-text">
          <span className="muted">{t('updates.runs')}</span>
          <strong className="update-version">{t('updates.version', { version: status.current })}</strong>
        </div>
        {status.canCheck && (
          <button className="button small" onClick={onCheck} disabled={busy !== null || working || status.state === 'checking'}>
            {status.state === 'checking' || busy === 'check' ? t('updates.checking') : t('updates.checkNow')}
          </button>
        )}
      </div>

      {status.latest ? (
        <div className="update-available" role="status">
          <span className="update-dot" aria-hidden />
          <div className="update-card-text">
            <strong>{t('updates.available', { version: status.latest.version })}</strong>
            <a href={status.latest.url} target="_blank" rel="noreferrer">{t('updates.whatsNew')}</a>
          </div>
          {status.auto.possible && status.latest.package && (
            <button className="button primary small" onClick={onInstall} disabled={busy !== null || working}>
              {working ? t('updates.updating') : t('updates.updateNow')}
            </button>
          )}
        </div>
      ) : status.canCheck && status.checkedAt ? (
        <p className="muted update-line">{t('updates.upToDate', { when: formatDate(status.checkedAt, { dateStyle: 'medium', timeStyle: 'short' }) })}</p>
      ) : null}

      {status.latest && !status.auto.possible && status.canCheck && (
        <p className="muted update-line"><Trans i18nKey="updates.manualHint" components={{ code: <code /> }} /></p>
      )}
      {status.latest && !status.latest.package && status.auto.possible && <p className="muted update-line">{t('updates.noPackage')}</p>}

      {running && (
        <div className="update-progress" role="status" aria-live="polite">
          <span>{running}</span>
          {status.state === 'downloading' && <progress max={100} value={percent ?? undefined} />}
        </div>
      )}
      {status.state === 'failed' && error && <p className="error-text update-line">{t('updates.failed', { error })}</p>}
      {status.state !== 'failed' && error && <p className="muted update-line">{error}</p>}
      {status.lastUpdate && (
        <p className={`update-line ${status.lastUpdate.ok ? 'muted' : 'error-text'}`}>
          {status.lastUpdate.ok
            ? t('updates.updated', { from: status.lastUpdate.from, to: status.lastUpdate.to })
            : t('updates.rolledBack', { from: status.lastUpdate.from, to: status.lastUpdate.to })}
        </p>
      )}
    </div>
  )
}

function UpdateSettings({ status, onChange }: { status: ServerUpdateStatus; onChange: (patch: SettingsPatch) => void }) {
  const { t } = useTranslation()
  const [windowText, setWindowText] = useState(status.window)
  const [windowError, setWindowError] = useState(false)
  useEffect(() => setWindowText(status.window), [status.window])
  const mode = MODE_KEYS[status.mode] ?? MODE_KEYS.notify

  function saveWindow() {
    const normalized = normalizeWindow(windowText)
    setWindowError(!normalized)
    if (normalized && normalized !== status.window) onChange({ window: normalized })
  }

  return (
    <div className="update-settings">
      <h3 className="h4">{t('updates.whenTitle')}</h3>
      <div className="segmented" role="radiogroup" aria-label={t('updates.whenTitle')}>
        {MODES.map((m) => (
          <button key={m} role="radio" aria-checked={status.mode === m} className={status.mode === m ? 'on' : ''}
            disabled={m === 'auto' && !status.auto.possible && status.mode !== 'auto'}
            onClick={() => status.mode !== m && onChange({ mode: m })}>
            {t(MODE_KEYS[m].label)}
          </button>
        ))}
      </div>
      <p className="muted">{t(mode.hint)}</p>
      {!status.auto.possible && <p className="muted update-why">{autoBlockText(status.auto.reason)}</p>}

      {status.mode === 'auto' && (
        <label className="field inline update-window">
          <span>{t('updates.installBetween')}</span>
          <input type="time" value={windowText} aria-label={t('updates.installBetween')} aria-invalid={windowError}
            onChange={(e) => setWindowText(e.target.value)} onBlur={saveWindow} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
          <span className="muted">{t('updates.installBetweenHint')}</span>
        </label>
      )}
      {windowError && <p className="error-text">{t('updates.windowInvalid')}</p>}

      {status.mode !== 'off' && (
        <>
          <label className="checkbox">
            <input type="checkbox" checked={status.channel === 'prerelease'} onChange={(e) => onChange({ channel: e.target.checked ? 'prerelease' : 'stable' })} />
            {t('updates.prereleases')}
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={status.requireAttestation} onChange={(e) => onChange({ requireAttestation: e.target.checked })} />
            {t('updates.requireAttestation')}
          </label>
          {!status.requireAttestation && <p className="warning-text update-attestation-off" role="note">{t('updates.attestationOff')}</p>}
        </>
      )}
      <p className="muted update-note">{t('updates.verifyNote')}</p>
    </div>
  )
}
