import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { decodeRecoveryKey } from '../core/recovery'
import { usePendingLink } from '../state/link'
import { acceptInvite, completeOnboarding, restoreAccount, useApp } from '../state/store'
import { hostOf } from './format'
import { OpenInApp } from './OpenInApp'
import { LinkJoin } from './LinkJoin'
import { acceptTerms, useTermsAccepted } from '../state/terms'
import { takeDeletedNotice } from '../state/accountDeletion'
import { TermsAgreement, TermsFirst } from './safety/Terms'

// First the choice: new here, or already on another device (so people link instead of making a second account).
type Mode = 'choose' | 'new' | 'existing' | 'recovery' | 'link'

export function Onboarding() {
  const { t } = useTranslation()
  const pendingInvite = useApp((s) => s.pendingInvite)
  const pendingLink = usePendingLink((s) => s.code)
  const [mode, setMode] = useState<Mode>(pendingLink ? 'link' : 'choose')
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
    if (!trimmed || busy || (restoring && !seed)) return
    setBusy(true)
    if (restoring && seed) await restoreAccount(seed, trimmed)
    else await completeOnboarding(trimmed)
    if (pendingInvite) acceptInvite(pendingInvite)
  }

  const brand = (
    <div className="brand">
      <span className="brand-mark">⚡</span> Iskra
    </div>
  )

  if (mode === 'link') {
    return (
      <div className="onboarding">
        <div className="onboarding-card">
          {brand}
          <TermsFirst>
            <LinkJoin initialCode={pendingLink} onBack={() => { usePendingLink.setState({ code: null }); setMode('existing') }} />
          </TermsFirst>
        </div>
      </div>
    )
  }

  const invited = pendingInvite && (
    <>
      <p className="lead">
        <Trans i18nKey="app.onboarding.invited" values={{ host: hostOf(pendingInvite.serverUrl) }} components={{ b: <strong /> }} />
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
          <div className="choice-list equal">
            <button type="button" className="choice" disabled={!accepted && !agreed} onClick={pick('new')}>
              <strong>{t('account.welcome.new')}</strong>
              <span className="muted">{t('account.welcome.newHint')}</span>
            </button>
            <button type="button" className="choice" disabled={!accepted && !agreed} onClick={pick('existing')}>
              <strong>{t('account.welcome.existing')}</strong>
              <span className="muted">{t('account.welcome.existingHint')}</span>
            </button>
          </div>
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
              <Trans i18nKey="app.onboarding.invited" values={{ host: hostOf(pendingInvite.serverUrl) }} components={{ b: <strong /> }} />
              <br />
              {t('app.onboarding.pickNameInvited')}
            </p>
            <OpenInApp invite={pendingInvite} />
          </>
        ) : (
          <p className="lead">{t('app.onboarding.intro')}</p>
        )}
        {restoring && (
          <label className="field">
            <span>{t('app.onboarding.recoveryKey')}</span>
            <textarea
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
        <label className="field">
          <span>{t('app.onboarding.yourName')}</span>
          <input
            autoFocus
            maxLength={32}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('app.onboarding.namePlaceholder')}
          />
        </label>
        <button className="button primary wide" disabled={!trimmed || busy || (restoring && !seed)}>
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
