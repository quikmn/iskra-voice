// The Terms of Use and Community guidelines: a short summary with links to the full texts on iskra.foo.
// Agreed on first run (both "I'm new" and "I already use Iskra") and again when TERMS_VERSION changes.
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { acceptTerms, LEGAL_LINKS, useTermsAccepted } from '../../state/terms'
import { useApp } from '../../state/store'
import { useFocusTrap } from '../layers'
import './safety.css'

/** The points people agree to, in a few lines. */
export function TermsSummary() {
  const { t } = useTranslation()
  return (
    <div className="terms-summary">
      <ul>
        <li>{t('safety.terms.pointTool')}</li>
        <li>{t('safety.terms.pointZero')}</li>
        <li>{t('safety.terms.pointReport')}</li>
        <li>{t('safety.terms.pointAge')}</li>
      </ul>
      <p className="terms-links">
        <a href={LEGAL_LINKS.terms} target="_blank" rel="noreferrer">{t('safety.links.terms')}</a>
        {' · '}
        <a href={LEGAL_LINKS.privacy} target="_blank" rel="noreferrer">{t('safety.links.privacy')}</a>
      </p>
    </div>
  )
}

/** On the first-run screen: the summary and a checkbox. The choices below stay off until it's ticked. */
export function TermsAgreement({ agreed, onChange }: { agreed: boolean; onChange: (agreed: boolean) => void }) {
  const { t } = useTranslation()
  return (
    <div className="terms-agreement">
      <strong>{t('safety.terms.beforeYouStart')}</strong>
      <TermsSummary />
      <label className="checkbox">
        <input type="checkbox" checked={agreed} onChange={(e) => onChange(e.target.checked)} />
        <span>{t('safety.terms.agree')}</span>
      </label>
    </div>
  )
}

/** First run reached through a device-link QR code: agree, then link. */
export function TermsFirst({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  const accepted = useTermsAccepted()
  const [agreed, setAgreed] = useState(false)
  if (accepted) return <>{children}</>
  return (
    <div className="terms-first">
      <TermsAgreement agreed={agreed} onChange={setAgreed} />
      <button className="button primary wide" disabled={!agreed} onClick={() => acceptTerms()}>{t('common.continue')}</button>
    </div>
  )
}

/** The terms changed since this device agreed (or it never did, from before they existed): agree to keep going. */
export function TermsUpdateDialog() {
  const accepted = useTermsAccepted()
  const ready = useApp((s) => s.phase === 'ready')
  if (accepted || !ready) return null
  return <TermsUpdateModal />
}

function TermsUpdateModal() {
  const { t } = useTranslation()
  const [agreed, setAgreed] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useFocusTrap(ref)
  return (
    <div className="modal-backdrop terms-update-backdrop">
      <div className="modal terms-update" role="dialog" aria-modal="true" aria-label={t('safety.terms.updatedTitle')} ref={ref} tabIndex={-1}>
        <header className="modal-header"><h2>{t('safety.terms.updatedTitle')}</h2></header>
        <div className="modal-body">
          <p>{t('safety.terms.updatedLead')}</p>
          <TermsAgreement agreed={agreed} onChange={setAgreed} />
          <button className="button primary wide" disabled={!agreed} onClick={() => acceptTerms()}>{t('common.continue')}</button>
        </div>
      </div>
    </div>
  )
}
