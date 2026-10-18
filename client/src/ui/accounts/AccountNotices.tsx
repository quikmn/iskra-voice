// What one account's page shows about the others signed in on this device: a short note (left voice as another
// account), a call ringing for another account, and an account added twice. Plus "Cancel" while one is being added.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { accountName, addingMode, cancelAdding, dismissAccountToast, inHost, switchAccount, thisSlot, useAccounts } from '../../state/accounts'
import { signOutThisDevice } from '../../state/signOut'
import { Modal, Spinner } from '../bits'
import { Close } from '../icons'
import '../update-toast.css'
import './accounts.css'

export function AccountNotices() {
  const { t } = useTranslation()
  const toast = useAccounts((s) => s.toast)
  const accounts = useAccounts((s) => s.accounts)
  const me = accounts.find((a) => a.slot === thisSlot)
  const ringing = accounts.filter((a) => a.slot !== thisSlot && a.ringing)
  return (
    <>
      {(toast || ringing.length > 0) && (
        <div className="account-toasts">
          {ringing.map((a) => (
            <div key={a.slot} className="update-toast account-toast ringing" role="status" data-testid="account-ringing">
              <div className="update-toast-text">
                <strong>{t('accounts.ringing.title', { caller: a.ringing ?? '', account: accountName(a) })}</strong>
              </div>
              <button className="button primary" onClick={() => switchAccount(a.slot)}>{t('accounts.ringing.switch')}</button>
            </div>
          ))}
          {toast && (
            <div className="update-toast account-toast" role="status" data-testid="account-toast">
              <div className="update-toast-text"><span>{toast}</span></div>
              <button className="icon-button small" onClick={dismissAccountToast} aria-label={t('app.dismiss')}><Close size={14} /></button>
            </div>
          )}
        </div>
      )}
      {me?.duplicateOf != null && <DuplicateDialog first={me.duplicateOf} />}
    </>
  )
}

/** This account is already signed in here in another slot: go there, and this copy signs out (it's a spare device). */
function DuplicateDialog({ first }: { first: number }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true)
    switchAccount(first)
    await signOutThisDevice({ leaveServers: false })
  }
  return (
    <Modal title={t('accounts.duplicate.title')} onClose={() => undefined}>
      <p>{t('accounts.duplicate.body')}</p>
      <div className="sign-out-actions">
        <button className="button primary" disabled={busy} onClick={() => void go()}>{busy ? <Spinner /> : t('accounts.duplicate.switch')}</button>
      </div>
    </Modal>
  )
}

/** While an account is being added (its first-run or lock screen): the way back to the others. */
export function AddingBar() {
  const { t } = useTranslation()
  const others = useAccounts((s) => s.accounts.some((a) => a.slot !== thisSlot && a.ready))
  if (!inHost || !addingMode() || !others) return null
  return (
    <div className="account-adding-bar" role="region" aria-label={t('accounts.switcher.add')}>
      <span>{t('accounts.switcher.add')}</span>
      <button className="button small" onClick={cancelAdding}>{t('accounts.adding.cancelPlain')}</button>
    </div>
  )
}
