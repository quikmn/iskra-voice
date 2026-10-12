import { useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { errorMessage } from '../../i18n/errors'
import { hostChecklist, hostedHere, hostSummary, loadHostStatus, manualForwards, setInternet, tailscaleServerUrl, useHostedHere, useHosting, type Step } from '../../state/hosting'
import { InviteDialog } from './InviteDialog'
import { CgnatHelp, Findings, ForwardHelp } from './ReachabilityHelp'
import { KeepRunning } from './CreateServerDialog'
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
  const here = useHostedHere((s) => hostedHere(server, s.byUrl))
  const byUrl = useHostedHere((s) => s.byUrl)
  const [tailscaleOpen, setTailscaleOpen] = useState(false)

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
        <h2>{t('settings.sections.internet')}</h2>
        {error ? <p className="error-text">{error}</p> : <Spinner />}
      </section>
    )
  }

  const tailscaleUrl = tailscaleServerUrl(server, byUrl, status)
  const summary = hostSummary(status)
  const steps = hostChecklist(status)
  const forwards = status.enabled && !status.cgnat ? manualForwards(status) : []

  return (
    <section className="settings-section internet" data-testid="internet-section">
      <h2>{t('settings.sections.internet')}</h2>
      <div className="internet-head">
        <div>
          <strong>{t('settings.internet.letFriends')}</strong>
          <p className={`internet-summary ${summary.tone}`}>{summary.text}</p>
        </div>
        <button
          className={`switch ${status.enabled ? 'on' : ''}`}
          role="switch"
          aria-checked={status.enabled}
          aria-label={t('settings.internetSwitch')}
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
      {isOwner && <p className="muted small-print" data-testid="internet-third-parties">{t('settings.internet.thirdParties')}</p>}
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

      {status.enabled && status.router.state !== 'off' && <Findings status={status} />}
      {status.enabled && !status.cgnat && status.nat !== 'cgnat' && (forwards.length > 0 || status.nat === 'private') && (
        <ForwardHelp status={status} startOpen={forwards.length > 0} />
      )}
      {status.enabled && <CgnatHelp status={status} server={server} />}

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

      {tailscaleUrl && (
        <p className="internet-tailscale" data-testid="internet-tailscale">
          <Trans i18nKey="hosting.tailscale.found" values={{ url: tailscaleUrl }} components={{ code: <code /> }} />{' '}
          <button className="link" onClick={() => setTailscaleOpen(true)}>{t('hosting.tailscale.invite')}</button>
        </p>
      )}
      {tailscaleOpen && <InviteDialog server={server} via="tailscale" onClose={() => setTailscaleOpen(false)} />}

      {here && isOwner && (
        <div className="internet-here">
          <strong>{t('hosting.keepRunning.title')}</strong>
          <KeepRunning server={here} />
        </div>
      )}
    </section>
  )
}
