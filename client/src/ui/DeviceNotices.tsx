// Full-screen and modal notices about this device's place in the account.
import { useState } from 'react'
import { resetThisDevice } from '../state/devices'
import { usePendingLink } from '../state/link'
import { Modal } from './bits'

/** Another of your devices removed this one. */
export function RevokedScreen() {
  const [busy, setBusy] = useState(false)
  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <div className="brand">
          <span className="brand-mark">⚡</span> Iskra
        </div>
        <p className="lead">This device was removed from your account, so it's signed out everywhere.</p>
        <p className="muted">
          If that was you, clear Iskra from this device. If it wasn't, use another of your devices to check your device list.
        </p>
        <button className="button primary wide" disabled={busy} onClick={() => { setBusy(true); void resetThisDevice() }}>
          Clear Iskra from this device
        </button>
      </div>
    </div>
  )
}

/** A link code opened on a device that already has an account. */
export function AlreadySignedInNotice() {
  const code = usePendingLink((s) => s.code)
  if (!code) return null
  const close = () => usePendingLink.setState({ code: null })
  return (
    <Modal title="Already signed in" onClose={close}>
      <p>This device already has an Iskra account. To link a new device, open the code on a phone, browser or computer where Iskra isn't set up yet.</p>
      <button className="button primary" onClick={close}>OK</button>
    </Modal>
  )
}
