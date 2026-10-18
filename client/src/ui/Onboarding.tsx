import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { decodeRecoveryKey } from '../core/recovery'
import { usePendingLink } from '../state/link'
import { acceptInvite, completeOnboarding, restoreAccount, useApp } from '../state/store'
import { hostOf } from './format'
import { useServerInfo } from '../state/serverName'
import { InviteIcon } from './dialogs/JoinDialog'
import { OpenInApp } from './OpenInApp'
import { LinkJoin } from './LinkJoin'
import { acceptTerms, needsAcceptance, useTerms, useTermsAccepted } from '../state/terms'
import { takeDeletedNotice } from '../state/accountDeletion'
import { TermsAgreement, TermsFirst } from './safety/Terms'
import { addingMode, inHost } from '../state/accounts'

// First the choice: new here, or already on another device (so people link instead of making a second account).
type Mode = 'choose' | 'new' | 'existing' | 'recovery' | 'link'

export function Onboarding() {
  const { t } = useTranslation()
  const pendingInvite = useApp((s) => s.pendingInvite)
  const serverInfo = useServerInfo(pendingInvite?.serverUrl)
  const serverName = serverInfo === undefined ? undefined : serverInfo?.name ?? null
  const pendingLink = usePendingLink((s) => s.code)
  // An account being added from the switcher opens on the choice made there (once the terms are agreed on this device).
  const [mode, setMode] = useState<Mode>(() => {
    if (pendingLink) return 'link'
    const adding = addingMode()
    if (!adding || needsAcceptance(useTerms.getState().accepted)) return 'choose'
    return adding === 'new' ? 'new' : 'existing'
  })
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [recoveryKey, setRecoveryKey] = useState('')
  const restoring = mode === 'recovery'
  const trimmed = name.trim()
  const seed = restoring ? decodeRecoveryKey(recoveryKey) : null
  const keyProblem = restoring && recoveryKey.trim().length > 20 && !seed
  // The terms are agreed on the first screen, whichever way people go from there.
  const accepted = useTermsAccepted()
  const [agreed, setAgreed] = useState(false)
  const [deleted] = useState(takeDeletedNotice)
  const pick = (next: Mode) => () => {
    if (!accepted) acceptTerms()
    setMode(next)
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy || (restoring ? !seed : !trimmed)) return
    setBusy(true)
    // A restored account keeps its name: it comes from the account's servers, not from here.
    if (restoring && seed) await restoreAccount(seed)
    else await completeOnboarding(trimmed)
    if (pendingInvite) acceptInvite(pendingInvite)
  }

  const brand = (
    <div className="brand" role="heading" aria-level={1}>
      <span className="brand-mark" aria-hidden>⚡</span> Iskra
    </div>
  )

  if (mode === 'link') {
    return (
      <div className="onboarding">
        <div className="onboarding-card">
          {brand}
          <TermsFirst>
            {/* Next to other accounts, a link from outside never links by itself: the person presses "Link this device". */}
            <LinkJoin initialCode={pendingLink} autoStart={!inHost} onBack={() => { usePendingLink.setState({ code: null }); setMode('existing') }} />
          </TermsFirst>
        </div>
      </div>
    )
  }

  // The server's own name; its address only if it doesn't answer (never the address first, then the name).
  const invitedLine = pendingInvite && (serverName
    ? <Trans i18nKey="app.onboarding.invitedTo" values={{ server: serverName }} components={{ b: <strong /> }} />
    : serverName === undefined
      ? t('app.onboarding.invitedAsking')
      : <Trans i18nKey="app.onboarding.invited" values={{ host: hostOf(pendingInvite.serverUrl) }} components={{ b: <strong /> }} />)

  const invited = pendingInvite && (
    <>
      {serverName && serverInfo?.icon && <InviteIcon src={serverInfo.icon} name={serverName} />}
      <p className="lead">
        {invitedLine}
      </p>
      <OpenInApp invite={pendingInvite} />
    </>
  )

  if (mode === 'choose') {
    return (
      <div className="onboarding">
        <div className="onboarding-card">
          {brand}
          {deleted && <p className="account-deleted-note" role="status">{t('safety.deleteAccount.doneNotice')}</p>}
          {invited || <p className="lead">{t('account.welcome.lead')}</p>}
          {!accepted && <TermsAgreement agreed={agreed} onChange={setAgreed} />}
          <p className="onboarding-question">{t('account.welcome.question')}</p>
          {/* Right above the greyed-out choices, so it shows on a phone too. */}
          {!accepted && !agreed && <p className="terms-hint" id="terms-hint">{t('safety.terms.tickFirst')}</p>}
          <div className="choice-list equal">
            <button type="button" className="choice" disabled={!accepted && !agreed} aria-describedby={!accepted && !agreed ? 'terms-hint' : undefined} onClick={pick('new')}>
              <strong>{t('account.welcome.new')}</strong>
              <span className="muted">{t('account.welcome.newHint')}</span>
            </button>
            <button type="button" className="choice" disabled={!accepted && !agreed} aria-describedby={!accepted && !agreed ? 'terms-hint' : undefined} onClick={pick('existing')}>
              <strong>{t('account.welcome.existing')}</strong>
              <span className="muted">{t('account.welcome.existingHint')}</span>
            </button>
          </div>
          {pendingInvite && <p className="onboarding-note muted">{t('account.welcome.invitedTwice')}</p>}
        </div>
      </div>
    )
  }

  if (mode === 'existing') {
    return (
      <div className="onboarding">
        <div className="onboarding-card">
          {brand}
          <p className="lead">{t('app.onboarding.welcomeBack')}</p>
          <div className="choice-list">
            <button type="button" className="choice" onClick={() => setMode('link')}>
              <strong>{t('app.onboarding.linkDevice')}</strong>
              <span className="muted">{t('app.onboarding.linkDeviceHint')}</span>
            </button>
            <button type="button" className="choice" onClick={() => setMode('recovery')}>
              <strong>{t('app.onboarding.useRecoveryKey')}</strong>
              <span className="muted">{t('app.onboarding.useRecoveryKeyHint')}</span>
            </button>
          </div>
          <p className="fine-print">
            <button type="button" className="link" onClick={() => setMode('choose')}>{t('account.welcome.back')}</button>
            {' · '}
            <button type="button" className="link" onClick={() => setMode('new')}>{t('app.onboarding.imNew')}</button>
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="onboarding">
      <form className="onboarding-card" onSubmit={submit}>
        {brand}
        {pendingInvite ? (
          <>
            <p className="lead">
              {invitedLine}
              <br />
              {restoring ? t('app.onboarding.restoreIntro') : t('app.onboarding.pickNameInvited')}
            </p>
            <OpenInApp invite={pendingInvite} />
          </>
        ) : (
          <p className="lead">{restoring ? t('app.onboarding.restoreIntro') : t('app.onboarding.intro')}</p>
        )}
        {restoring && (
          <label className="field">
            <span>{t('app.onboarding.recoveryKey')}</span>
            <textarea
              autoFocus
              rows={3}
              value={recoveryKey}
              onChange={(e) => setRecoveryKey(e.target.value)}
              placeholder="ISKRA-XXXX-XXXX-…"
              spellCheck={false}
              autoComplete="off"
            />
            {keyProblem && <small className="error-text">{t('app.onboarding.keyProblem')}</small>}
            {seed && <small className="success-text">{t('app.onboarding.keyOk')}</small>}
          </label>
        )}
        {!restoring && <label className="field">
          <span>{t('app.onboarding.yourName')}</span>
          <input
            autoFocus
            maxLength={32}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('app.onboarding.namePlaceholder')}
          />
        </label>}
        <button className="button primary wide" disabled={busy || (restoring ? !seed : !trimmed)}>
          {restoring ? t('app.onboarding.restore') : pendingInvite ? t('common.join') : t('common.continue')}
        </button>
        <p className="fine-print">
          {restoring ? (
            <button type="button" className="link" onClick={() => setMode('existing')}>{t('common.back')}</button>
          ) : (
            <>
              {t('app.onboarding.noPassword')}{' '}
              <button type="button" className="link" onClick={() => setMode('choose')}>{t('account.welcome.back')}</button>
            </>
          )}
        </p>
      </form>
    </div>
  )
}
