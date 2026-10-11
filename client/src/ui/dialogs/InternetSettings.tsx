import { useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import { LINKS } from '../../links'
import { hostChecklist, hostSummary, lanHost, loadHostStatus, manualForwards, setInternet, useHosting, type Step } from '../../state/hosting'
import type { ServerState } from '../../state/store'
import { Spinner } from '../bits'
import './InternetSettings.css'

function StepIcon({ state }: { state: Step['state'] }) {
  if (state === 'working') return <span className="step-icon working" aria-hidden><Spinner /></span>
  const glyph = state === 'done' ? '✓' : state === 'problem' ? '!' : ''
  return <span className={`step-icon ${state}`} aria-hidden>{glyph}</span>
}

/** "Open to the internet": one switch for the owner, a live checklist, and what to do when it can't work. */
export function InternetSection({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const status = useHosting((s) => s.status[server.key])
  const isOwner = server.me?.role === 'owner'
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadHostStatus(server.key).catch((e: Error) => setError(errorMessage(e)))
  }, [server.key])

  async function change(enabled: boolean) {
    setBusy(true)
    setError(null)
    try {
      await setInternet(server.key, enabled)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  if (!status) {
    return (
      <section className="settings-section internet">
        <h3>{t('settings.sections.internet')}</h3>
        {error ? <p className="error-text">{error}</p> : <Spinner />}
      </section>
    )
  }

  const summary = hostSummary(status)
  const steps = hostChecklist(status)
  const forwards = status.enabled && !status.cgnat ? manualForwards(status) : []
  const lan = lanHost(status)

  return (
    <section className="settings-section internet" data-testid="internet-section">
      <h3>{t('settings.sections.internet')}</h3>
      <div className="internet-head">
        <div>
          <strong>{t('settings.internet.letFriends')}</strong>
          <p className={`internet-summary ${summary.tone}`}>{summary.text}</p>
        </div>
        <button
          className={`switch ${status.enabled ? 'on' : ''}`}
          role="switch"
          aria-checked={status.enabled}
          aria-label={t('settings.sections.internet')}
          disabled={!isOwner || busy}
          onClick={() => void change(!status.enabled)}
        >
          <span />
        </button>
      </div>
      {!isOwner && <p className="muted">{t('settings.internet.ownerOnly')}</p>}
      {!status.enabled && isOwner && (
        <p className="muted">{t('settings.internet.intro')}</p>
      )}
      {error && <p className="error-text">{error}</p>}

      {status.enabled && (
        <ol className="checklist" aria-label={t('settings.internet.progress')}>
          {steps.map((step) => (
            <li key={step.id} className={`step ${step.state}`} data-step={step.id} data-state={step.state}>
              <StepIcon state={step.state} />
              <div>
                <span className="step-label">{step.label}</span>
                {step.detail && <span className="step-detail">{step.detail}</span>}
              </div>
            </li>
          ))}
        </ol>
      )}

      {status.enabled && status.cgnat && (
        <div className="internet-callout warn">
          <strong>{t('settings.internet.cgnatTitle')}</strong>
          <p>{t('settings.internet.cgnat')}</p>
          <a href={`${LINKS.hostingGuide}#on-a-linux-vps-with-systemd`} target="_blank" rel="noopener noreferrer">{t('settings.internet.vps')}</a>
        </div>
      )}

      {forwards.length > 0 && (
        <div className="internet-callout" data-testid="manual-forwards">
          <strong>{t('settings.internet.forwardTitle')}</strong>
          <p>
            {lan
              ? <Trans i18nKey="settings.internet.forwardLan" values={{ lan }} components={{ code: <code /> }} />
              : <Trans i18nKey="settings.internet.forward" components={{ code: <code /> }} />}
          </p>
          <table className="forward-table">
            <thead>
              <tr><th>{t('settings.internet.outside')}</th><th>{t('settings.internet.toPort')}</th><th>{t('settings.internet.type')}</th><th>{t('settings.internet.for')}</th></tr>
            </thead>
            <tbody>
              {forwards.map((f) => (
                <tr key={`${f.protocol}-${f.external}`}>
                  <td>{f.external}</td><td>{f.internal}</td><td>{f.protocol}</td><td>{f.purpose}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">{t('settings.internet.upnp')}</p>
        </div>
      )}

      {status.enabled && status.publicUrl?.startsWith('http://') && (
        <div className="internet-callout" role="alert">
          <strong>{t('settings.internet.noHttpsTitle')}</strong>
          <p>
            <Trans i18nKey="settings.internet.noHttps" values={{ url: status.publicUrl }} components={{ code: <code /> }} />
          </p>
        </div>
      )}
      {status.enabled && !status.publicUrl && status.address && status.https.state !== 'valid' && (
        <p className="internet-address muted">{t('settings.internet.waitingHttps')}</p>
      )}
      {status.enabled && status.publicUrl?.startsWith('https://') && (
        <p className="internet-address">
          <Trans i18nKey="settings.internet.joinAt" values={{ url: status.publicUrl }} components={{ code: <code /> }} />
          {status.autoAddress && <span className="muted"> {t('settings.internet.addressChanges')}</span>}
        </p>
      )}

      <div className="internet-actions">
        {status.enabled && isOwner && (
          <button className="button" disabled={busy} onClick={() => void change(true)}>
            {busy ? <Spinner /> : t('settings.internet.checkAgain')}
          </button>
        )}
        {status.lanUrl && <span className="muted"><Trans i18nKey="settings.internet.onNetwork" values={{ url: status.lanUrl }} components={{ code: <code /> }} /></span>}
      </div>
    </section>
  )
}
