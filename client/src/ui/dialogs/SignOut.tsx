// Settings → Devices → Sign out of this device. Warns hard when that would lose the account for good.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDevices } from '../../state/devices'
import { signOutThisDevice } from '../../state/signOut'
import { useApp } from '../../state/store'
import { Modal, Spinner } from '../bits'
import { RecoveryKeySection } from './RecoveryKey'

export function SignOutSection() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <div className="sign-out-row">
      <button className="button danger-outline" onClick={() => setOpen(true)}>{t('account.signOut.button')}</button>
      <p className="muted">{t('account.signOut.hint')}</p>
      {open && <SignOutDialog onClose={() => setOpen(false)} />}
    </div>
  )
}

function SignOutDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const others = useDevices((s) => s.devices.filter((d) => !d.current).length)
  const loaded = useDevices((s) => s.loaded)
  const saved = useApp((s) => !!s.profile?.recoverySaved)
  const ownsAll = useApp((s) => s.order.length > 0 && s.order.every((k) => s.servers[k]?.me?.role === 'owner'))
  const only = others === 0
  const danger = only && !saved
  // A throwaway account (the only device) should vanish from member lists; a real one stays.
  const [choice, setLeave] = useState<boolean | null>(null)
  const leave = choice ?? only
  const [understood, setUnderstood] = useState(false)
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)

  async function signOut() {
    setBusy(true)
    await signOutThisDevice({ leaveServers: leave })
  }

  return (
    <Modal title={t('account.signOut.title')} onClose={busy ? () => undefined : onClose}>
      <p>{t('account.signOut.intro')}</p>
      {!loaded ? <Spinner /> : danger ? (
        <div className="sign-out-danger" role="alert">
          <strong>{t('account.signOut.dangerTitle')}</strong>
          <p>{t('account.signOut.danger')}</p>
          {saving ? <RecoveryKeySection /> : (
            <div><button className="button primary" onClick={() => setSaving(true)}>{t('account.signOut.saveFirst')}</button></div>
          )}
          <label className="checkbox">
            <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
            {t('account.signOut.understand')}
          </label>
        </div>
      ) : (
        <p className="muted">{only ? t('account.signOut.onlyDevice') : t('account.signOut.otherDevices', { count: others })}</p>
      )}
      {!ownsAll && (
        <label className="checkbox sign-out-leave">
          <input type="checkbox" checked={leave} onChange={(e) => setLeave(e.target.checked)} />
          <span>
            {t('account.signOut.leave')}
            <small className="muted">{t('account.signOut.leaveHint')}</small>
          </span>
        </label>
      )}
      <div className="sign-out-actions">
        <button className="button danger" disabled={busy || (danger && !understood)} onClick={() => void signOut()}>
          {busy ? <><Spinner /> {t('account.signOut.busy')}</> : t('account.signOut.confirm')}
        </button>
        <button className="button" disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
      </div>
    </Modal>
  )
}
