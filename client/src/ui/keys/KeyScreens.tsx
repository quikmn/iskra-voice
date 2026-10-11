// Screens and notices about this device's keys: the app lock, a replaced account key, disputes for admins.
import { useState } from 'react'
import { fingerprint } from '../../core/connection'
import { encodeRecoveryKey, seedOf } from '../../core/recovery'
import { resetThisDevice } from '../../state/devices'
import { loadFriends, nameOf } from '../../state/dms'
import { claimAccountBack, resolveDispute, retryRetired, useKeys } from '../../state/keys'
import { unlock, useLock } from '../../state/lock'
import { activeServerState, boot, useApp } from '../../state/store'
import { roleRank } from '../../core/protocol'
import { Modal, Spinner } from '../bits'
import { KeyActions } from '../dialogs/RecoveryKey'
import './keys.css'

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">⚡</span> Iskra
    </div>
  )
}

/** Clearing the device, with one confirmation step. */
function ResetButton({ label = 'Clear Iskra from this device' }: { label?: string }) {
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!confirm) return <button className="button wide" onClick={() => setConfirm(true)}>{label}</button>
  return (
    <div className="key-confirm">
      <p className="warning-text">This deletes your account and messages from this device. You can come back with your recovery key or by linking from another device.</p>
      <div className="copy-row">
        <button className="button danger" disabled={busy} onClick={() => { setBusy(true); void resetThisDevice() }}>Clear this device</button>
        <button className="button" onClick={() => setConfirm(false)}>Cancel</button>
      </div>
    </div>
  )
}

/** Startup: the app lock passphrase, or the keychain didn't cooperate. */
export function LockScreen() {
  const status = useLock((s) => s.status)
  const message = useLock((s) => s.message)
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [wrong, setWrong] = useState(false)

  async function submit() {
    if (!passphrase || busy) return
    setBusy(true)
    setWrong(false)
    const ok = await unlock(passphrase)
    if (!ok) {
      setBusy(false)
      setWrong(true)
      return
    }
    await boot()
    await loadFriends()
  }

  if (status === 'error') {
    return (
      <div className="onboarding">
        <div className="onboarding-card">
          <Brand />
          <p className="lead">Iskra can't open its keys</p>
          <p className="muted">{message}</p>
          <button className="button primary wide" onClick={() => window.location.reload()}>Try again</button>
          <ResetButton />
        </div>
      </div>
    )
  }

  return (
    <div className="onboarding">
      <form className="onboarding-card" onSubmit={(e) => { e.preventDefault(); void submit() }}>
        <Brand />
        <p className="lead">Iskra is locked</p>
        <label className="field">
          <span>App lock passphrase</span>
          <input type="password" autoComplete="current-password" autoFocus value={passphrase} aria-invalid={wrong}
            onChange={(e) => { setPassphrase(e.target.value); setWrong(false) }} />
        </label>
        {wrong && <p className="error-text" role="alert">That passphrase isn't right.</p>}
        <button type="submit" className="button primary wide" disabled={!passphrase || busy}>
          {busy ? <><Spinner /> Unlocking…</> : 'Unlock'}
        </button>
        <details className="key-help">
          <summary>Forgot it?</summary>
          <p className="muted">
            The passphrase can't be recovered: it's what encrypts your keys on this device. Clear Iskra from this device, then sign in again
            with your recovery key or by linking from another of your devices.
          </p>
          <ResetButton />
        </details>
      </form>
    </div>
  )
}

/** This device's account key was replaced and it wasn't handed the new one. */
export function RetiredScreen() {
  const [claiming, setClaiming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <Brand />
        <p className="lead">Your account key was replaced</p>
        <p className="muted">
          Your account was moved to a new key, by another of your devices or by someone who has your recovery key. This device wasn't given the
          new key, so it can't sign in with the old one.
        </p>
        <p className="muted">
          <strong>If that was you</strong> on another device, clear this device and link it again from there (Settings → Devices → Link a
          device).
        </p>
        <button className="button wide" onClick={retryRetired}>Try again</button>
        {claiming ? (
          <div className="key-confirm">
            <p>
              Your servers will be asked to move your account to a new key from this device. Where someone else already took it, the server's
              admins decide who's really you, so tell them. You'll get a new recovery key.
            </p>
            {error && <p className="error-text">{error}</p>}
            <div className="copy-row">
              <button className="button danger" disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  try { await claimAccountBack() } catch (e) { setError((e as Error).message); setBusy(false) }
                }}>
                Take my account back
              </button>
              <button className="button" onClick={() => setClaiming(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <button className="button danger-outline wide" onClick={() => setClaiming(true)}>That wasn't me</button>
        )}
        <ResetButton />
      </div>
    </div>
  )
}

/** After this device moved to a new account key: the new recovery key, right away. */
export function NewKeyDialog() {
  const moved = useKeys((s) => s.moved)
  const identity = useApp((s) => s.identity)
  if (!moved || !identity) return null
  const recoveryKey = encodeRecoveryKey(seedOf(identity))
  const close = () => useKeys.setState({ moved: null })
  return (
    <Modal title="Your account has a new key" onClose={close}>
      <p className="muted">
        {moved === 'here'
          ? 'Your servers moved your account, roles and messages to the new key. Friends will see that your safety number changed.'
          : 'Your account key was replaced on another of your devices, and this device now has the new key.'}{' '}
        Your old recovery key no longer works. Save the new one:
      </p>
      <div className="recovery-key" data-testid="new-recovery-key">{recoveryKey}</div>
      <KeyActions recoveryKey={recoveryKey} />
      <p className="warning-text">Anyone with this key can use your account. Never share it.</p>
      <button className="button primary" onClick={close}>Done</button>
    </Modal>
  )
}

/** Admins of the server you're looking at: someone's old key was claimed twice. */
export function DisputeNotices() {
  const server = useApp(activeServerState)
  const disputes = useKeys((s) => s.disputes)
  const [busy, setBusy] = useState<string | null>(null)
  if (!server?.me || roleRank(server.me.role) < roleRank('admin')) return null
  const here = Object.values(disputes).flat().filter((d) => d.serverKey === server.key && d.rotation.contest && d.rotation.newKey !== server.me!.accountKey)
  if (here.length === 0) return null
  return (
    <>
      {here.map(({ rotation }) => {
        const name = nameOf(rotation.newKey)
        const decide = async (keep: string) => {
          setBusy(rotation.oldKey)
          await resolveDispute(server.key, rotation.oldKey, keep).catch(() => undefined)
          setBusy(null)
        }
        return (
          <div className="nudge key-dispute" role="status" key={rotation.oldKey}>
            <p>
              <strong>{name}'s account is disputed.</strong> Two different keys claimed it, so one of them may be someone with a stolen key. Ask{' '}
              {name} in person or on a call which key is theirs (Settings → Recovery key shows it), then keep that one.
            </p>
            <div className="copy-row">
              <button className="button small" disabled={busy === rotation.oldKey} onClick={() => void decide(rotation.newKey)}>
                Keep {fingerprint(rotation.newKey)}
              </button>
              <button className="button small" disabled={busy === rotation.oldKey} onClick={() => void decide(rotation.contest!.newKey)}>
                Give it to {fingerprint(rotation.contest!.newKey)}
              </button>
            </div>
          </div>
        )
      })}
    </>
  )
}
