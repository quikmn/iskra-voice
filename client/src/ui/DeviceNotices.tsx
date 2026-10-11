// Full-screen and modal notices about this device's place in the account.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { resetThisDevice } from '../state/devices'
import { usePendingLink } from '../state/link'
import { Modal } from './bits'

/** Another of your devices removed this one. */
export function RevokedScreen() {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <div className="brand">
          <span className="brand-mark">⚡</span> Iskra
        </div>
        <p className="lead">{t('app.devices.revokedLead')}</p>
        <p className="muted">{t('app.devices.revokedHint')}</p>
        <button className="button primary wide" disabled={busy} onClick={() => { setBusy(true); void resetThisDevice() }}>
          {t('app.devices.clear')}
        </button>
      </div>
    </div>
  )
}

/** A link code opened on a device that already has an account. */
export function AlreadySignedInNotice() {
  const { t } = useTranslation()
  const code = usePendingLink((s) => s.code)
  if (!code) return null
  const close = () => usePendingLink.setState({ code: null })
  return (
    <Modal title={t('app.devices.alreadySignedIn')} onClose={close}>
      <p>{t('app.devices.alreadySignedInBody')}</p>
      <button className="button primary" onClick={close}>{t('common.ok')}</button>
    </Modal>
  )
}
