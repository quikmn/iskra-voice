// "Claim a server": the address and claim code a new server shows on its console (DigitalOcean Marketplace droplet)
// → the server proves it holds that code → you see its name and key → join as owner.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { InviteLink } from '../../core/invite'
import { ClaimFailed, claimAddress, claimServer, normalizeCode, type ClaimError } from '../../state/claimServer'
import { acceptInvite } from '../../state/store'
import { Modal, Spinner } from '../bits'
import { InviteSummary } from './JoinDialog'
import './RentServerDialog.css'
import './ClaimServerDialog.css'

export function ClaimServerDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const [address, setAddress] = useState('')
  const [code, setCode] = useState('')
  const [touched, setTouched] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<ClaimError | null>(null)
  const [found, setFound] = useState<InviteLink | null>(null)
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => pending.current?.abort(), [])

  const url = claimAddress(address)
  const normal = normalizeCode(code)
  const badAddress = touched && address.trim() !== '' && !url
  const badCode = touched && code.trim() !== '' && !normal

  async function check() {
    setTouched(true)
    if (!url || !normal || checking) return
    setChecking(true)
    setError(null)
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    const timer = setTimeout(() => controller.abort(), 15_000)
    try {
      setFound(await claimServer(url, normal, { signal: controller.signal }))
    } catch (e) {
      if (controller.signal.aborted && pending.current !== controller) return // closed or replaced
      setError(e instanceof ClaimFailed ? e.reason : 'unreachable')
    } finally {
      clearTimeout(timer)
      if (pending.current === controller) setChecking(false)
    }
  }

  function join() {
    if (!found) return
    acceptInvite(found)
    onClose()
  }

  if (found) {
    return (
      <Modal title={t('claim.title')} onBack={() => setFound(null)} onClose={onClose} className="claim-server"
        footer={
          <>
            <button className="button" onClick={() => setFound(null)}>{t('claim.back')}</button>
            <button className="button primary" onClick={join} autoFocus>{t('claim.join')}</button>
          </>
        }
      >
        <p>{t('claim.found')}</p>
        <InviteSummary invite={found} />
      </Modal>
    )
  }

  return (
    <Modal title={t('claim.title')} onClose={onClose} className="claim-server"
      footer={
        <>
          <button className="button" onClick={onClose}>{t('common.cancel')}</button>
          <button className="button primary" disabled={checking || !url || !normal} onClick={() => void check()}>
            {checking ? t('claim.checking') : t('claim.check')}
          </button>
        </>
      }
    >
      <p className="muted">{t('claim.intro')}</p>
      <form onSubmit={(e) => { e.preventDefault(); void check() }}>
        <label className="field">
          <span>{t('claim.address')}</span>
          <input autoFocus value={address} inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={300}
            placeholder={t('claim.addressPlaceholder')} aria-invalid={badAddress || undefined}
            onChange={(e) => { setAddress(e.target.value); setError(null) }} onBlur={() => address && setTouched(true)} />
          <small className="muted">{t('claim.addressHint')}</small>
        </label>
        {badAddress && <p className="error-text">{t('claim.badAddress')}</p>}
        <label className="field">
          <span>{t('claim.code')}</span>
          <input value={code} autoCapitalize="characters" autoCorrect="off" autoComplete="one-time-code" spellCheck={false} maxLength={64}
            className="claim-code-input" placeholder={t('claim.codePlaceholder')} aria-invalid={badCode || undefined}
            onChange={(e) => { setCode(e.target.value); setError(null) }} />
          <small className="muted">{t('claim.codeHint')}</small>
        </label>
        {badCode && <p className="error-text">{t('claim.badCode')}</p>}
        {/* Enter submits; the footer button is the visible one. */}
        <button type="submit" hidden />
      </form>
      {checking && <p className="rent-progress" role="status"><Spinner /> {t('claim.checking')}</p>}
      {error && <p className="error-text" role="alert" data-testid="claim-error">{t(`claim.errors.${error}`)}</p>}
      <p className="muted small">{t('claim.note')}</p>
    </Modal>
  )
}
